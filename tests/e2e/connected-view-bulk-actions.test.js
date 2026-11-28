/**
 * E2E: bulk actions on a saved view's rows.
 *
 * A view's rows are not in any folder list: they live in searchStore's
 * `searchResults`, filled by `views.evaluate`. Every bulk action has to reach
 * that list as well as the server, or the view keeps painting what the user
 * just changed. One view holds eight archived Luke INBOX messages, two per
 * case below, ticked by their row checkboxes:
 *
 *   1. Mark read, then unread: the rows repaint, the server holds \Seen.
 *   2. Star: the rows show starred, the server holds \Flagged.
 *   3. Move to Archive: the rows leave the view, the server holds them there.
 *   4. Delete everywhere: the rows leave the DOM and `searchResults` within
 *      1000 ms of the confirm click, the bulk panel (BulkOperationProgress)
 *      shows bottom-right, the removed bottom-left delete chip never shows,
 *      and the server's INBOX no longer has them.
 *   5. Delete from server: the rows leave the view within 1000 ms.
 *
 * ── Why its own messages ──────────────────────────────────────────────────
 * One mock server serves the whole run, and Luke's fixture INBOX is read by
 * other specs (several pick "Luke message NN" rows by position). So this spec
 * APPENDs eight messages of its own, dated now so they head the list, and
 * expunges every one of them from INBOX, Archive and Trash afterwards.
 *
 * They are archived first: a view finds what the search index holds, and the
 * index is built from the vault. The view is saved straight through the
 * daemon (`views.save`), and the window reloads so its sidebar lists it.
 */
import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, reloadApp, waitForEmails, switchToFolder } from './helpers.js';
import { clickSelectionAction, selectionActionReady } from './selectionBar.js';

const LUKE = 'luke@mock.test';
const LUKE_SERVER = 0; // MOCK_ACCOUNTS order: luke, vader, yoda
const VIEW_ID = 'e2e-view-bulk-actions';
const TOKEN = 'Zebrafinch';
const FIXTURES = {
  read: [`${TOKEN} read one`, `${TOKEN} read two`],
  move: [`${TOKEN} move one`, `${TOKEN} move two`],
  purge: [`${TOKEN} purge one`, `${TOKEN} purge two`],
  server: [`${TOKEN} server one`, `${TOKEN} server two`],
};
const ALL = Object.values(FIXTURES).flat();
const HIDE_BUDGET_MS = 1000;

const rfc822 = (subject, date) => Buffer.from([
  'From: Finch Sender <finch@mock.test>',
  `To: ${LUKE}`,
  `Subject: ${subject}`,
  `Date: ${date.toUTCString()}`,
  `Message-ID: <${subject.toLowerCase().replaceAll(' ', '-')}@mock.test>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  `${subject} body for the view bulk actions spec`,
  '',
].join('\r\n'));

describe('Bulk actions on a saved view', function () {
  this.timeout(600_000);
  let lukeId = null;
  const measured = {};

  // ── The server, behind the app's back ──────────────────────────────────

  async function withLuke(fn) {
    const { host, port } = browser.mockImap[LUKE_SERVER];
    const client = new ImapFlow({ host, port, secure: false, auth: { user: LUKE, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  const uidsIn = (mailbox, subject) => withLuke(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await client.search({ subject }, { uid: true });
    } finally {
      lock.release();
    }
  });

  /// What the server holds for each subject in INBOX: its uids and flags.
  /// Looked up by subject, so the check never trusts the app's idea of a uid.
  const serverState = (subjects) => withLuke(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const out = {};
      for (const subject of subjects) {
        const uids = await client.search({ subject }, { uid: true });
        const flags = [];
        if (uids.length) {
          for await (const msg of client.fetch(uids, { flags: true }, { uid: true })) flags.push([...(msg.flags || [])]);
        }
        out[subject] = { uids, flags };
      }
      return out;
    } finally {
      lock.release();
    }
  });
  const everyHolds = (state, test) => Object.values(state).every((s) => s.flags.length === 1 && test(s.flags[0]));

  async function purgeFixtures() {
    for (const mailbox of ['INBOX', 'Archive', 'Trash']) {
      try {
        const uids = await uidsIn(mailbox, TOKEN);
        if (!uids.length) continue;
        await withLuke(async (client) => {
          const lock = await client.getMailboxLock(mailbox);
          try {
            await client.messageDelete(uids, { uid: true });
          } finally {
            lock.release();
          }
        });
      } catch (e) {
        console.warn(`[view-bulk-actions] could not purge ${mailbox}:`, e.message);
      }
    }
  }

  // ── The app ────────────────────────────────────────────────────────────

  const rpc = (method, params) => browser.executeAsync((m, p, done) => {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((value) => done({ ok: true, value }), (error) => done({ ok: false, error: String(error?.message || error) }));
  }, method, params);

  /// The fixture rows on screen, by exact subject.
  const domRows = () => browser.execute((token) =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => {
      const subjectEl = row.querySelector('[data-testid="row-subject"]');
      const subject = (subjectEl?.textContent || '').trim();
      return {
        subject,
        unread: !!subjectEl && subjectEl.className.includes('font-semibold'),
        starred: row.querySelector('[data-testid="star-toggle"]')?.getAttribute('aria-pressed') === 'true',
        checked: !!row.querySelector('input[type="checkbox"]')?.checked,
        icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
      };
    }).filter((r) => r.subject.startsWith(token)), TOKEN);

  /// The fixture rows the view holds (searchStore), by exact subject.
  const storeRows = () => browser.execute((token) =>
    (window.__SEARCH_STORE__?.getState().searchResults || [])
      .filter((e) => (e.subject || '').startsWith(token))
      .map((e) => ({ subject: e.subject, flags: e.flags || [], mailbox: e._mailbox, accountId: e._accountId, uid: e.uid })), TOKEN);

  const viewActive = () => browser.execute((id) =>
    document.querySelector(`[data-testid="view-row-${id}"]`)?.getAttribute('aria-current') === 'true', VIEW_ID);

  const toggleRows = (subjects) => browser.execute((wanted) => {
    let clicked = 0;
    for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
      const subject = (row.querySelector('[data-testid="row-subject"]')?.textContent || '').trim();
      if (!wanted.includes(subject)) continue;
      row.querySelector('input[type="checkbox"]')?.click();
      clicked += 1;
    }
    return clicked;
  }, subjects);

  const clearChecks = async () => {
    await browser.execute(() => {
      for (const box of document.querySelectorAll('[data-testid="email-row"] input[type="checkbox"]')) {
        if (box.checked) box.click();
      }
    });
    await browser.waitUntil(async () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="email-row"] input[type="checkbox"]')].every((c) => !c.checked)),
    { timeout: 10_000, interval: 200, timeoutMsg: 'rows stayed ticked after clearing the selection' });
  };

  /// Tick exactly these rows, and wait for the bar to offer `action`.
  async function select(subjects, action) {
    await clearChecks();
    expect(await toggleRows(subjects)).toBe(subjects.length);
    await browser.waitUntil(async () => {
      const rows = await domRows();
      return subjects.every((s) => rows.find((r) => r.subject === s)?.checked);
    }, { timeout: 10_000, interval: 200, timeoutMsg: `${JSON.stringify(subjects)} never showed ticked` });
    await browser.waitUntil(() => selectionActionReady(action),
      { timeout: 10_000, interval: 200, timeoutMsg: `the selection bar never offered "${action}"` });
  }

  const waitDialog = (why) => browser.waitUntil(async () => browser.execute(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    const buttons = dialog ? [...dialog.querySelectorAll('button')] : [];
    return buttons.length > 0 && buttons[buttons.length - 1].offsetHeight > 0;
  }), { timeout: 10_000, interval: 100, timeoutMsg: why });

  /**
   * Click the confirmation's button and stamp, in the page, when the rows left
   * the DOM and `searchResults` and when the bulk panel arrived. The stamps
   * come from a store subscription (zustand calls it synchronously on the
   * write) and a MutationObserver, not from a timer, so a throttled timer on
   * an occluded window cannot inflate them; elapsed time is performance.now,
   * so WebDriver round trips never count against the product. A 6 s timer is
   * only the give-up deadline.
   */
  const confirmAndTime = (subjects, label) => browser.executeAsync((wanted, wantedLabel, done) => {
    const dialog = document.querySelector('[role="alertdialog"]');
    const buttons = dialog ? [...dialog.querySelectorAll('button')] : [];
    const confirm = buttons.find((b) => (b.textContent || '').trim() === wantedLabel) || null;
    if (!confirm) { done({ error: `no "${wantedLabel}" button; saw ${JSON.stringify(buttons.map((b) => (b.textContent || '').trim()))}` }); return; }
    const inDom = () => [...document.querySelectorAll('[data-testid="email-row"]')]
      .some((row) => wanted.includes((row.querySelector('[data-testid="row-subject"]')?.textContent || '').trim()));
    const inStore = () => (window.__SEARCH_STORE__?.getState().searchResults || [])
      .some((e) => wanted.includes(e.subject));
    const out = { domGoneMs: null, storeGoneMs: null, panelMs: null, panel: null };
    let t0 = null;
    let finished = false;
    let observer = null;
    let unsubscribe = null;
    let deadline = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      observer?.disconnect();
      unsubscribe?.();
      clearTimeout(deadline);
      done(out);
    };
    const check = () => {
      if (t0 === null || finished) return;
      const now = Math.round(performance.now() - t0);
      if (out.domGoneMs === null && !inDom()) out.domGoneMs = now;
      if (out.storeGoneMs === null && !inStore()) out.storeGoneMs = now;
      if (out.panelMs === null) {
        const panel = window.__e2eFindBulkPanel?.(wanted.length);
        if (panel) { out.panelMs = now; out.panel = panel; }
      }
      if (out.domGoneMs !== null && out.storeGoneMs !== null && out.panelMs !== null) finish();
    };
    observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    unsubscribe = window.__SEARCH_STORE__?.subscribe(check);
    deadline = setTimeout(() => { check(); finish(); }, 6000);
    t0 = performance.now();
    confirm.click();
    check();
  }, subjects, label);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    expect(lukeId).toBeTruthy();

    // A clean slate even if an earlier run of this spec died midway.
    await purgeFixtures();
    const now = Date.now();
    await withLuke(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        for (const [i, subject] of ALL.entries()) {
          const date = new Date(now - i * 60_000);
          await client.append('INBOX', rfc822(subject, date), [], date);
        }
      } finally {
        lock.release();
      }
    });
    expect((await uidsIn('INBOX', TOKEN)).length).toBe(ALL.length);

    // The list learns of the new mail; nudge it by reopening the folder.
    await switchToFolder(LUKE, 'INBOX');
    let lastNudge = Date.now();
    await browser.waitUntil(async () => {
      const shown = (await domRows()).map((r) => r.subject);
      if (ALL.every((s) => shown.includes(s))) return true;
      if (Date.now() - lastNudge > 15_000) {
        await switchToFolder(LUKE, 'Sent', { requireRows: false });
        await switchToFolder(LUKE, 'INBOX');
        lastNudge = Date.now();
      }
      return false;
    }, { timeout: 150_000, interval: 500, timeoutMsg: `Luke's INBOX never listed all ${ALL.length} appended messages` });

    // Into the vault, so the index (and with it the view) can find them.
    await clearChecks();
    expect(await toggleRows(ALL)).toBe(ALL.length);
    expect(await clickSelectionAction('archive')).toBe(true);
    await browser.waitUntil(async () => {
      const rows = await domRows();
      return ALL.every((s) => rows.find((r) => r.subject === s)?.icon?.startsWith('archived'));
    }, { timeout: 120_000, interval: 500, timeoutMsg: 'the appended messages never all became archived rows' });
    await clearChecks();

    // One view over exactly these eight. The starters go: nothing else in the
    // sidebar, and no cap on a free plan to think about.
    const listed = await rpc('views.list', {});
    expect(listed.ok).toBe(true);
    const saved = await rpc('views.save', { view: {
      id: VIEW_ID, name: 'E2E bulk', icon: 'mail', position: 0, builtin: null,
      def: { accounts: [lukeId], mailboxes: ['INBOX'], query: TOKEN },
    } });
    expect(saved.ok).toBe(true);
    for (const view of listed.value || []) {
      if (view.id === VIEW_ID) continue;
      expect((await rpc('views.delete', { id: view.id })).ok).toBe(true);
    }

    // Asked until the index holds all eight. Every 2s: a foreground RPC parks
    // the indexer for a moment, and this one waits on it.
    let evaluated = null;
    await browser.waitUntil(async () => {
      evaluated = await rpc('views.evaluate', { viewId: VIEW_ID, accounts: [{ accountId: lukeId, address: LUKE }] });
      return evaluated.ok && evaluated.value?.available === true && evaluated.value.total === ALL.length;
    }, { timeout: 180_000, interval: 2000 }).catch(() => {
      throw new Error(`the view never held exactly the ${ALL.length} fixtures: ${JSON.stringify(evaluated?.value?.total ?? evaluated)}`);
    });
    expect((evaluated.value.rows || []).map((r) => r.subject).sort()).toEqual([...ALL].sort());

    // The window loads its views at boot: reload so the sidebar lists this one.
    await reloadApp();
    await waitForEmails();
    if (await browser.execute(() => document.querySelector('[data-testid="views-fold"]')?.getAttribute('aria-expanded') === 'false')) {
      await browser.execute(() => document.querySelector('[data-testid="views-fold"]').click());
    }
    await browser.waitUntil(async () => browser.execute((id) =>
      !!document.querySelector(`[data-testid="view-row-${id}"]`), VIEW_ID),
    { timeout: 30_000, interval: 300, timeoutMsg: 'the sidebar never listed the view' });

    // Star is not on the selection bar by default: put it there.
    await browser.execute(() => {
      const s = window.__SETTINGS_STORE__.getState();
      const qa = s.quickActions;
      const selection = qa.defaults.selection;
      if (selection.entries.some((e) => e.action === 'star')) return;
      window.__SETTINGS_STORE__.setState({ quickActions: { ...qa, defaults: { ...qa.defaults,
        selection: { ...selection, entries: [...selection.entries, { id: 'star', action: 'star' }] } } } });
    });

    // The bulk panel's slot in the bottom dock, by its "N of M emails" line.
    // The move toast (`bulk-save-progress`) shares the dock and is not it.
    await browser.execute(() => {
      window.__e2eFindBulkPanel = (total) => {
        const host = document.querySelector('[data-toast-dock="bottom"]');
        if (!host) return null;
        const line = total ? new RegExp(`\\d+ of ${total} emails`) : /\d+ of \d+ emails/;
        for (const slot of host.children) {
          if (slot.querySelector('[data-testid="bulk-save-progress"]')) continue;
          const text = slot.innerText || '';
          if (!line.test(text)) continue;
          const r = slot.getBoundingClientRect();
          return {
            text: text.replace(/\s*\n\s*/g, ' | ').trim(),
            rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom),
              width: Math.round(r.width), height: Math.round(r.height) },
            win: { width: window.innerWidth, height: window.innerHeight },
            align: slot.className,
          };
        }
        return null;
      };
      // The bottom-left delete chip was removed; watch for it for the rest of the run.
      window.__e2eChipSeen = false;
      const check = () => {
        if (document.querySelector('[data-testid="delete-everywhere-chip"]')) window.__e2eChipSeen = true;
      };
      window.__e2eChipObserver?.disconnect();
      window.__e2eChipObserver = new MutationObserver(check);
      window.__e2eChipObserver.observe(document.body, { childList: true, subtree: true });
      check();
    });

    // Open the view.
    await browser.execute((id) => document.querySelector(`[data-testid="view-row-${id}"]`).click(), VIEW_ID);
    await browser.waitUntil(viewActive, { timeout: 10_000, timeoutMsg: 'the view did not become the open one' });
    await browser.waitUntil(async () => {
      const dom = (await domRows()).map((r) => r.subject);
      const store = (await storeRows()).map((r) => r.subject);
      return ALL.every((s) => dom.includes(s) && store.includes(s));
    }, { timeout: 30_000, interval: 300, timeoutMsg: 'the open view never listed all the fixtures' });
  });

  after(async function () {
    await browser.execute(() => window.__e2eChipObserver?.disconnect()).catch(() => {});
    await browser.execute(() => window.__SETTINGS_STORE__?.getState().resetQuickActions?.()).catch(() => {});
    await rpc('views.delete', { id: VIEW_ID }).catch(() => {});
    await purgeFixtures();
    console.log(`[view-bulk-actions] measured: ${JSON.stringify(measured)}`);
  });

  it('marks a 2-row selection read, then unread, and the view repaints', async function () {
    const subjects = FIXTURES.read;
    const state = async () => {
      const dom = await domRows();
      const store = await storeRows();
      return subjects.map((s) => ({
        subject: s,
        domUnread: dom.find((r) => r.subject === s)?.unread,
        seen: store.find((r) => r.subject === s)?.flags.includes('\\Seen'),
      }));
    };
    // Anti-vacuity: appended with no flags, they start unread.
    const start = await state();
    expect(start.every((r) => r.domUnread === true && r.seen === false)).toBe(true);

    await select(subjects, 'markRead');
    expect(await clickSelectionAction('markRead')).toBe(true);
    await browser.waitUntil(async () => (await state()).every((r) => r.domUnread === false && r.seen === true), {
      timeout: 20_000, interval: 200,
      timeoutMsg: `the view did not repaint read: ${JSON.stringify(await state())}`,
    });
    const storeRowsSeen = await storeRows();
    let server = null;
    await browser.waitUntil(async () => everyHolds(server = await serverState(subjects), (f) => f.includes('\\Seen')),
      { timeout: 30_000, interval: 1000 }).catch(() => {
      throw new Error(`the server never held \\Seen for both: server ${JSON.stringify(server)}, view ${JSON.stringify(storeRowsSeen)}`);
    });

    await select(subjects, 'markUnread');
    expect(await clickSelectionAction('markUnread')).toBe(true);
    await browser.waitUntil(async () => (await state()).every((r) => r.domUnread === true && r.seen === false), {
      timeout: 20_000, interval: 200,
      timeoutMsg: `the view did not repaint unread: ${JSON.stringify(await state())}`,
    });
    await browser.waitUntil(async () => everyHolds(server = await serverState(subjects), (f) => !f.includes('\\Seen')),
      { timeout: 30_000, interval: 1000 }).catch(() => {
      throw new Error(`the server still held \\Seen after Mark unread: ${JSON.stringify(server)}`);
    });
    await clearChecks();
  });

  it('stars a 2-row selection and the view shows them starred', async function () {
    const subjects = FIXTURES.read;
    const state = async () => {
      const dom = await domRows();
      const store = await storeRows();
      return subjects.map((s) => ({
        subject: s,
        domStarred: dom.find((r) => r.subject === s)?.starred,
        flagged: store.find((r) => r.subject === s)?.flags.includes('\\Flagged'),
      }));
    };
    expect((await state()).every((r) => r.domStarred === false && r.flagged === false)).toBe(true);

    await select(subjects, 'star');
    expect(await clickSelectionAction('star')).toBe(true);
    await browser.waitUntil(async () => (await state()).every((r) => r.domStarred === true && r.flagged === true), {
      timeout: 20_000, interval: 200,
      timeoutMsg: `the view never showed them starred: ${JSON.stringify(await state())}`,
    });
    const viewRows = await storeRows();
    let server = null;
    await browser.waitUntil(async () => everyHolds(server = await serverState(subjects), (f) => f.includes('\\Flagged')),
      { timeout: 30_000, interval: 1000 }).catch(() => {
      throw new Error(`the server never held \\Flagged for both: server ${JSON.stringify(server)}, view ${JSON.stringify(viewRows)}`);
    });
    await clearChecks();
  });

  it('moves a 2-row selection to Archive: the rows leave the view, the server holds them there', async function () {
    const subjects = FIXTURES.move;
    await select(subjects, 'move');
    expect(await clickSelectionAction('move')).toBe(true);
    await browser.waitUntil(async () => browser.execute(() =>
      document.querySelector('[data-testid="move-to-folder-dropdown"]')?.offsetHeight > 0),
    { timeout: 10_000, interval: 200, timeoutMsg: 'the move-to-folder dropdown never opened' });
    const picked = await browser.execute(() => {
      const dropdown = document.querySelector('[data-testid="move-to-folder-dropdown"]');
      for (const btn of dropdown.querySelectorAll('[data-testid="move-folder-option"], button')) {
        if ((btn.textContent || '').trim() === 'Archive') { btn.click(); return 'Archive'; }
      }
      return [...dropdown.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|');
    });
    expect(picked).toBe('Archive');

    const t0 = Date.now();
    await browser.waitUntil(async () => {
      const dom = (await domRows()).map((r) => r.subject);
      const store = (await storeRows()).map((r) => r.subject);
      return subjects.every((s) => !dom.includes(s) && !store.includes(s));
    }, { timeout: 30_000, interval: 200, timeoutMsg: `the moved rows stayed in the view: ${JSON.stringify(await storeRows())}` });
    measured.moveHideMs = Date.now() - t0;

    await browser.waitUntil(async () => {
      for (const s of subjects) {
        if ((await uidsIn('Archive', s)).length !== 1) return false;
        if ((await uidsIn('INBOX', s)).length !== 0) return false;
      }
      return true;
    }, { timeout: 60_000, interval: 1000, timeoutMsg: 'the server never held both in Archive (and not in INBOX)' });
    // The other fixtures are untouched.
    const left = (await storeRows()).map((r) => r.subject);
    expect([...FIXTURES.read, ...FIXTURES.purge, ...FIXTURES.server].every((s) => left.includes(s))).toBe(true);
  });

  it('deletes a 2-row selection everywhere: gone within 1000 ms, the bulk panel bottom-right, no chip', async function () {
    const subjects = FIXTURES.purge;
    // No earlier panel still up to be mistaken for this one.
    await browser.waitUntil(async () => browser.execute(() => !window.__e2eFindBulkPanel(null)),
      { timeout: 20_000, interval: 300, timeoutMsg: 'an earlier bulk panel never went away' });

    await select(subjects, 'deleteEverywhere');
    expect(await clickSelectionAction('deleteEverywhere')).toBe(true);
    await waitDialog('the Delete everywhere confirmation never appeared');

    const timed = await confirmAndTime(subjects, 'Delete everywhere');
    console.log(`[view-bulk-actions] delete everywhere: ${JSON.stringify(timed)}`);
    expect(timed.error).toBeUndefined();
    measured.everywhere = timed;

    let panel = timed.panel;
    if (!panel) {
      await browser.waitUntil(async () => !!(panel = await browser.execute((n) => window.__e2eFindBulkPanel(n), subjects.length)),
        { timeout: 20_000, interval: 100, timeoutMsg: 'the bulk progress panel never appeared for the delete' });
    }
    measured.everywherePanel = panel;
    console.log(`[view-bulk-actions] delete everywhere panel: ${JSON.stringify(panel)}`);

    expect(timed.domGoneMs).not.toBeNull();
    expect(timed.storeGoneMs).not.toBeNull();
    expect(timed.domGoneMs).toBeLessThanOrEqual(HIDE_BUDGET_MS);
    expect(timed.storeGoneMs).toBeLessThanOrEqual(HIDE_BUDGET_MS);

    // Bottom-right: its slot sits wholly in the right half and the bottom half.
    expect(panel.rect.width).toBeGreaterThan(0);
    expect(panel.rect.left).toBeGreaterThanOrEqual(panel.win.width / 2);
    expect(panel.rect.right).toBeLessThanOrEqual(panel.win.width);
    expect(panel.rect.top).toBeGreaterThanOrEqual(panel.win.height / 2);
    expect(panel.rect.bottom).toBeLessThanOrEqual(panel.win.height);

    // The run on the server, while watching for the old chip all the way.
    await browser.waitUntil(async () => {
      for (const s of subjects) if ((await uidsIn('INBOX', s)).length !== 0) return false;
      return true;
    }, { timeout: 60_000, interval: 1000, timeoutMsg: 'the server INBOX still held the messages deleted everywhere' });
    expect(await browser.execute(() => window.__e2eChipSeen)).toBe(false);
    expect(await browser.execute(() => !!document.querySelector('[data-testid="delete-everywhere-chip"]'))).toBe(false);
    // Still gone from the view after the round trip.
    const left = (await storeRows()).map((r) => r.subject);
    expect(subjects.some((s) => left.includes(s))).toBe(false);
  });

  it('deletes a 2-row selection from the server: gone from the view within 1000 ms', async function () {
    const subjects = FIXTURES.server;
    await browser.waitUntil(async () => browser.execute(() => !window.__e2eFindBulkPanel(null)),
      { timeout: 20_000, interval: 300, timeoutMsg: 'an earlier bulk panel never went away' });

    await select(subjects, 'deleteServer');
    expect(await clickSelectionAction('deleteServer')).toBe(true);
    await waitDialog('the Delete from server confirmation never appeared');

    const timed = await confirmAndTime(subjects, 'Delete from server');
    console.log(`[view-bulk-actions] delete from server: ${JSON.stringify(timed)}`);
    expect(timed.error).toBeUndefined();
    measured.server = timed;

    expect(timed.domGoneMs).not.toBeNull();
    expect(timed.storeGoneMs).not.toBeNull();
    expect(timed.domGoneMs).toBeLessThanOrEqual(HIDE_BUDGET_MS);
    expect(timed.storeGoneMs).toBeLessThanOrEqual(HIDE_BUDGET_MS);

    await browser.waitUntil(async () => {
      for (const s of subjects) if ((await uidsIn('INBOX', s)).length !== 0) return false;
      return true;
    }, { timeout: 60_000, interval: 1000, timeoutMsg: 'the server INBOX still held the messages deleted from the server' });
    // Not back after the round trip, and the chip never showed.
    await browser.pause(1500);
    const left = (await storeRows()).map((r) => r.subject);
    expect(subjects.some((s) => left.includes(s))).toBe(false);
    expect(await browser.execute(() => window.__e2eChipSeen)).toBe(false);
  });
});
