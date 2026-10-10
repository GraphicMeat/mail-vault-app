/**
 * Product Hunt tour, Tier 1 (docs/product-hunt-demo-script.md): one app boot,
 * one `it` (one .mov) per clip, named c<NN>-<feature> after the clip table.
 *
 *   c01-custody  custody icons: hover the legend, a gold row, scroll a mix, open a gold message
 *   c04-radial   right-click wheel, flick to Star; Settings > Quick actions: presets, drag reorder
 *   c06-notes-board        Notes to Self: the board, open a card, star it, mark another done
 *   c07-network-activity   Settings > Privacy & security > Network Activity: range, map country, purpose, rows
 *   c08-views-fields       built-in views, a custom field in the reader, a new view grouped by it
 *   c09-time-capsule       Settings > Time Capsule: older snapshots, take one live, browse one, read a message
 *   c10-trackers           the row eye, the newsletter, the vendor dialog, "Tracker blocked" in the body
 *   c11-insights-explorer  Insights map, hover, timeline, activity; Explorer by date, sender, conversation
 *   c12-chat     a long thread in the reader, Settings > Layout > Chat, the thread as bubbles
 *
 * STAGED in c07 and c09 (disclose in the cut): c07 seeds demo rows into
 * app.db `net_events` (the mock servers are on 127.0.0.1, so real rows only
 * ever say "Local network"); the real rows are kept and re-numbered by start
 * time with them. c09 writes three
 * backdated snapshot files in the real format, built from a real snapshot of
 * the vault (taken and removed in setup) cut to the mail dated before each
 * stamp; the snapshot taken in the take is real.
 *
 * Not yet here: 2, 3, 5. Add each as its own `it('cNN-...')`
 * through `shoot()`, in clip order. `FOOTAGE_ONLY=c01-custody,c12-chat` limits a
 * run (setup still runs).
 *
 * c06 and c10 need FOOTAGE_EXTRA_MAIL=1 (ten more messages in the work INBOX,
 * lib/mailbox.js: FOOTAGE_EXPECT_TOTAL 2852 with the default history). Leave it
 * off for c01/c04/c12 so their counts match batch 1. c06, c08 and c11 archive
 * everything in their `prepare`: a full run shoots c12 on an all-archived
 * vault, not the custody mix batch 1 had.
 *
 * Setup (not recorded) is boot-a's vault mix, copied here because importing
 * boot-a.js would register its clips: the last 90 days archived (green),
 * today's two un-archived again (blue, server only), three archived and then
 * deleted from the server (amber, "only copy"). A clip that needs everything
 * archived (search) calls `archiveEverything()` in its `prepare` and must come
 * AFTER c01-custody, which needs the mix.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, clickSel, bootToInbox, resetView, beforeTake,
  waitPage, since, openWorkInbox, dismissBulkBubble,
} from '../lib/scene.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = {};

// ── Page predicates (serialised into the page; no closures) ─────────────────

const readerOpen = (empty) => !document.body.innerText.includes(empty);

/** Per-row state glyphs currently rendered, counted by data-state. */
const rowStates = () => {
  const counts = {};
  for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
    const s = row.querySelector('[data-testid="msg-state-icon"]')?.dataset.state || 'none';
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
};

/** The bulk progress bubble's text ('' when there is none). */
const bubbleText = () => {
  for (const el of document.querySelectorAll('.fixed.bottom-4.right-4')) {
    if (el.offsetHeight > 0) return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }
  return '';
};

const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;

// ── Setup: the vault mix, through the real bulk dialog (from boot-a.js) ─────

async function bulk(presetLabel, action, { deleteConfirm = false } = {}) {
  const t0 = Date.now();
  const opened = await browser.execute((label) => {
    const btn = document.querySelector(`.mail-list-toolbar button[aria-label="${label}"]`)
      || document.querySelector(`button[aria-label="${label}"]`);
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  }, L('workspace.selectMessages'));
  if (!opened) throw new Error('bulk: select-messages control not found');
  if (!(await waitPage((t) => document.body.innerText.includes(t), { timeout: 10000 }, L('bulk.ops.bulkEmailOperations')))) {
    throw new Error('bulk: dialog did not open');
  }
  await browser.pause(800);
  if (!(await clickSel('[role="dialog"] button', presetLabel))) throw new Error(`bulk: preset ${presetLabel} not found`);
  const selectedWord = L('bulk.ops.emailsSelected').replace('{{selectedCount}}', '').trim();
  if (!(await waitPage((w) => document.body.innerText.includes(w), { timeout: 10000 }, selectedWord))) {
    throw new Error(`bulk: ${presetLabel} selected nothing`);
  }
  const count = await browser.execute((w) => {
    const m = document.body.innerText.match(new RegExp(`([\\d,]+) ${w}`));
    return m ? m[1] : null;
  }, selectedWord);
  await browser.pause(400);
  await waitPage((n) => [...document.querySelectorAll('[role="dialog"] button')]
    .some((b) => (b.textContent || '').trim().startsWith(n) && !b.disabled), { timeout: 30000 }, L('common.next'));
  if (!(await clickSel('[role="dialog"] button', L('common.next')))) throw new Error('bulk: Next not clickable');
  await browser.pause(500);
  if (!(await clickSel(`[data-testid="bulk-action-${action}"]`))) throw new Error(`bulk: action ${action} not offered`);
  await browser.pause(300);
  if (!(await clickSel('[data-testid="bulk-step2-confirm"]'))) throw new Error('bulk: confirm not clickable');
  if (deleteConfirm) {
    await waitPage(() => !!document.querySelector('[data-testid="bulk-delete-confirm"]'), { timeout: 5000 });
    if (!(await clickSel('[data-testid="bulk-delete-confirm"]'))) throw new Error('bulk: delete confirm not clickable');
  }
  if (action !== 'unarchive') {
    const done = await waitPage((c) => {
      for (const el of document.querySelectorAll('.fixed.bottom-4.right-4')) if ((el.innerText || '').includes(c)) return true;
      return false;
    }, { timeout: 180000, interval: 400 }, L('bulk.progress.operationComplete'));
    if (!done) throw new Error(`bulk: ${action} never completed (${await browser.execute(bubbleText)})`);
  }
  await browser.execute(() => window.__MAIL_STORE__?.getState?.().loadEmails?.());
  await browser.pause(2500);
  console.log(`[setup] bulk ${presetLabel} -> ${action}: ${count} selected, ${since(t0)} s, archived now ${await archivedCount()}`);
  return count;
}

const archivedCount = () => browser.execute(() => window.__MAIL_STORE__?.getState?.().archivedEmailIds?.size ?? null);

/** One bulk step; on failure the dialog is closed so it cannot ride into a take. */
async function bulkStep(presetLabel, action, opts) {
  try {
    return await bulk(presetLabel, action, opts);
  } catch (e) {
    await browser.execute(() => window.__MAIL_STORE__?.getState?.().endBulkSession?.());
    await browser.pause(500);
    throw e;
  }
}

/** Uids of the loaded rows whose subject contains each needle (first match per needle). */
function uidsBySubject(needles) {
  return browser.execute((ns) => {
    const rows = window.__MAIL_STORE__?.getState?.().sortedEmails || [];
    return ns.map((n) => rows.find((e) => (e.subject || '').includes(n))?.uid ?? null);
  }, needles);
}

/** Re-open the work INBOX until the store reflects the vault. */
async function refreshInbox(pred, what, ...args) {
  for (let i = 0; i < 4; i++) {
    await openWorkInbox();
    if (await waitPage(pred, { timeout: 8000, interval: 400 }, ...args)) return true;
  }
  console.warn(`[setup] store never showed ${what}`);
  return false;
}

/** boot-a's per-message states: green (90 days archived), blue (today's two), amber (three only copies). */
async function seedVaultStates() {
  facts.seed = {};
  facts.seed.archived = await bulkStep(L('bulk.ops.last90Days'), 'archive');
  const n = Number(String(facts.seed.archived || '0').replace(/\D/g, ''));
  await refreshInbox((w) => (window.__MAIL_STORE__?.getState?.().archivedEmailIds?.size ?? 0) >= w, `${n} archived`, n);

  const blue = (await uidsBySubject(['MeatPad - code folding', 'Press slot Friday 06:00 - confirmed'])).filter(Boolean);
  facts.seed.blue = blue;
  const unarchived = await browser.executeAsync((uids, done) => {
    Promise.resolve(window.__MAIL_STORE__.getState().removeLocalEmails(uids)).then(() => done(true), (e) => done(String(e?.message || e)));
  }, blue);
  console.log(`[setup] unarchived ${JSON.stringify(blue)}: ${unarchived}`);

  const gold = (await uidsBySubject(['Invoice CC-2026-0413', 'Medium Rare Films - NDA countersigned', 'Your House Blend is on the way'])).filter(Boolean);
  facts.seed.gold = gold;
  for (const uid of gold) {
    const r = await browser.executeAsync((u, done) => {
      Promise.resolve(window.__MAIL_STORE__.getState().deleteEmailFromServer(u, { skipRefresh: true }))
        .then((o) => done({ ok: true, trash: o?.trash ?? null }), (e) => done({ error: String(e?.message || e) }));
    }, uid);
    console.log(`[setup] deleted server copy of ${uid}: ${JSON.stringify(r)}`);
  }
  await refreshInbox((w) => [...document.querySelectorAll('[data-testid="email-row"] [data-testid="msg-state-icon"]')]
    .filter((el) => (el.dataset.state || '').startsWith('local-only')).length >= w, `${gold.length} only-copy rows`, gold.length);
  facts.seed.rowStates = await browser.execute(rowStates);
  console.log('[setup] row states after seeding:', JSON.stringify(facts.seed.rowStates));
}

/**
 * The rest of the INBOX archived too (All -> Archive), for clips that search
 * the vault. Once per boot; it ends the custody mix, so it runs only from a
 * later clip's `prepare`.
 */
let archivedAll = false;
// eslint-disable-next-line no-unused-vars
async function archiveEverything() {
  if (archivedAll) return;
  archivedAll = true;
  const t0 = Date.now();
  try {
    facts.archiveAll = { selected: await bulkStep('All', 'archive') };
  } catch (e) {
    facts.archiveAll = { error: e.message };
    console.error(`[setup] archive all failed: ${e.message}`);
    return;
  }
  await refreshInbox((w) => (window.__MAIL_STORE__?.getState?.().archivedEmailIds?.size ?? 0) >= w, 'everything archived', 2800);
  facts.archiveAll.indexChipGone = await waitPage(() => !document.querySelector('[data-testid="search-index-chip"]'), { timeout: 240000, interval: 1000 });
  facts.archiveAll.seconds = Number(since(t0));
  facts.archiveAll.archived = await archivedCount();
  facts.archiveAll.bubble = await dismissBulkBubble();
  await openWorkInbox();
  await quiet({ timeout: 20000 });
  console.log(`[setup] archived everything in ${since(t0)} s: ${JSON.stringify(facts.archiveAll)}`);
}

/**
 * The search index goes on working after the archive's own chip check (a
 * rebuild pass shows "Indexing N%" again a few seconds later). Settled = no
 * chip for 8 s in a row, up to 5 min. The board and the views read the index.
 */
async function indexSettled() {
  const t0 = Date.now();
  let clearSince = Date.now();
  while (Date.now() - t0 < 300000) {
    const chip = await browser.execute(() => !!document.querySelector('[data-testid="search-index-chip"]'));
    if (chip) clearSince = Date.now();
    else if (Date.now() - clearSince > 8000) break;
    await browser.pause(1000);
  }
  console.log(`[setup] index settled after ${since(t0)} s`);
  return Number(since(t0));
}

// ── Take plumbing ───────────────────────────────────────────────────────────

/** Tag the smallest element under `root` containing `needle`, for a Take to click by selector. */
function markSmallest(root, needle, tag) {
  return browser.execute((r, n, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const hit = [...document.querySelectorAll(`${r} *`)]
      .filter((el) => el.offsetHeight > 30 && (el.innerText || '').includes(n))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    if (!hit) return false;
    hit.setAttribute('data-footage-target', t);
    return true;
  }, root, needle, tag);
}

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  return rec;
}

/** What resetView() does not close: the Notes board and an open saved view. */
async function closeBoardAndView() {
  await browser.execute(() => {
    document.querySelector('[data-testid="notes-close"]')?.click();
  });
  await browser.pause(400);
  await browser.execute(() => {
    document.querySelector('.sidebar-view-list .sidebar-view-row.is-active')?.click();
  });
  await browser.pause(400);
}

/** One clip: back to the plain inbox, wait for a quiet frame, record `body`. */
async function shoot(ctx, clip, body, { prepare } = {}) {
  if (!want(clip)) ctx.skip();
  await closeBoardAndView();
  await resetView();
  if (prepare) await prepare();
  await beforeTake(clip);
  const take = new Take(clip);
  await take.start();
  try {
    await body(take);
    return await finish(take, clip);
  } catch (e) {
    await take.abort();
    throw e;
  }
}

/** Escape on the document: closes an open wheel or popover (setup only). */
const pressEscape = () => browser.execute(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
});

/** Settings > Appearance > the tab named `tabLabel`, by real clicks. */
async function toAppearanceTab(take, tabLabel, tabName, ready) {
  await take.click('[data-testid="open-settings"]', 'settings');
  await take.waitFor(settingsOpen, 'settings', 8000);
  await take.hold(900);
  await take.click('[data-testid="settings-page"] .settings-nav-item', 'appearance', { text: L('settings.appearance.appearance') });
  await take.waitFor((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
    .some((b) => (b.innerText || '').includes(t)), 'appearance tabs', 8000, tabLabel);
  await take.hold(700);
  await take.click('[data-testid="settings-page"] [role="tab"]', tabName, { text: tabLabel });
  await take.waitFor(ready, `${tabName} page`, 8000);
}

const CLOSE_SETTINGS = `[data-testid="settings-page"] button[aria-label="${L('common.close')}"]`;

/** One daemon RPC from the page (setup only): the same channel the app's daemonCall uses. */
function rpc(method, params) {
  return browser.executeAsync((m, p, done) => {
    const inv = window.__TAURI_INTERNALS__?.invoke;
    if (!inv) { done({ error: 'no invoke' }); return; }
    inv('daemon_rpc', { method: m, params: p }).then((v) => done({ ok: v ?? null }), (e) => done({ error: String(e?.message || e) }));
  }, method, params);
}

/**
 * A native <select> or text input set the way React hears it (value setter,
 * then input + change). Inside a take the cursor travels there first, so the
 * change reads as a click on the control; the native menu itself never draws.
 */
async function setControl(take, selector, value, label) {
  if (take) await take.moveTo(selector, label);
  const r = await browser.execute((s, v) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.offsetHeight > 0);
    if (!el) return { error: `no visible ${s}` };
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: el.value };
  }, selector, value);
  if (r.error) throw new Error(`${label}: ${r.error}`);
  if (take) take.note(`set-${label}`, { value, at: Number(take.t(Date.now()).toFixed(3)) });
  return r;
}

// Custom fields for c08, created through the daemon (the same `fields.save`
// the Fields settings page sends) with fixed ids, so the take can name them.
const PRIORITY = 'ph-priority';
const OWNER = 'ph-owner';

/** Delete c08's saved view and custom fields through the Settings pages (setup only). */
async function removeViewAndFields(viewName) {
  const out = {};
  await closeBoardAndView();
  await resetView();
  await clickSel('[data-testid="view-edit"]');
  await waitPage(settingsOpen, { timeout: 8000 });
  await browser.pause(700);
  out.viewRow = await browser.execute((n) => {
    const row = [...document.querySelectorAll('[data-testid^="views-row-"]')].find((b) => (b.innerText || '').includes(n));
    if (!row) return false;
    row.click();
    return true;
  }, viewName);
  await browser.pause(700);
  if (out.viewRow) {
    out.deleteClicked = await clickSel('[data-testid="view-delete"]');
    await browser.pause(600);
    out.confirmed = await browser.execute((label) => {
      const btn = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')]
        .reverse().find((b) => (b.textContent || '').trim() === label && b.offsetHeight > 0);
      if (!btn) return false;
      btn.click();
      return true;
    }, L('views.deleteConfirm'));
    await browser.pause(1000);
    out.viewGone = await browser.execute((n) => ![...document.querySelectorAll('.sidebar-view-row')].some((r) => (r.innerText || '').includes(n)), viewName);
  }
  await clickSel('[data-testid="settings-page"] .settings-nav-item', L('settings.navigation.mailPreferences'));
  await browser.pause(700);
  await clickSel('[data-testid="settings-page"] [role="tab"]', L('fields.section'));
  await waitPage((s) => !!document.querySelector(s), { timeout: 8000 }, `[data-testid="field-row-${PRIORITY}"]`);
  for (const id of [PRIORITY, OWNER]) {
    await clickSel(`[data-testid="field-delete-${id}"]`);
    await browser.pause(400);
    await clickSel(`[data-testid="field-delete-confirm-${id}"]`);
    await browser.pause(800);
  }
  out.fieldsGone = await browser.execute((a, b) => !document.querySelector(`[data-testid="field-row-${a}"], [data-testid="field-row-${b}"]`), PRIORITY, OWNER);
  await resetView();
  return out;
}

// ── c07 / c09 staging (setup only) ─────────────────────────────────────────

/** The app's data dir under the footage HOME (macOS layout; the mini is the only runner). */
const appDir = () => join(process.env.FOOTAGE_DATA_DIR || process.env.HOME, 'Library/Application Support/com.mailvault.app');

const accountEmail = (id) => {
  try {
    return JSON.parse(readFileSync(join(appDir(), 'accounts.json'), 'utf8')).find((a) => a.id === id)?.email || null;
  } catch { return null; }
};

/** SQL against the daemon's app.db (WAL) from a second connection: sqlite3 CLI, else node:sqlite. */
async function appDbSql(sql) {
  const db = join(appDir(), 'app.db');
  try {
    return execFileSync('sqlite3', ['-cmd', '.timeout 8000', db, sql], { encoding: 'utf8' }).trim();
  } catch (e) {
    console.warn(`[setup] sqlite3 CLI failed (${e.message}); trying node:sqlite`);
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(db);
    try {
      conn.exec('PRAGMA busy_timeout = 8000');
      const rows = [];
      for (const stmt of sql.split(';\n').map((s) => s.trim()).filter(Boolean)) {
        if (/^select/i.test(stmt)) rows.push(...conn.prepare(stmt).all().map((r) => Object.values(r).join('|')));
        else conn.exec(stmt);
      }
      return rows.join('\n');
    } finally { conn.close(); }
  }
}

/**
 * c07: demo traffic for the three demo accounts over the last 23 hours, in
 * arrival order (the page lists by id). Hosts are invented for the fictional
 * studio and the personal domain, plus github.com (the real update-check and release-notes hosts).
 * minutes ago, protocol, host, port, purpose, account index (null = none), country, process
 */
const NET_PLAN = [
  [2, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'], [18, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'],
  [47, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'], [95, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'],
  [160, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'], [250, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'],
  [380, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'], [540, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'],
  [720, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'], [960, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'],
  [1210, 'imap', 'imap.primecut.studio', 993, 'sync', 0, 'DE'],
  [6, 'imap', 'imap.primecut.studio', 993, 'open message', 0, 'DE'], [33, 'imap', 'imap.primecut.studio', 993, 'open message', 0, 'DE'],
  [140, 'imap', 'imap.primecut.studio', 993, 'open message', 0, 'DE'], [610, 'imap', 'imap.primecut.studio', 993, 'open message', 0, 'DE'],
  [12, 'smtp', 'smtp.primecut.studio', 587, 'send', 0, 'DE'], [300, 'smtp', 'smtp.primecut.studio', 587, 'send', 0, 'DE'],
  [4, 'imap', 'mail.marshfamily.me', 993, 'sync', 1, 'IE'], [52, 'imap', 'mail.marshfamily.me', 993, 'sync', 1, 'IE'],
  [170, 'imap', 'mail.marshfamily.me', 993, 'sync', 1, 'IE'], [420, 'imap', 'mail.marshfamily.me', 993, 'sync', 1, 'IE'],
  [800, 'imap', 'mail.marshfamily.me', 993, 'sync', 1, 'IE'], [1300, 'imap', 'mail.marshfamily.me', 993, 'sync', 1, 'IE'],
  [75, 'smtp', 'mail.marshfamily.me', 465, 'send', 1, 'IE'],
  [61, 'imap', 'mail.marshfamily.me', 993, 'open message', 1, 'IE'], [1020, 'imap', 'mail.marshfamily.me', 993, 'sync', 1, 'IE'],
  [9, 'imap', 'mx2.primecut.studio', 993, 'sync', 2, 'NL'], [130, 'imap', 'mx2.primecut.studio', 993, 'sync', 2, 'NL'],
  [500, 'imap', 'mx2.primecut.studio', 993, 'sync', 2, 'NL'], [1100, 'imap', 'mx2.primecut.studio', 993, 'sync', 2, 'NL'],
  [25, 'https', 'github.com', 443, 'update check', null, 'US', 'app'], [1230, 'https', 'github.com', 443, 'update check', null, 'US', 'app'],
  [24, 'https', 'api.github.com', 443, 'release notes', null, 'US'],
  [200, 'https', 'lists.pressepapier.fr', 443, 'unsubscribe', 0, 'FR'],
  [640, 'https', 'mail.rackandrind.co.uk', 443, 'unsubscribe', 0, 'GB'],
];

async function seedNetActivity() {
  const accounts = (() => {
    try { return JSON.parse(readFileSync(join(appDir(), 'accounts.json'), 'utf8')).map((a) => a.email); } catch { return []; }
  })();
  // Deterministic "random" sizes, so a re-take shows the same numbers.
  let seed = 7;
  const rnd = (lo, hi) => { seed = (seed * 16807) % 2147483647; return lo + (seed % (hi - lo + 1)); };
  const now = Date.now();
  const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const rows = NET_PLAN.map(([ago, protocol, host, port, purpose, acct, country, proc]) => {
    const size = {
      sync: [rnd(900, 3200), rnd(6000, 96000), rnd(300, 2400), rnd(6, 22)],
      'open message': [rnd(300, 900), rnd(38000, 420000), rnd(250, 1300), rnd(3, 6)],
      send: [rnd(24000, 210000), rnd(700, 1600), rnd(500, 1800), rnd(7, 11)],
      'sign-in': [rnd(1200, 2200), rnd(2500, 5200), rnd(180, 520), null],
      'update check': [rnd(500, 900), rnd(1800, 4200), rnd(160, 480), null],
      'release notes': [rnd(500, 900), rnd(9000, 22000), rnd(200, 600), null],
      unsubscribe: [rnd(600, 1400), rnd(1500, 6000), rnd(220, 900), null],
    }[purpose];
    const commands = protocol === 'imap' || protocol === 'smtp' ? size[3] : null;
    return [now - ago * 60000 - rnd(0, 50) * 1000, 'out', proc || 'helper', protocol, host, null, port, purpose,
      acct === null ? null : (accounts[acct] || null), size[0], size[1], size[2], 'ok', commands, country];
  }).sort((a, b) => a[0] - b[0]);
  const before = await appDbSql("SELECT host || ' ' || IFNULL(country,'-') || ' ' || COUNT(*) FROM net_events GROUP BY host, country;\n");
  // The page lists by id (arrival): the real rows so far (the app's own
  // connectivity probes) and the demo rows go back in start-time order, so the
  // table reads newest first. The real rows keep every value but their id.
  const cols = 'at_ms, direction, process, protocol, host, ip, port, purpose, account, bytes_up, bytes_down, duration_ms, result, commands, country';
  const sql = [
    'BEGIN IMMEDIATE',
    `CREATE TEMP TABLE stage AS SELECT ${cols} FROM net_events`,
    ...rows.map((r) => `INSERT INTO stage(${cols}) VALUES (${r.map(q).join(', ')})`),
    'DELETE FROM net_events',
    `INSERT INTO net_events(${cols}) SELECT ${cols} FROM stage ORDER BY at_ms`,
    'DROP TABLE stage',
    'COMMIT',
    "SELECT COUNT(*) || ' rows, ' || COUNT(DISTINCT country) || ' countries' FROM net_events",
  ].join(';\n');
  const after = await appDbSql(`${sql};\n`);
  facts.c07Seed = { before: before.split('\n'), inserted: rows.length, after, accounts };
  console.log(`[setup] net_events seeded: ${JSON.stringify(facts.c07Seed)}`);
}

/**
 * c09: three backdated snapshots of the work account. A real snapshot of the
 * vault is taken through the daemon, read and removed; each staged file keeps
 * its mailbox keys, uids, flags and sizes for the mail dated before its stamp,
 * with subject, sender and date left empty exactly as the daemon writes them
 * (the page reads them from the vault by uid); the store's dates only decide
 * which uids each stamp holds. Same names and format as snapshot.rs.
 */
async function stageSnapshots() {
  const accountId = await browser.execute(() => window.__MAIL_STORE__?.getState?.().activeAccountId);
  const email = accountEmail(accountId);
  if (!accountId || !email) throw new Error(`c09: no account (${accountId}, ${email})`);
  const made = await rpc('snapshot.create_from_maildir', { accountId, accountEmail: email });
  const dir = join(appDir(), 'snapshots', accountId);
  if (made.error) throw new Error(`c09: real snapshot failed: ${JSON.stringify(made)}`);
  const realName = made.ok?.filename || made.ok?.info?.filename
    || readdirSync(dir).filter((f) => f.endsWith('.json.gz')).sort().at(-1);
  if (!realName) throw new Error(`c09: no snapshot file after create: ${JSON.stringify(made)}`);
  facts.c09RealCreate = { response: made, file: realName, before: readdirSync(dir) };
  const realPath = join(dir, realName);
  const real = JSON.parse(gunzipSync(readFileSync(realPath)).toString('utf8'));
  unlinkSync(realPath);
  const meta = await browser.execute((acct) => {
    const st = window.__MAIL_STORE__?.getState?.() || {};
    const out = {};
    for (const e of [...(st.emails || []), ...(st.sortedEmails || [])]) {
      if (!e || e.uid == null || out[e.uid]) continue;
      if (e.accountId && e.accountId !== acct) continue;
      const f = e.from;
      const from = typeof f === 'string' ? f : f ? (f.name ? `${f.name} <${f.address || ''}>` : (f.address || '')) : '';
      const ms = new Date(e.date || e.internalDate || 0).getTime();
      out[e.uid] = { subject: e.subject || '', from, ms, messageId: e.messageId || e.message_id || null };
    }
    return out;
  }, accountId);
  const p2 = (n) => String(n).padStart(2, '0');
  const staged = [];
  for (const [daysAgo, hour, minute] of [[6, 8, 12], [27, 9, 3], [58, 7, 41]]) {
    const at = new Date(Date.now() - daysAgo * 86400000);
    at.setUTCHours(hour, minute, 17, 0);
    const iso = at.toISOString();
    const mailboxes = {};
    for (const [name, mb] of Object.entries(real.mailboxes || {})) {
      const emails = mb.emails
        .filter((e) => meta[e.uid] && meta[e.uid].ms > 0 && meta[e.uid].ms <= at.getTime())
        .map((e) => ({ uid: e.uid, subject: '', from: '', date: '', flags: e.flags, size: e.size }));
      if (emails.length) mailboxes[name] = { total_emails: emails.length, emails };
    }
    const manifest = { account_id: accountId, account_email: email, timestamp: iso.replace('Z', '+00:00'), mailboxes };
    const filename = `${at.getUTCFullYear()}-${p2(at.getUTCMonth() + 1)}-${p2(at.getUTCDate())}T${p2(at.getUTCHours())}-${p2(at.getUTCMinutes())}-${p2(at.getUTCSeconds())}.000Z.json.gz`;
    writeFileSync(join(dir, filename), gzipSync(Buffer.from(JSON.stringify(manifest))));
    staged.push({ filename, timestamp: manifest.timestamp, mailboxes: Object.fromEntries(Object.entries(mailboxes).map(([k, v]) => [k, v.total_emails])) });
  }
  facts.c09Staged = {
    accountId, realMailboxes: Object.fromEntries(Object.entries(real.mailboxes || {}).map(([k, v]) => [k, v.total_emails])),
    storeRows: Object.keys(meta).length,
    storeRows90d: Object.values(meta).filter((m) => m.ms > Date.now() - 90 * 86400000).length,
    realUidsWithMeta: Object.values(real.mailboxes || {}).reduce((n, mb) => n + mb.emails.filter((e) => meta[e.uid]).length, 0),
    staged,
  };
  console.log(`[setup] snapshots staged: ${JSON.stringify(facts.c09Staged)}`);
}

/** Settings > `navLabel` (> `tabLabel`), by real clicks; `ready` is the page predicate. */
async function toSettingsPage(take, navLabel, tabLabel, ready, what, ...args) {
  await take.click('[data-testid="open-settings"]', 'settings');
  await take.waitFor(settingsOpen, 'settings', 8000);
  await take.hold(800);
  await take.reveal('[data-testid="settings-page"] .settings-nav-item', 'nav-reveal', { text: navLabel, ms: 700 });
  await take.hold(300);
  await take.click('[data-testid="settings-page"] .settings-nav-item', 'nav', { text: navLabel });
  if (tabLabel) {
    await take.waitFor((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
      .some((b) => (b.innerText || '').trim() === t), `${what} tab`, 8000, tabLabel);
    await take.hold(600);
    await take.click('[data-testid="settings-page"] [role="tab"]', 'tab', { text: tabLabel });
  }
  await take.waitFor(ready, what, 15000, ...args);
}

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: Product Hunt tier 1', function () {
  this.timeout(1800000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    try { await seedVaultStates(); } catch (e) { console.error(`[setup] vault states NOT seeded: ${e.message}`); facts.seedError = e.message; }
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-tier1.facts.json'), JSON.stringify(facts, null, 2));
  });

  // 1. Custody icons.
  it('c01-custody', async function () {
    // Only the legend's "Server only" entry is hovered: the app's own tooltip
    // copy for "In your vault" and "Only copy" in the legend carries an em
    // dash (list.copyDiskAlsoShownWhen, list.confirmedGoneServerNothingElse).
    // The row icons' tooltips say the same without one.
    const legend = (s) => `[data-testid="legend-state-icon"][data-state="${s}"]`;
    const rowIcon = (s) => `[data-testid="email-row"] [data-testid="msg-state-icon"][data-state^="${s}"]`;
    const onlyCopyRow = '[data-testid="email-row"]:has([data-state^="local-only"])';
    await shoot(this, 'c01-custody', async (take) => {
      await take.hold(2000);
      await take.hover(legend('legend-server'), 'legend-server');
      await take.hold(2400);
      await take.hover(rowIcon('server'), 'blue-row-icon');
      await take.hold(2300);
      await take.hover(rowIcon('archived'), 'green-row-icon');
      await take.hold(2300);
      await take.hover(rowIcon('local-only'), 'gold-row-icon');
      await take.hold(2600);
      await take.unhover();
      await take.scrollEase(SEL.row, 640, 'list-down', { ms: 4200 });
      await take.hold(1300);
      await take.scrollEase(SEL.row, -640, 'list-up', { ms: 3000 });
      await take.hold(700);
      await take.click(onlyCopyRow, 'only-copy-row');
      await take.waitFor(readerOpen, 'only-copy message to open', 10000, L('viewer.selectEmailRead'));
      await take.hold(4200);
    }, {
      prepare: async () => {
        facts.c01RowStates = await browser.execute(rowStates);
        if (!(await browser.execute((s) => !!document.querySelector(s), onlyCopyRow))) {
          throw new Error(`no only-copy row on screen (row states ${JSON.stringify(facts.c01RowStates)})`);
        }
      },
    });
    facts.c01Opened = await browser.execute((only) => document.body.innerText.includes(only), L('email.state.onlyCopy'));
  });

  // 4. Radial quick-action wheel.
  it('c04-radial', async function () {
    const wedge = (a) => `.quick-action-radial-item[data-quick-action="${a}"] .quick-action-radial-content`;
    const handle = (name) => `.quick-actions-entry-list .account-settings-drag-handle[aria-label="${L('quickActions.reorder').replace('{{name}}', name)}"]`;
    const star = L('rowMenu.star');
    const entryNames = () => browser.execute(() => [...document.querySelectorAll('.quick-actions-entry-list .quick-actions-entry-name')]
      .map((e) => (e.textContent || '').trim()));
    const wheelOpen = () => [...document.querySelectorAll('.quick-action-radial-item')].some((b) => b.getBoundingClientRect().width > 0);
    await shoot(this, 'c04-radial', async (take) => {
      await take.hold(1500);
      // Button-down opens the wheel under the pointer (useMenuAtPointer).
      await take.rightClick('[data-footage-target="wheel-row"]', 'row-right-click');
      await take.waitFor(wheelOpen, 'wheel', 5000);
      await take.hold(1500);
      const act = (await browser.execute((s) => !!document.querySelector(s), wedge('star'))) ? 'star' : 'unstar';
      facts.c04Action = act;
      await take.hover(wedge(act), `wedge-${act}`);
      await take.hold(1100);
      await take.click(wedge(act), `wedge-${act}`, { dur: 250 });
      await take.hold(2000);
      // The wheel is built from the presets in Settings > Appearance > Quick actions.
      await toAppearanceTab(take, L('quickActions.title'), 'quick-actions-tab',
        () => !!document.querySelector('.quick-actions-settings')?.offsetHeight);
      await take.hold(1200);
      const rowsTab = await browser.execute((t) => [...document.querySelectorAll('.quick-actions-settings [role="tab"]')]
        .find((b) => (b.innerText || '').includes(t))?.getAttribute('aria-selected'), L('quickActions.surface.row'));
      if (rowsTab !== 'true') {
        await take.click('.quick-actions-settings [role="tab"]', 'surface-rows', { text: L('quickActions.surface.row') });
        await take.hold(800);
      }
      await take.click('.quick-actions-presets .choice-card-button', 'preset-gmail', { text: L('quickActions.preset.gmail') });
      await take.hold(2300);
      await take.click('.quick-actions-presets .choice-card-button', 'preset-mailvault', { text: L('quickActions.preset.mailvault') });
      await take.hold(1500);
      await take.reveal('.quick-actions-entry-list li:nth-child(3)', 'entry-list', { ms: 1100 });
      await take.hold(600);
      facts.c04OrderBefore = await entryNames();
      const dy = await browser.execute((from) => {
        const first = document.querySelector('.quick-actions-entry-list li');
        const h = document.querySelector(from);
        if (!first || !h) return null;
        const f = first.getBoundingClientRect(); const r = h.getBoundingClientRect();
        return (f.top + f.height / 2 - 8) - (r.top + r.height / 2);
      }, handle(star));
      if (dy == null) throw new Error('no Star entry in the action list');
      const d = await take.drag(handle(star), 0, dy, 'drag-star', { ms: 1500 });
      facts.c04DragCaptureError = d.captureError;
      await take.hold(400);
      facts.c04OrderAfterDrag = await entryNames();
      if (facts.c04OrderAfterDrag[0] !== star) {
        // The synthetic drag did not commit: the handle's keyboard move (Home)
        // commits the same order. Recorded, so the footage is judged knowing it.
        facts.c04DragFallback = true;
        take.note('dragFallback', 'pointer drag did not commit; the order was set with the handle\'s Home key');
        await browser.execute((s) => {
          const h = document.querySelector(s);
          h?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', code: 'Home', bubbles: true, cancelable: true }));
        }, handle(star));
        await take.hold(400);
        facts.c04OrderAfterFallback = await entryNames();
      }
      await take.hold(1800);
      // Back to the list: the wheel now opens with Star first.
      await take.click(CLOSE_SETTINGS, 'close-settings');
      await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 8000);
      await take.hold(900);
      await take.rightClick('[data-footage-target="wheel-row-2"]', 'row-right-click-2');
      await take.waitFor(wheelOpen, 'wheel again', 5000);
      await take.hold(2600);
    }, {
      prepare: async () => {
        const ok = await browser.execute(() => {
          document.querySelectorAll('[data-footage-target^="wheel-row"]').forEach((el) => el.removeAttribute('data-footage-target'));
          const rows = [...document.querySelectorAll('[data-testid="email-row"]')].filter((r) => r.getBoundingClientRect().height > 0);
          if (rows.length < 8) return false;
          rows[4].setAttribute('data-footage-target', 'wheel-row');
          rows[6].setAttribute('data-footage-target', 'wheel-row-2');
          return true;
        });
        if (!ok) throw new Error('fewer than 8 rows on screen');
      },
    });
    await pressEscape();
    await browser.pause(400);
  });

  // 6. Notes to Self. Needs FOOTAGE_EXTRA_MAIL=1: nine owner-to-owner notes in
  // the work INBOX (lib/mailbox.js). The board reads the search index, which
  // holds vault mail only, so everything is archived first.
  it('c06-notes-board', async function () {
    const card = (subject) => `[data-testid="note-card"][aria-label="${subject}"]`;
    await shoot(this, 'c06-notes-board', async (take) => {
      await take.hold(1500);
      await take.click('[data-testid="open-notes"]', 'open-notes');
      await take.waitFor(() => document.querySelectorAll('[data-testid="note-card"]').length >= 8
        && !!document.querySelector('[data-testid="note-thumb"]'), 'note cards with the photo', 30000);
      facts.c06Board = await browser.execute(() => {
        const cols = document.querySelector('[data-testid="notes-columns"]');
        const side = document.querySelector('aside, .sidebar, [data-testid="sidebar"]');
        return {
          columns: [...document.querySelectorAll('[data-testid="notes-column"]')].map((c) => `${c.dataset.column}:${c.querySelectorAll('[data-testid="note-card"]').length}`),
          clientWidth: cols?.clientWidth, scrollWidth: cols?.scrollWidth, sidebarWidth: side?.getBoundingClientRect().width ?? null,
          cards: [...document.querySelectorAll('[data-testid="note-card"]')].map((c) => c.getAttribute('aria-label')),
        };
      });
      console.log(`[c06] board: ${JSON.stringify(facts.c06Board)}`);
      await take.hold(3200);
      await take.hover(card('miso butter'), 'miso-card');
      await take.hold(1200);
      await take.click(card('miso butter'), 'open-miso');
      await take.waitFor(() => !!document.querySelector('[data-testid="notes-reader-star"]')
        && (document.querySelector('[data-testid="notes-reader"]')?.innerText || '').includes('white miso'), 'note in the reader', 15000);
      await take.hold(3000);
      await take.click('[data-testid="notes-reader-star"]', 'star');
      await take.waitFor(() => document.querySelector('[data-testid="notes-reader-star"]')?.getAttribute('aria-pressed') === 'true', 'starred', 10000);
      await take.hold(2400);
      const doneBtn = `${card('moodboard wall in the studio')} [data-testid="note-done"]`;
      await take.hover(card('moodboard wall in the studio'), 'moodboard-card');
      await take.hold(900);
      await take.click(doneBtn, 'mark-done');
      await take.waitFor((s) => !document.querySelector(s), 'done card off the board', 10000, card('moodboard wall in the studio'));
      await take.hold(2600);
      // The reader closes; the filter narrows every column at once.
      await take.click('[data-testid="notes-reader"] [data-testid="close-viewer"]', 'close-reader');
      await take.waitFor(() => !document.querySelector('[data-testid="notes-reader"]'), 'reader closed', 8000);
      await take.hold(1500);
      await take.click('[data-testid="notes-filter"]', 'filter');
      await take.type('[data-testid="notes-filter"]', 'brisket', 'filter-text');
      await take.waitFor(() => document.querySelectorAll('[data-testid="note-card"]').length < 8, 'filtered board', 8000);
      await take.hold(3400);
      facts.c06After = await browser.execute(() => ({
        columns: [...document.querySelectorAll('[data-testid="notes-column"]')].map((c) => `${c.dataset.column}:${c.querySelectorAll('[data-testid="note-card"]').length}`),
        starred: [...document.querySelectorAll('[data-testid="note-card"][data-starred="true"]')].map((c) => c.getAttribute('aria-label')),
      }));
    }, {
      prepare: async () => {
        await archiveEverything();
        facts.c06IndexWait = await indexSettled();
      },
    });
  });

  // 7. Network Activity. STAGED rows (seedNetActivity): the page, map and
  // filters are real and read them from app.db. Range and purpose are native
  // selects (set as React hears them, the cursor travels there first).
  it('c07-network-activity', async function () {
    const page = '[data-testid="network-activity"]';
    const sel = (label) => `${page} select[aria-label="${label}"]`;
    const de = '[data-testid="net-map"] path[data-country="DE"]';
    await shoot(this, 'c07-network-activity', async (take) => {
      await take.hold(1000);
      await toSettingsPage(take, L('settings.tab.privacySecurity'), L('settings.tab.networkActivity'),
        () => document.querySelectorAll('[data-testid="net-row"]').length >= 20
          && document.querySelectorAll('[data-testid="net-map-country"]').length >= 4, 'network activity');
      facts.c07Open = await browser.execute(() => ({
        hosts: document.querySelector('[data-testid="net-summary-hosts"]')?.innerText,
        sent: document.querySelector('[data-testid="net-summary-sent"]')?.innerText,
        received: document.querySelector('[data-testid="net-summary-received"]')?.innerText,
        rows: document.querySelectorAll('[data-testid="net-row"]').length,
        countries: [...document.querySelectorAll('[data-testid="net-map-country"]')].map((b) => b.innerText.replace(/\s+/g, ' ')),
        local: !!document.querySelector('[data-testid="net-map-local"]'),
      }));
      await take.hold(2600);
      await setControl(take, sel(L('netActivity.range')), 'hour', 'range-hour');
      await take.waitFor((n) => document.querySelectorAll('[data-testid="net-row"]').length < n, 'last hour rows', 8000, facts.c07Open.rows);
      await take.hold(2400);
      await setControl(take, sel(L('netActivity.range')), 'day', 'range-day');
      await take.waitFor((n) => document.querySelectorAll('[data-testid="net-row"]').length >= n, 'day rows', 8000, facts.c07Open.rows);
      await take.hold(1200);
      await take.hover(de, 'map-germany');
      facts.c07Tooltip = await waitPage(() => (document.querySelector('[data-testid="net-map-tooltip"]')?.innerText || ''), { timeout: 3000 })
        && await browser.execute(() => document.querySelector('[data-testid="net-map-tooltip"]')?.innerText || '');
      await take.hold(2400);
      await take.click(de, 'map-germany-click');
      await take.unhover();
      await take.waitFor(() => !!document.querySelector('[data-testid="net-country-filter"]'), 'country filter', 8000);
      await take.waitFor(() => [...document.querySelectorAll('[data-testid="net-row"]')].every((r) => (r.dataset.host || '').endsWith('primecut.studio')), 'germany rows', 8000);
      await take.hold(1200);
      // Down to the filters and the table (the chip sits above it).
      const dy = await browser.execute(() => {
        const chip = document.querySelector('[data-testid="net-country-filter"]');
        let sc = chip?.parentElement;
        while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        if (!chip || !sc) return 0;
        return Math.round(chip.getBoundingClientRect().top - sc.getBoundingClientRect().top - 140);
      });
      if (dy > 4) await take.scrollEase('[data-testid="net-summary"]', dy, 'to-table', { ms: 1300 });
      await take.hold(2200);
      await take.click('[data-testid="net-country-filter"] button', 'clear-country');
      await take.waitFor(() => !document.querySelector('[data-testid="net-country-filter"]'), 'filter cleared', 8000);
      await take.hold(1300);
      await setControl(take, sel(L('netActivity.purpose')), 'sync', 'purpose-sync');
      await take.hold(2400);
      await setControl(take, sel(L('netActivity.purpose')), '', 'purpose-all');
      await take.hold(1000);
      await take.scrollEase('[data-testid="net-row"]', 420, 'rows', { ms: 2600 });
      await take.hold(1800);
      facts.c07End = await browser.execute(() => ({
        rows: document.querySelectorAll('[data-testid="net-row"]').length,
        hosts: [...new Set([...document.querySelectorAll('[data-testid="net-row"]')].map((r) => r.dataset.host))],
      }));
    }, {
      prepare: async () => {
        await seedNetActivity();
      },
    });
  });

  // 8. Saved Views + custom fields. The fields are made in setup through the
  // daemon; the take opens the three built-in views, sets Priority and Owner
  // on a message in the reader's field strip, builds a view in Settings > Views
  // (Priority is set, grouped by sender then by Priority) and opens it.
  it('c08-views-fields', async function () {
    const viewName = 'Priority mail';
    await shoot(this, 'c08-views-fields', async (take) => {
      const rowsShown = () => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => r.getBoundingClientRect().height > 0);
      await take.hold(1200);
      for (const id of ['needs-reply', 'starred', 'attachments']) {
        await take.click(`[data-testid="view-row-builtin-${id}"]`, `view-${id}`);
        await take.waitFor(rowsShown, `${id} rows`, 15000);
        await take.hold(id === 'attachments' ? 1500 : 2100);
      }
      facts.c08Counts = await browser.execute(() => [...document.querySelectorAll('.sidebar-view-row')].map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()));
      // A client's mail with a PDF, not the "only copy" invoice at the top or one of the notes.
      const pick = await browser.execute((s) => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.innerText || '').includes(s)), 'Specimen PDFs attached');
      if (pick) await take.click(SEL.row, 'attachment-row', { text: 'Specimen PDFs attached' });
      else await take.click('[data-testid="email-row"]:not(:has([data-state^="local-only"]))', 'attachment-row');
      facts.c08PickedSpecimen = pick;
      await take.waitFor((s) => !!document.querySelector(s), 'field strip', 15000, `[data-testid="field-input-${PRIORITY}"]`);
      await take.hold(1400);
      await setControl(take, `[data-testid="field-input-${PRIORITY}"]`, 'high', 'priority-high');
      await take.hold(900);
      await take.click(`[data-testid="field-input-${OWNER}"]`, 'owner');
      await take.type(`[data-testid="field-input-${OWNER}"]`, 'Rowan', 'owner-text');
      await browser.execute((s) => document.querySelector(s)?.blur(), `[data-testid="field-input-${OWNER}"]`);
      await take.hold(1600);
      // The + beside Views: Settings > Views with a new view in the editor.
      await take.click('[data-testid="view-new"]', 'new-view');
      await take.waitFor(() => !!document.querySelector('[data-testid="view-editor-form"]'), 'view editor', 10000);
      await take.hold(900);
      await setControl(null, '[data-testid="view-name"]', '', 'name-clear');
      await take.click('[data-testid="view-name"]', 'name');
      await take.type('[data-testid="view-name"]', viewName, 'view-name');
      await take.hold(700);
      await take.reveal(`[data-testid="view-field-op-${PRIORITY}"]`, 'field-filter', { ms: 1100 });
      await setControl(take, `[data-testid="view-field-op-${PRIORITY}"]`, 'isSet', 'priority-is-set');
      await take.hold(1000);
      await take.reveal('[data-testid="view-group"]', 'group-by', { ms: 800 });
      await setControl(take, '[data-testid="view-group"]', 'sender', 'group-sender');
      await take.hold(1500);
      await setControl(take, '[data-testid="view-group"]', `field:${PRIORITY}`, 'group-priority');
      await take.hold(1300);
      facts.c08Preview = await browser.execute(() => (document.querySelector('.view-editor')?.innerText || '').replace(/\s+/g, ' ').slice(-600));
      await take.click('[data-testid="view-editor-form"] button[type="submit"]', 'save');
      await take.hold(1000);
      await take.click(CLOSE_SETTINGS, 'close-settings');
      await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 8000);
      await take.click('.sidebar-view-list .sidebar-view-row', 'open-new-view', { text: viewName });
      // Grouped by a field, the view opens in Explorer: one group per value.
      await take.waitFor(() => document.querySelectorAll('[data-testid="explorer-group-row"]').length > 0, 'view groups', 15000);
      await take.hold(2400);
      await take.click('[data-testid="explorer-group-row"][data-label="High"] [data-testid="explorer-group-open"]', 'group-high');
      await take.waitFor(rowsShown, 'High rows', 10000);
      await take.hold(3200);
      facts.c08View = await browser.execute(() => ({
        rows: document.querySelectorAll('[data-testid="email-row"]').length,
        text: (document.querySelector('main, [data-testid="mail-list"]')?.innerText || document.body.innerText).replace(/\s+/g, ' ').slice(0, 700),
      }));
    }, {
      prepare: async () => {
        await archiveEverything();
        const accountId = await browser.execute(() => window.__MAIL_STORE__?.getState?.().activeAccountId);
        const saved = [];
        saved.push(await rpc('fields.save', { field: { id: PRIORITY, scope: accountId, name: 'Priority', kind: 'select', position: 0,
          options: [{ id: 'high', label: 'High', color: '#dc2626' }, { id: 'normal', label: 'Normal', color: '#d97706' }, { id: 'low', label: 'Low', color: '#16a34a' }] } }));
        saved.push(await rpc('fields.save', { field: { id: OWNER, scope: accountId, name: 'Owner', kind: 'text', position: 1, options: [] } }));
        // A few inbox messages already carry a Priority, so the view has groups.
        const rows = await browser.execute(() => (window.__MAIL_STORE__?.getState?.().sortedEmails || [])
          .slice(0, 14).map((e) => ({ uid: e.uid, messageId: e.messageId || null, subject: e.subject })));
        const plan = ['high', 'normal', 'normal', 'low', 'high', 'normal'];
        const set = [];
        for (let i = 0; i < plan.length && i * 2 < rows.length; i++) {
          const e = rows[i * 2];
          const item = { accountId, mailbox: 'INBOX', uid: e.uid, ...(e.messageId ? { messageId: e.messageId } : {}) };
          set.push({ subject: e.subject, value: plan[i], r: await rpc('fields.set', { item, fieldId: PRIORITY, value: plan[i] }) });
        }
        facts.c08Seed = { accountId, saved, set };
        console.log(`[c08] fields seeded: ${JSON.stringify(facts.c08Seed)}`);
        // The app loads a schema once; the Fields page loads it again as it opens.
        await clickSel('[data-testid="open-settings"]');
        await waitPage(settingsOpen, { timeout: 8000 });
        await clickSel('[data-testid="settings-page"] .settings-nav-item', L('settings.navigation.mailPreferences'));
        await browser.pause(700);
        await clickSel('[data-testid="settings-page"] [role="tab"]', L('fields.section'));
        facts.c08SchemaLoaded = await waitPage((s) => !!document.querySelector(s), { timeout: 8000 }, `[data-testid="field-row-${PRIORITY}"]`);
        await browser.pause(600);
        await resetView();
      },
    });
    // Later clips must not show this clip's view in the sidebar or its fields
    // in the reader: both go again through Settings (untimed).
    try { facts.c08Cleanup = await removeViewAndFields(viewName); } catch (e) { facts.c08Cleanup = { error: e.message }; }
    console.log(`[c08] cleanup: ${JSON.stringify(facts.c08Cleanup)}`);
  });

  // 9. Time Capsule (Premium, seeded). The three older cards are STAGED files
  // (stageSnapshots); "Take Snapshot" in the take is real. The card list,
  // folder list, rows and read-only viewer are the app's.
  it('c09-time-capsule', async function () {
    const page = '[data-testid="settings-content"][data-page="time-capsule"]';
    const card = `${page} div[role="button"]`;
    const browserRows = '.snapshot-browser > .overflow-y-auto button';
    await shoot(this, 'c09-time-capsule', async (take) => {
      await take.hold(1000);
      await toSettingsPage(take, L('settings.tab.timeCapsule'), null,
        (c) => document.querySelectorAll(c).length >= 3, 'snapshot cards', card);
      facts.c09Cards = await browser.execute((c) => [...document.querySelectorAll(c)].map((el) => el.innerText.replace(/\s+/g, ' ')), card);
      await take.hold(3200);
      const n = facts.c09Cards.length;
      await take.click(`${page} button`, 'take-snapshot', { text: L('timeCapsule.takeSnapshot') });
      await take.waitFor((c, k) => document.querySelectorAll(c).length > k, 'new snapshot card', 30000, card, n);
      facts.c09CardsAfter = await browser.execute((c) => [...document.querySelectorAll(c)].map((el) => el.innerText.replace(/\s+/g, ' ')), card);
      await take.hold(2400);
      // The 27-day staged card: the staged three are always the oldest, so second from the end.
      await browser.execute((c) => {
        document.querySelectorAll('[data-footage-target="old-card"]').forEach((el) => el.removeAttribute('data-footage-target'));
        const cards = [...document.querySelectorAll(c)];
        (cards[cards.length - 2] || cards[0]).setAttribute('data-footage-target', 'old-card');
      }, card);
      await take.click('[data-footage-target="old-card"]', 'open-old-snapshot');
      await take.waitFor((r) => document.querySelectorAll(r).length > 3
        && [...document.querySelectorAll(r)].some((b) => !b.querySelector('.italic')), 'snapshot rows', 15000, browserRows);
      await take.hold(2800);
      // Browse the folder: down a screen and back (rows are in uid order, as the daemon writes them).
      await take.scrollEase(browserRows, 620, 'rows-down', { ms: 2600 });
      await take.waitFor((r) => [...document.querySelectorAll(r)].filter((b) => !b.querySelector('.italic')).length > 3, 'rows hydrated', 8000, browserRows);
      await take.hold(1600);
      await take.scrollEase(browserRows, -620, 'rows-up', { ms: 2000 });
      await take.hold(1000);
      // A message from someone else (the vault also holds notes to self), in view.
      const picked = await browser.execute((r) => {
        document.querySelectorAll('[data-footage-target="tc-row"]').forEach((el) => el.removeAttribute('data-footage-target'));
        const box = document.querySelector('.snapshot-browser > .overflow-y-auto').getBoundingClientRect();
        const rows = [...document.querySelectorAll(r)].filter((b) => {
          const q = b.getBoundingClientRect();
          const text = b.innerText || '';
          return q.top > box.top + 20 && q.bottom < box.bottom - 20 && !b.querySelector('.italic')
            && !text.includes('Rowan Marsh') && !text.trim().startsWith('#');
        });
        const row = rows.find((b) => (b.innerText || '').includes('Moodboard')) || rows[Math.min(2, rows.length - 1)];
        if (!row) return null;
        row.setAttribute('data-footage-target', 'tc-row');
        return row.innerText.replace(/\s+/g, ' ');
      }, browserRows);
      if (!picked) throw new Error('c09: no readable row in view');
      facts.c09Row = picked;
      await take.click('[data-footage-target="tc-row"]', 'open-row');
      await take.waitFor((ro) => !document.querySelector('.snapshot-browser')
        && (document.body.innerText || '').includes(ro), 'read-only viewer', 15000, L('timeCapsule.readOnly'));
      await take.hold(5200);
      facts.c09Viewer = await browser.execute((p) => (document.querySelector(p)?.innerText || '').slice(0, 300), page);
      await take.click(`${page} button[aria-label="${L('common.back')}"]`, 'back-to-folder');
      await take.waitFor(() => !!document.querySelector('.snapshot-browser'), 'folder again', 8000);
      await take.hold(1400);
      await take.click(`${page} button[aria-label="${L('common.back')}"]`, 'back-to-list');
      await take.waitFor((c) => document.querySelectorAll(c).length >= 4, 'card list again', 8000, card);
      await take.hold(2200);
    }, {
      prepare: async () => {
        await stageSnapshots();
      },
    });
  });

  // 10. Trackers. Needs FOOTAGE_EXTRA_MAIL=1: "The Marinade #214" carries a
  // hidden beacon on an invented host; the app's own scan finds it (nothing
  // is seeded into trackerAlerts) and Premium strips it before render.
  it('c10-trackers', async function () {
    const subject = 'The Marinade #214';
    const rowIcon = '[data-testid="email-row"][data-footage-target="tracker-row"] [data-testid="tracker-alert-icon"]';
    await shoot(this, 'c10-trackers', async (take) => {
      await take.hold(1500);
      await take.reveal('[data-testid="email-row"][data-footage-target="tracker-row"]', 'tracker-row', { ms: 900 });
      await take.hover(rowIcon, 'row-eye');
      await take.hold(1800);
      await take.unhover();
      await take.click('[data-testid="email-row"][data-footage-target="tracker-row"]', 'open-newsletter');
      await take.waitFor(() => [...document.querySelectorAll('iframe')].some((f) => (f.getAttribute('srcdoc') || '').includes('data-mv-tracker-blocked')),
        'body with the blocked marker', 15000);
      await take.hold(2600);
      const marked = await browser.execute(() => {
        document.querySelectorAll('[data-footage-target="reader-eye"]').forEach((el) => el.removeAttribute('data-footage-target'));
        const eye = [...document.querySelectorAll('[data-testid="tracker-alert-icon"]')]
          .find((el) => !el.closest('[data-testid="email-row"]') && el.getBoundingClientRect().height > 0);
        if (!eye) return false;
        eye.setAttribute('data-footage-target', 'reader-eye');
        return true;
      });
      if (!marked) throw new Error('no tracker eye in the reader');
      await take.click('[data-footage-target="reader-eye"]', 'reader-eye');
      await take.waitFor(() => !!document.querySelector('[role="alertdialog"]'), 'tracker dialog', 8000);
      facts.c10Dialog = await browser.execute(() => (document.querySelector('[role="alertdialog"]')?.innerText || '').replace(/\s+/g, ' '));
      await take.hold(4200);
      const closeSel = `[role="alertdialog"] button[aria-label="${L('common.close')}"]`;
      if (await browser.execute((s) => !!document.querySelector(s), closeSel)) await take.click(closeSel, 'close-dialog');
      else await pressEscape();
      await take.waitFor(() => !document.querySelector('[role="alertdialog"]'), 'dialog closed', 8000);
      await take.hold(3800);
    }, {
      prepare: async () => {
        const tag = () => browser.execute((s) => {
          const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => (r.innerText || '').includes(s));
          if (!row) return 'no row';
          row.setAttribute('data-footage-target', 'tracker-row');
          return row.querySelector('[data-testid="tracker-alert-icon"]') ? 'icon' : 'no icon';
        }, subject);
        let state = await tag();
        if (state !== 'icon') await browser.pause(8000);
        state = await tag();
        facts.c10IconBeforeOpen = state;
        if (state === 'no icon') {
          // Backfill asked about this row before its body reached the vault;
          // one open runs the reading pane's own scan, which persists the verdict.
          await clickSel('[data-testid="email-row"][data-footage-target="tracker-row"]');
          await waitPage(() => [...document.querySelectorAll('iframe')].some((f) => (f.getAttribute('srcdoc') || '').includes('data-mv-tracker-blocked')), { timeout: 15000 });
          await browser.pause(1200);
          await resetView();
          state = await tag();
          facts.c10IconAfterPrimingOpen = state;
        }
        console.log(`[c10] row icon: ${JSON.stringify({ before: facts.c10IconBeforeOpen, after: facts.c10IconAfterPrimingOpen })}`);
        if (state !== 'icon') throw new Error(`newsletter row: ${state}`);
      },
    });
  });

  // 11. Insights, then Explorer by date, sender and conversation. Insights
  // reads the whole vault again on every open (about 5 s here, recorded; the
  // busy window is in notes.insights for the cut).
  it('c11-insights-explorer', async function () {
    await shoot(this, 'c11-insights-explorer', async (take) => {
      await take.hold(1000);
      const click = await take.click(SEL.insights, 'insights');
      const busy = [L('insights.loading').split('{{')[0].trim(), L('insights.querying').replace('…', '').trim()];
      await take.waitFor((words) => {
        const page = document.querySelector('[data-testid="insights-page"]');
        return page?.dataset.status === 'ready' && !words.some((w) => (page.innerText || '').includes(w));
      }, 'insights ready', 60000, busy);
      const readyAt = take.t(Date.now());
      if ((await browser.execute(() => document.querySelector('[data-testid="insights-tab-map"]')?.getAttribute('aria-selected'))) !== 'true') {
        await take.click('[data-testid="insights-tab-map"]', 'tab-map');
      }
      await take.waitFor(() => document.querySelectorAll('.insights-map-node').length > 0, 'map bubbles', 15000);
      take.note('insights', { click: Number(take.t(click.at).toFixed(3)), ready: Number(readyAt.toFixed(3)),
        why: 'Insights reads the whole vault on open; the busy panel runs from the click to ready. Cut it.' });
      await take.hold(700);
      const dy = await browser.execute(() => {
        const scroller = document.querySelector('[data-testid="insights-page"] .insights-scroll');
        const tabs = document.querySelector('.insights-tabs');
        if (!scroller || !tabs) return 0;
        return Math.round(tabs.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16);
      });
      if (dy > 4) await take.scrollEase('[data-testid="insights-page"] .insights-scroll > *', dy, 'insights-map', { ms: 1400 });
      await take.hold(900);
      await take.hover('.insights-map-node', 'bubble');
      facts.c11Tooltip = await waitPage(() => !!document.querySelector('#insights-sender-tooltip'), { timeout: 4000 });
      await take.hold(2600);
      await take.unhover();
      await take.click('[data-testid="insights-tab-timeline"]', 'tab-timeline');
      await take.hold(3000);
      await take.click('[data-testid="insights-tab-activity"]', 'tab-activity');
      await take.hold(3000);
      facts.c11Insights = await browser.execute(() => ({
        total: document.querySelector('[data-testid="insights-total"]')?.innerText,
        bubbles: document.querySelectorAll('.insights-map-node').length,
      }));
      await take.click('[data-testid="insights-close"]', 'insights-close');
      await take.waitFor(() => !document.querySelector('[data-testid="insights-page"]'), 'insights closed', 8000);
      await take.hold(600);
      await take.click(SEL.explorer, 'explorer');
      await take.waitFor(() => document.querySelectorAll('[data-testid="explorer-group-row"]').length > 0, 'explorer groups', 10000);
      await take.hold(1300);
      const yearSel = '[data-testid="explorer-group-row"][data-label="2025"] [data-testid="explorer-group-open"]';
      const hasYear = await browser.execute((s) => !!document.querySelector(s), yearSel);
      await take.click(hasYear ? yearSel : '[data-testid="explorer-group-open"]', 'year');
      await take.waitFor(() => document.querySelectorAll('.explorer-crumb').length >= 2, 'year crumb', 8000);
      await take.hold(1200);
      await take.click('[data-testid="explorer-group-open"]', 'month');
      await take.waitFor(() => document.querySelectorAll('.explorer-crumb').length >= 3, 'month crumb', 8000);
      facts.c11DateCrumbs = await browser.execute(() => [...document.querySelectorAll('.explorer-crumb')].map((c) => c.textContent));
      await take.hold(1700);
      await setControl(take, '[data-testid="explorer-grouping"]', 'sender', 'browse-sender');
      await take.waitFor(() => document.querySelectorAll('[data-testid="explorer-group-row"]').length > 0, 'sender groups', 10000);
      await take.hold(1500);
      await take.click('[data-testid="explorer-group-open"]', 'sender');
      await take.waitFor(() => document.querySelectorAll('.explorer-crumb').length >= 2, 'sender crumb', 8000);
      facts.c11SenderCrumbs = await browser.execute(() => [...document.querySelectorAll('.explorer-crumb')].map((c) => c.textContent));
      await take.hold(1700);
      await setControl(take, '[data-testid="explorer-grouping"]', 'conversation', 'browse-conversation');
      await take.waitFor(() => document.querySelectorAll('[data-testid="explorer-group-row"]').length > 0, 'conversation groups', 10000);
      await take.hold(1300);
      // Down to one month's conversations: the year, then its newest month.
      // The newest month holds only today's two messages: the one before it.
      for (const [depth, label, nth] of [[2, 'conv-year', 0], [3, 'conv-month', 1]]) {
        const ok = await browser.execute((n) => {
          document.querySelectorAll('[data-footage-target="conv-open"]').forEach((el) => el.removeAttribute('data-footage-target'));
          const opens = [...document.querySelectorAll('[data-testid="explorer-group-open"]')];
          const el = opens[n] || opens[0];
          if (!el) return false;
          el.setAttribute('data-footage-target', 'conv-open');
          return true;
        }, nth);
        if (!ok) break;
        await take.click('[data-footage-target="conv-open"]', label);
        if (!(await waitPage((d) => document.querySelectorAll('.explorer-crumb').length >= d, { timeout: 8000 }, depth))) break;
        await take.hold(depth === 3 ? 2600 : 1300);
      }
      facts.c11Conversation = await browser.execute(() => ({
        crumbs: [...document.querySelectorAll('.explorer-crumb')].map((c) => c.textContent),
        groups: [...document.querySelectorAll('[data-testid="explorer-group-row"]')].slice(0, 5).map((r) => r.dataset.label),
      }));
    }, {
      prepare: async () => {
        await archiveEverything();
      },
    });
  });

  // 12. Chat view.
  it('c12-chat', async function () {
    const thread = 'launch campaign, round three';
    await shoot(this, 'c12-chat', async (take) => {
      await take.hold(1500);
      await take.reveal(SEL.row, 'thread-row', { text: thread, ms: 900 });
      await take.click(SEL.row, 'thread-row', { text: thread });
      await take.waitFor(readerOpen, 'thread to open', 10000, L('viewer.selectEmailRead'));
      await take.hold(4200);
      await toAppearanceTab(take, L('settings.appearance.section.layout'), 'layout-tab',
        () => !!document.querySelector('[data-testid="appearance-layout-section"]')?.offsetHeight);
      await take.hold(1200);
      await take.click('[data-testid="appearance-layout-section"] .settings-segments button', 'chat-view', { text: L('workspace.chatView') });
      await take.hold(1500);
      await take.click(CLOSE_SETTINGS, 'close-settings');
      await take.waitFor(() => !!document.querySelector('[data-testid="chat-view"]')?.offsetHeight, 'chat view', 10000);
      await take.hold(2800);
      const inBubbles = (reply) => (document.querySelector('[data-testid="chat-view"]')?.innerText || '').includes(reply);
      facts.c12BubblesAtSwitch = await browser.execute(inBubbles, L('chat.bubble.reply'));
      if (!facts.c12BubblesAtSwitch) {
        if (!(await markSmallest('[data-testid="chat-view"]', 'Ana Brandt', 'person'))) throw new Error('no Ana Brandt conversation');
        await take.click('[data-footage-target="person"]', 'person-ana');
        await browser.pause(700);
        if (!(await markSmallest('[data-testid="chat-view"]', thread, 'topic'))) throw new Error('no Rack & Rind topic');
        await take.hold(1700);
        await take.click('[data-footage-target="topic"]', 'topic-rack-rind');
        await take.waitFor(inBubbles, 'bubbles', 15000, L('chat.bubble.reply'));
      }
      await take.hold(6400);
    });
    facts.c12 = await browser.execute(() => {
      const v = document.querySelector('[data-testid="chat-view"]');
      return v ? { imgs: v.querySelectorAll('img').length, text: (v.innerText || '').slice(0, 400) } : null;
    });
  });
});
