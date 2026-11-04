/**
 * E2E: Move folder runs as a daemon job (src-daemon/src/folder_move_job.rs),
 * driven from the sidebar's folder menu (MoveFolderDialog) and reported by
 * `folder-move-progress` (FolderMoveProgress).
 *
 * ── Fixtures ────────────────────────────────────────────────────────────────
 * The mock servers live for the whole connected-ci run and later specs read
 * luke's folder tree and count through vader's LIST, so every folder here is
 * this spec's own (disjoint names, Message-IDs and subjects) and `after()`
 * deletes all of them, deepest first: the mock answers [HASCHILDREN] to a
 * parent deleted before its children.
 *
 * ── What drives what ────────────────────────────────────────────────────────
 * (a) is the real UI end to end: right-click, Move folder…, another account,
 *     a folder there, Move folder. The picked folder becomes the PARENT, so
 *     luke's `MoveE2E` lands as vader's `Archive/MoveE2E`, and the original
 *     goes to luke's Trash once every message is confirmed.
 * (b) needs a cancel inside one run's copy, a window no WebDriver round trip
 *     hits reliably, so the start and the cancel are one in-page script: the
 *     cancel goes out on the event that says some messages are copied, so it
 *     lands mid-folder, and the destination holds exactly what was copied.
 * (c) a move inside one account to the top level is one native RENAME:
 *     nothing copied, nothing in Trash.
 *
 * While a job runs this spec reads only the in-page event array: the job
 * waits for foreground quiet before each message, and polling the daemon or
 * switching folders would be foreground work that slows it.
 */

import { ImapFlow } from 'imapflow';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { switchToFolder, waitForApp, waitForEmails } from './helpers.js';
import { setPremium } from './mockBilling.js';
import { appDataDir, MOCK_PASSWORD } from './mockImap.js';

const LUKE = 'luke@mock.test';
const VADER = 'vader@mock.test';
const LUKE_SERVER = 0;
const VADER_SERVER = 1; // MOCK_ACCOUNTS order: luke, vader, yoda

// (a)
const MOVE_ROOT = 'MoveE2E';
const MOVE_SUB = `${MOVE_ROOT}/Sub`;
const MOVE_ROOT_COUNT = 5;
const MOVE_SUB_COUNT = 2;
// (b)
const CANCEL_FOLDER = 'MoveCancelE2E';
const CANCEL_COUNT = 40;
const CANCEL_AFTER = 3; // copied before the cancel goes out
// (c)
const RENAME_HOST = 'MoveHostE2E';
const RENAME_LEAF = 'MoveRenameE2E';
const RENAME_SOURCE = `${RENAME_HOST}/${RENAME_LEAF}`;
const RENAME_COUNT = 3;

// Every path this spec can leave on either server, the Trash copies with a
// collision suffix included.
const FAMILIES = [MOVE_ROOT, CANCEL_FOLDER, RENAME_HOST, RENAME_LEAF];
const ours = (path) => FAMILIES.some((f) => [path, path.replace(/^(Trash|Archive)\//, '')].some((p) => p === f || p.startsWith(`${f}/`) || p.startsWith(`${f} (`)));

const accountId = (email) => {
  const id = (browser.mockAccounts || []).find((a) => a.email === email)?.id;
  if (!id) throw new Error(`no mock account ${email}`);
  return id;
};

// ── Raw bridges ──────────────────────────────────────────────────────────

// `__error`, not `error`: webdriverio reads a returned `error` key as a failed
// protocol response (connected-daemon-channel.test.js's trap).
const daemonRpc = (method, params) => browser.executeAsync((m, p, done) => {
  try {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((v) => done({ ok: true, v }), (e) => done({ ok: false, __error: String((e && e.message) || e) }));
  } catch (e) {
    done({ ok: false, __error: String((e && e.message) || e) });
  }
}, method, params);

async function installMoveCapture() {
  const ok = await browser.executeAsync((done) => {
    window.__FOLDER_MOVE_EVENTS__ = [];
    window.__TAURI__.event.listen('folder-move-progress', (e) => window.__FOLDER_MOVE_EVENTS__.push(e.payload))
      .then(() => done(true), () => done(false));
  });
  expect(ok).toBe(true);
}
const moveEvents = () => browser.execute(() => window.__FOLDER_MOVE_EVENTS__ || []);

/** The last event of a run (`active: false`) that `match` accepts. */
async function finalEvent(match, what, timeout = 120_000) {
  let last = null;
  await browser.waitUntil(async () => {
    last = (await moveEvents()).filter(match).find((p) => p.active === false) || null;
    return !!last;
  }, { timeout, interval: 300, timeoutMsg: `${what}: folder-move-progress never sent its last event` });
  return last;
}

// ── IMAP, behind the app's back (ImapFlow) ──────────────────────────────────

async function withServer(serverIndex, email, fn) {
  const { host, port } = browser.mockImap[serverIndex];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: email, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// `pad` grows the body: (b)'s copy has to last long enough to be cancelled.
const rfc822 = (subject, i, pad = 0) => Buffer.from([
  'From: Folder Move Fixture <fixture@mock.test>',
  `To: ${LUKE}`,
  `Subject: ${subject}`,
  `Date: ${new Date(Date.now() - i * 1000).toUTCString()}`,
  `Message-ID: <${slug(subject)}@folder-move.mock.test>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `${subject} - body`,
  ...Array.from({ length: pad }, (_, n) => `padding line ${n} ${'x'.repeat(60)}`),
  '',
].join('\r\n'));

/** Create `folder` on luke (idempotent) and APPEND `count` messages `${folder} N`. */
async function seedFolder(folder, count, pad = 0) {
  await withServer(LUKE_SERVER, LUKE, async (client) => {
    try { await client.mailboxCreate(folder); } catch { /* already there */ }
    for (let i = 1; i <= count; i++) await client.append(folder, rfc822(`${folder} ${i}`, i, pad), [], new Date());
  });
}

const listPaths = (serverIndex, email) => withServer(serverIndex, email, async (client) => (await client.list()).map((m) => m.path));

async function messageCount(serverIndex, email, folder) {
  return withServer(serverIndex, email, async (client) => {
    const status = await client.status(folder, { messages: true }).catch(() => null);
    return status?.messages ?? 0;
  });
}

/** Message-IDs of `folder`, one per message (duplicates kept). */
async function messageIds(serverIndex, email, folder) {
  return withServer(serverIndex, email, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const ids = [];
      for await (const m of client.fetch('1:*', { envelope: true })) ids.push(m.envelope?.messageId || '');
      return ids;
    } finally {
      lock.release();
    }
  });
}

/** Delete every folder of this spec on a server, deepest first; say what stays. */
async function cleanServer(serverIndex, email) {
  try {
    await withServer(serverIndex, email, async (client) => {
      const paths = (await client.list()).map((m) => m.path).filter(ours);
      paths.sort((a, b) => b.split('/').length - a.split('/').length);
      for (const p of paths) {
        try { await client.mailboxDelete(p); } catch (e) { console.warn(`[connected-folder-move] ${email}: could not delete "${p}": ${e.message}`); }
      }
    });
    const left = (await listPaths(serverIndex, email)).filter(ours);
    if (left.length) console.warn(`[connected-folder-move] ${email} still has: ${JSON.stringify(left)}`);
  } catch (e) {
    console.warn(`[connected-folder-move] ${email}: cleanup failed: ${e.message}`);
  }
}

// ── The sidebar ─────────────────────────────────────────────────────────────

/** A visible sidebar row for exactly `path` (FolderRow, FolderChip and the
 *  folder search results all carry `folder-row`). */
const visibleRow = (path) => browser.execute((p) =>
  [...document.querySelectorAll(`[data-testid="folder-row"][data-path="${CSS.escape(p)}"]`)].some((r) => r.offsetHeight > 0), path);

/** Every path in the open account's folder list, as the store holds it. */
const storePaths = () => browser.execute(() => {
  const out = [];
  const walk = (list) => (list || []).forEach((m) => { out.push(m.path); walk(m.children); });
  walk(window.__MAIL_STORE__?.getState?.().mailboxes);
  return out;
});

/** The folder list is cached for ten minutes: ask for the app's own refresh of
 *  the open view (it refetches the folder list) until the row is drawn. */
async function showInSidebar(path) {
  for (let attempt = 0; attempt < 3 && !(await visibleRow(path)); attempt++) {
    // The store's action is throttled and returns nothing: a fire, then the wait below.
    await browser.execute(() => { window.__MAIL_STORE__.getState().refreshCurrentView(); });
    try {
      await browser.waitUntil(() => visibleRow(path), { timeout: 10_000, interval: 300 });
    } catch { /* ask again */ }
  }
  expect(await visibleRow(path)).toBe(true);
}

describe('Move folder through the daemon', function () {
  this.timeout(300_000);

  const started = new Set(); // job ids, discarded in after()

  before(async function () {
    await waitForApp();
    await waitForEmails();
    for (const email of [LUKE, VADER]) await cleanServer(email === LUKE ? LUKE_SERVER : VADER_SERVER, email);

    await seedFolder(MOVE_ROOT, MOVE_ROOT_COUNT);
    await seedFolder(MOVE_SUB, MOVE_SUB_COUNT);
    await seedFolder(CANCEL_FOLDER, CANCEL_COUNT, 3000);
    await withServer(LUKE_SERVER, LUKE, (client) => client.mailboxCreate(RENAME_HOST).catch(() => {}));
    await seedFolder(RENAME_SOURCE, RENAME_COUNT);

    await setPremium(true);
    await installMoveCapture();
    await switchToFolder(LUKE, 'INBOX');
    await showInSidebar(MOVE_ROOT);
  });

  after(async function () {
    for (const p of await moveEvents().catch(() => [])) if (p?.jobId) started.add(p.jobId);
    for (const jobId of started) await daemonRpc('folder_move.discard', { jobId }).catch(() => {});
    await cleanServer(LUKE_SERVER, LUKE);
    await cleanServer(VADER_SERVER, VADER);
  });

  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    try {
      const diag = await browser.execute(() => ({
        events: (window.__FOLDER_MOVE_EVENTS__ || []).slice(-6),
        dialog: document.getElementById('move-folder-account')?.closest('[role="dialog"]')?.innerText?.slice(0, 600) || null,
        chip: document.querySelector('[data-testid="folder-move-chip"]')?.innerText?.slice(0, 400) || null,
      }));
      console.log(`[connected-folder-move] diagnostic for "${this.currentTest.title}":`, JSON.stringify(diag));
    } catch (e) {
      console.log('[connected-folder-move] diagnostic capture failed:', e.message);
    }
  });

  it('(a) moves a folder and its subfolder to another account through the folder menu, and the original goes to Trash', async function () {
    const vaderId = accountId(VADER);

    // Right-click the folder, then Move folder….
    const opened = await browser.execute((path) => {
      const row = [...document.querySelectorAll(`[data-testid="folder-row"][data-path="${CSS.escape(path)}"]`)].find((r) => r.offsetHeight > 0);
      if (!row) return false;
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
      return true;
    }, MOVE_ROOT);
    expect(opened).toBe(true);
    await browser.waitUntil(() => browser.execute(() => {
      const item = [...document.querySelectorAll('[data-testid="folder-context-menu"] [role="menuitem"]')]
        .find((b) => (b.textContent || '').includes('Move folder'));
      if (!item || item.disabled) return false;
      item.click();
      return true;
    }), { timeout: 10_000, interval: 200, timeoutMsg: 'the folder menu never offered "Move folder…"' });

    // The dialog opens on the folder's own account.
    await browser.waitUntil(() => browser.execute(() => !!document.getElementById('move-folder-account')), {
      timeout: 10_000, interval: 200, timeoutMsg: 'the Move folder dialog never opened',
    });
    expect(await browser.execute(() => document.getElementById('move-folder-account').value)).toBe(accountId(LUKE));

    // Pick vader. The select is React-controlled: WebDriver's own select never
    // reaches onChange, so set it the way React reads it and dispatch.
    await browser.execute((id) => {
      const el = document.getElementById('move-folder-account');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, id);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, vaderId);
    // Both accounts have an Archive, so the proof the switch took is the
    // select holding vader after a render and luke's own folders gone.
    const targets = () => browser.execute(() => [...document.querySelectorAll('[data-testid="move-folder-target"]')]
      .map((b) => ({ path: b.getAttribute('data-path'), disabled: b.disabled })));
    await browser.waitUntil(async () => {
      const value = await browser.execute(() => document.getElementById('move-folder-account')?.value);
      const paths = (await targets()).map((t) => t.path);
      return value === vaderId && paths.includes('Archive') && !paths.includes(MOVE_ROOT) && !paths.includes('Kunden');
    }, { timeout: 30_000, interval: 300, timeoutMsg: `the dialog never listed vader's folders: ${JSON.stringify(await targets())}` });
    expect(await browser.execute(() => !!document.querySelector('[data-testid="move-folder-upsell"]'))).toBe(false);

    // vader's Archive becomes the parent.
    expect(await browser.execute(() => {
      const row = document.querySelector('[data-testid="move-folder-target"][data-path="Archive"]');
      if (!row || row.disabled) return false;
      row.click();
      return true;
    })).toBe(true);
    await browser.waitUntil(() => browser.execute(() => {
      const dialog = document.getElementById('move-folder-account')?.closest('[role="dialog"]');
      const confirm = dialog && [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Move folder');
      if (!confirm || confirm.disabled) return false;
      confirm.click();
      return true;
    }), { timeout: 15_000, interval: 300, timeoutMsg: 'Move folder never became clickable' });

    // Confirm closes the dialog at once: progress is the chip's.
    await browser.waitUntil(() => browser.execute(() => !document.getElementById('move-folder-account')), {
      timeout: 15_000, interval: 300, timeoutMsg: 'the dialog stayed open after Move folder',
    });

    const last = await finalEvent((p) => p.sourcePath === MOVE_ROOT && p.sourceAccountId === accountId(LUKE), 'the UI move');
    started.add(last.jobId);
    expect(last.destAccountId).toBe(vaderId);
    expect(last.destPath).toBe('Archive');
    expect(last.state).toBe('done');
    expect(last.failed).toBe(0);
    expect(last.copied + last.skipped).toBe(MOVE_ROOT_COUNT + MOVE_SUB_COUNT);
    expect(last.retired).toBe(true);
    expect(last.retiredTo).toBe(`Trash/${MOVE_ROOT}`);
    expect(last.sourceKeptReason ?? null).toBe(null);
    expect(last.folders.map((f) => [f.src, f.dest])).toEqual([[MOVE_ROOT, `Archive/${MOVE_ROOT}`], [MOVE_SUB, `Archive/${MOVE_SUB}`]]);

    // The chip says so.
    await browser.waitUntil(() => browser.execute((jobId) =>
      document.querySelector(`[data-testid="folder-move-job"][data-job-id="${jobId}"]`)?.getAttribute('data-state') === 'done', last.jobId), {
      timeout: 10_000, interval: 300, timeoutMsg: 'the corner chip never showed the move as done',
    });

    // vader holds the subtree under Archive.
    expect(await messageCount(VADER_SERVER, VADER, `Archive/${MOVE_ROOT}`)).toBe(MOVE_ROOT_COUNT);
    expect(await messageCount(VADER_SERVER, VADER, `Archive/${MOVE_SUB}`)).toBe(MOVE_SUB_COUNT);
    // luke's original is in Trash with its subfolder, its mail with it.
    const lukePaths = await listPaths(LUKE_SERVER, LUKE);
    expect(lukePaths).not.toContain(MOVE_ROOT);
    expect(lukePaths).not.toContain(MOVE_SUB);
    expect(await messageCount(LUKE_SERVER, LUKE, `Trash/${MOVE_ROOT}`)).toBe(MOVE_ROOT_COUNT);
    expect(await messageCount(LUKE_SERVER, LUKE, `Trash/${MOVE_SUB}`)).toBe(MOVE_SUB_COUNT);

    // The sidebar lists the folder again (now under Trash) and no longer at
    // the top: the exact path, since the Trash copy has the same name.
    await browser.waitUntil(async () => !(await visibleRow(MOVE_ROOT)) && (await storePaths()).includes(`Trash/${MOVE_ROOT}`), {
      timeout: 30_000, interval: 300,
      timeoutMsg: `the sidebar never dropped "${MOVE_ROOT}": ${JSON.stringify((await storePaths()).filter(ours))}`,
    });
  });

  it('(b) a cancel during the copy ends the job, keeps its journal and leaves the source untouched', async function () {
    const lukeId = accountId(LUKE);
    const params = { sourceAccountId: lukeId, sourcePath: CANCEL_FOLDER, destAccountId: accountId(VADER), destPath: null };

    // Start, and cancel on the event that says a few messages are copied: in
    // the page, so no WebDriver round trip sits between the two.
    const run = await browser.executeAsync((p, after, done) => {
      const invoke = (method, args) => window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method, params: args });
      const fail = (e) => done({ ok: false, __error: String((e && e.message) || e) });
      let jobId = null;
      let sent = false;
      const early = [];
      const consider = (ev) => {
        if (sent || !jobId || ev.jobId !== jobId) return;
        if (!(ev.copied >= after)) return;
        sent = true;
        invoke('folder_move.cancel', { jobId }).then((v) => done({ ok: true, jobId, cancel: v, at: ev }), fail);
      };
      window.__TAURI__.event.listen('folder-move-progress', (e) => (jobId ? consider(e.payload) : early.push(e.payload)))
        .then(() => invoke('folder_move.start', p))
        .then((r) => { jobId = r.jobId; early.forEach(consider); }, fail);
      setTimeout(() => { if (!sent) done({ ok: false, __error: `no event with ${after} copied for ${jobId}` }); }, 25_000);
    }, params, CANCEL_AFTER);
    if (run.jobId) started.add(run.jobId);
    if (!run.ok) throw new Error(`start then cancel: ${run.__error}`);
    expect(run.cancel.cancelled).toBe(true);

    const last = await finalEvent((p) => p.jobId === run.jobId, 'the cancelled move', 60_000);
    expect(last.state).toBe('cancelled');
    expect(last.sourceKeptReason).toBe('cancelled');
    expect(last.retired).toBe(false);
    // Mid-folder: some copied, not a run that finished before the cancel landed.
    expect(last.copied).toBeGreaterThanOrEqual(CANCEL_AFTER);
    expect(last.copied).toBeLessThan(CANCEL_COUNT);
    expect(last.skipped).toBe(0);
    // The destination holds exactly what the job says it copied.
    expect(await messageCount(VADER_SERVER, VADER, CANCEL_FOLDER)).toBe(last.copied);

    // The source is where it was, with every message, and not in Trash.
    const lukePaths = await listPaths(LUKE_SERVER, LUKE);
    expect(lukePaths).toContain(CANCEL_FOLDER);
    expect(lukePaths.some((p) => p.startsWith(`Trash/${CANCEL_FOLDER}`))).toBe(false);
    expect(await messageCount(LUKE_SERVER, LUKE, CANCEL_FOLDER)).toBe(CANCEL_COUNT);

    // The journal stays for a resume or a discard, and says cancelled.
    const journal = join(appDataDir(browser.testDataDir), 'folder_moves', `${run.jobId}.json`);
    expect(existsSync(journal)).toBe(true);
    const file = JSON.parse(readFileSync(journal, 'utf8'));
    expect(file.jobId).toBe(run.jobId);
    expect(file.state).toBe('cancelled');
    expect(file.root).toBe(CANCEL_FOLDER);
    const status = await daemonRpc('folder_move.status', {});
    expect(status.ok).toBe(true);
    const listed = status.v.jobs.find((j) => j.jobId === run.jobId);
    expect(listed).toBeDefined();
    expect(listed.live).toBe(false);
    expect(listed.state).toBe('cancelled');
  });

  it('(c) a move to the top level inside one account is one rename: same mail, no copy, nothing in Trash', async function () {
    const lukeId = accountId(LUKE);
    const before = await messageIds(LUKE_SERVER, LUKE, RENAME_SOURCE);
    expect(before.length).toBe(RENAME_COUNT);

    const start = await daemonRpc('folder_move.start', { sourceAccountId: lukeId, sourcePath: RENAME_SOURCE, destAccountId: lukeId, destPath: null });
    if (!start.ok) throw new Error(`folder_move.start: ${start.__error}`);
    started.add(start.v.jobId);

    const last = await finalEvent((p) => p.jobId === start.v.jobId, 'the rename');
    expect(last.state).toBe('done');
    expect(last.retired).toBe(false);
    expect(last.retiredTo ?? null).toBe(null);
    expect(last.total).toBe(0);
    expect(last.copied).toBe(0);
    expect(last.folders.map((f) => [f.src, f.dest])).toEqual([[RENAME_SOURCE, RENAME_LEAF]]);

    const lukePaths = await listPaths(LUKE_SERVER, LUKE);
    expect(lukePaths).toContain(RENAME_LEAF);
    expect(lukePaths).not.toContain(RENAME_SOURCE);
    expect(lukePaths).toContain(RENAME_HOST);
    expect(lukePaths.some((p) => p.startsWith(`Trash/${RENAME_LEAF}`))).toBe(false);
    // The same messages, once each.
    const after = await messageIds(LUKE_SERVER, LUKE, RENAME_LEAF);
    expect(after.length).toBe(RENAME_COUNT);
    expect(new Set(after).size).toBe(RENAME_COUNT);
    expect([...after].sort()).toEqual([...before].sort());
  });
});
