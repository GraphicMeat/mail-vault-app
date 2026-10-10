/**
 * Boot A: every clip that leaves the mock server as it found it, in one app
 * boot, one .mov per clip (the recorder restarts per take).
 *
 *   s1-hero               the inbox as first seen, one message opens, a slow scroll
 *   s2-vault-states       All mail / Server / Vault, then an only-copy message
 *   s4-search             'invoice', typed; results; the first one opens
 *   s5-explorer-insights  Explorer by date: a year, a month; then Insights
 *   s6a-chat              chat view: a person, a topic, the bubbles
 *   s6b-undo              reply, type, Send, Undo inside the window
 *   s6c-autotags          Settings > Auto Tags: a rule in plain English
 *
 * Setup (not recorded) seeds the per-message states through the app's own bulk
 * dialog: the last 90 days archived (green), today's mail un-archived again
 * (blue, "server only"), yesterday's archived and then deleted from the server
 * (amber, "only copy"). The only server mutation is that last delete, and it
 * happens before the first take.
 *
 * FOOTAGE_ONLY=s1-hero,s4-search limits the run to those clips (setup still runs).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBackupAndWait } from '../../../tests/e2e/helpers.js';
import { Take, sampleLoad, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, census, quiet, setSetting, clickSel, bootToInbox, resetView, beforeTake,
  waitPage, since, openSettings, closeSettings, openWorkInbox, dismissBulkBubble,
} from '../lib/scene.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const QUERY = process.env.FOOTAGE_QUERY || 'invoice';
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

// ── Setup: the vault mix, through the real bulk dialog ─────────────────────

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
  // The pool is read from the header cache; the presets work on it.
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
  // Next stays disabled while the dialog reads the whole header cache.
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
  // The list re-reads the vault after a run; the next step's options (Unarchive
  // is offered only for archived messages) come from that re-read.
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

/**
 * FOOTAGE_BACKUP_DOTS=1: a real backup of the work account to a folder in the
 * run's HOME (backup_save_external_location + backup_run_account, the route
 * connected-storage-matrix.test.js takes), so rows carry the "on backup drive"
 * dot. It archives everything it touches, so it runs before the blue and
 * amber passes.
 */
async function seedBackup() {
  const t0 = Date.now();
  const account = browser.demoAccounts[0];
  const dir = join(browser.footageDataDir, 'BackupDrive');
  mkdirSync(dir, { recursive: true });
  const invoke = (cmd, args) => browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then((v) => done(v ?? true)).catch((e) => done({ __error: String(e?.message || e) }));
  }, cmd, args);
  const loc = await invoke('backup_save_external_location', { path: dir });
  console.log('[setup] backup location:', JSON.stringify(loc));
  const result = await runBackupAndWait({ accountId: account.id, accountJson: JSON.stringify(account), backupPath: null, skipFolders: 0 },
    { timeout: 600000 });
  await browser.execute(() => window.__MAIL_STORE__?.getState?.().refreshBackedUpUids?.());
  facts.backup = { result, seconds: Number(since(t0)) };
  console.log(`[setup] backup in ${since(t0)} s: ${JSON.stringify(result)}`);
}

/** Uids of the loaded rows whose subject contains each needle (first match per needle). */
function uidsBySubject(needles) {
  return browser.execute((ns) => {
    const rows = window.__MAIL_STORE__?.getState?.().sortedEmails || [];
    return ns.map((n) => rows.find((e) => (e.subject || '').includes(n))?.uid ?? null);
  }, needles);
}

/** Re-open the work INBOX until the store reflects the vault (a run's result lands on the next activation). */
async function refreshInbox(pred, what, ...args) {
  for (let i = 0; i < 4; i++) {
    await openWorkInbox();
    if (await waitPage(pred, { timeout: 8000, interval: 400 }, ...args)) return true;
  }
  console.warn(`[setup] store never showed ${what}`);
  return false;
}

/**
 * The per-message states, through the app's own actions:
 *   green  - Last 90 Days, archived through the bulk dialog;
 *   blue   - today's two, un-archived again (the bulk dialog's Unarchive runs
 *            this same removeLocalEmails);
 *   amber  - three archived messages whose server copy this app then deleted
 *            (deleteEmailFromServer, the reader's Delete; it stamps the proof
 *            "we deleted it" that makes a row the only copy). The bulk dialog's
 *            Archive & delete does not stamp that proof today, so its rows
 *            stay green (reported, app code untouched).
 */
async function seedVaultStates() {
  facts.seed = {};
  if (process.env.FOOTAGE_BACKUP_DOTS === '1') {
    try { await seedBackup(); } catch (e) { console.error(`[setup] backup dots NOT seeded: ${e.message}`); facts.backupError = e.message; }
  }
  facts.seed.archived = await bulkStep(L('bulk.ops.last90Days'), 'archive');
  const n = Number(String(facts.seed.archived || '0').replace(/\D/g, ''));
  await refreshInbox((want) => (window.__MAIL_STORE__?.getState?.().archivedEmailIds?.size ?? 0) >= want, `${n} archived`, n);

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
  await refreshInbox((want) => [...document.querySelectorAll('[data-testid="email-row"] [data-testid="msg-state-icon"]')]
    .filter((el) => (el.dataset.state || '').startsWith('local-only')).length >= want, `${gold.length} only-copy rows`, gold.length);
  facts.seed.rowStates = await browser.execute(rowStates);
  console.log('[setup] row states after seeding:', JSON.stringify(facts.seed.rowStates));
}

/**
 * Before S4 (FOOTAGE_ARCHIVE_ALL, default on): the rest of the INBOX archived
 * too, through the same bulk dialog (All -> Archive), and the search index
 * given time to take it in. Search then answers from this computer ("N local")
 * instead of asking the server, which is the claim S4 makes, and Insights reads
 * a complete vault. Runs once, between S2 and S4, so S1 and S2 keep their mix.
 */
let archivedAll = false;
async function archiveEverything() {
  if (archivedAll || process.env.FOOTAGE_ARCHIVE_ALL === '0') return;
  archivedAll = true;
  const t0 = Date.now();
  try {
    facts.archiveAll = { selected: await bulkStep('All', 'archive') };
  } catch (e) {
    facts.archiveAll = { error: e.message };
    console.error(`[setup] archive all failed: ${e.message}`);
    return;
  }
  await refreshInbox((want) => (window.__MAIL_STORE__?.getState?.().archivedEmailIds?.size ?? 0) >= want, 'everything archived', 2800);
  // The index takes the new vault files in the background, behind a chip.
  const indexed = await waitPage(() => !document.querySelector('[data-testid="search-index-chip"]'), { timeout: 240000, interval: 1000 });
  facts.archiveAll.seconds = Number(since(t0));
  facts.archiveAll.indexChipGone = indexed;
  facts.archiveAll.archived = await archivedCount();
  // The three only-copy messages have no server copy left to fetch, so this
  // run ends "Finished with 3 failed", and that bubble stays until closed.
  facts.archiveAll.bubble = await dismissBulkBubble();
  // Insights once, untimed, for the record (facts.insightsReadySeconds: how
  // long a full-vault read takes). It does NOT warm S5: closing Insights
  // disposes its snapshot and result, so every open reads the whole vault
  // again (a6: 4.7 s here, 4.6 s again in the S5 take). S5 records that read
  // and logs its exact window (notes.insights). Kept so the run up to S4
  // matches the one S4 was delivered from.
  await prewarmInsights();
  await openWorkInbox();
  await quiet({ timeout: 20000 });
  console.log(`[setup] archived everything in ${since(t0)} s: ${JSON.stringify(facts.archiveAll)}`);
}

async function prewarmInsights() {
  const t0 = Date.now();
  if (!(await clickSel(SEL.insights))) { console.warn('[setup] Insights entry not found'); return; }
  // Ready, and neither of its two busy lines on screen (a rebuild shows one
  // for a beat before the status leaves 'ready').
  await browser.pause(1200);
  const busy = [L('insights.loading').split('{{')[0].trim(), L('insights.querying').replace('\u2026', '').trim()];
  const ready = await waitPage((words) => {
    const page = document.querySelector('[data-testid="insights-page"]');
    return page?.dataset.status === 'ready' && !words.some((w) => (page.innerText || '').includes(w));
  }, { timeout: 90000, interval: 500 }, busy);
  facts.insightsReadySeconds = Number(since(t0));
  console.log(`[setup] insights ${ready ? 'ready' : 'NOT ready'} after ${since(t0)} s`);
  await browser.pause(1000);
  await browser.execute(() => document.querySelector('[data-testid="insights-close"]')?.click());
  await browser.pause(800);
}

/**
 * S5: a page-side log of the Insights page from the click on: every
 * data-status change, every change of its busy line ("Reading local
 * headers... N found", "Updating Insights..."), and the first moment the
 * sender map has bubbles. Stamped with the page's Date.now() (the clock
 * Take.t() converts), from a MutationObserver, so the stamps are the DOM
 * commits the next painted frame shows.
 */
const watchInsights = () => {
  window.__footageInsights?.observer?.disconnect();
  const w = { events: [], mapAt: null, mapNodes: 0 };
  let status = null;
  let line = null;
  const check = () => {
    const page = document.querySelector('[data-testid="insights-page"]');
    const s = page ? (page.dataset.status || '') : 'closed';
    if (s !== status) { status = s; w.events.push({ at: Date.now(), status: s }); }
    const busy = page?.querySelector('.insights-summary [role="status"]');
    const text = busy ? (busy.textContent || '').trim() : '';
    if (text !== line && w.events.length < 80) { line = text; w.events.push({ at: Date.now(), busyLine: text }); }
    const nodes = page ? page.querySelectorAll('.insights-map-node').length : 0;
    if (nodes && w.mapAt == null) { w.mapAt = Date.now(); w.mapNodes = nodes; }
  };
  w.observer = new MutationObserver(check);
  w.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-status'] });
  check();
  window.__footageInsights = w;
  return true;
};

const readInsightsWatch = () => {
  const w = window.__footageInsights;
  if (!w) return null;
  w.observer.disconnect();
  return { events: w.events, mapAt: w.mapAt, mapNodes: w.mapNodes };
};

/** Explorer as drawn: each group row's text, the footer, the rows' state glyphs. */
const explorerText = () => ({
  groups: [...document.querySelectorAll('[data-testid="explorer-group-row"]')].map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()),
  crumbs: [...document.querySelectorAll('.explorer-crumb')].map((c) => (c.textContent || '').trim()),
  footer: (document.querySelector('.explorer-footer')?.innerText || '').replace(/\s+/g, ' ').trim(),
  vaultLine: (() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode() && out.length < 4) if (walk.currentNode.textContent.includes('In your vault')) out.push(walk.currentNode.parentElement.textContent.trim());
    return out;
  })(),
  rows: [...document.querySelectorAll('[data-testid="email-row"]')].map((r) => r.querySelector('[data-testid="msg-state-icon"]')?.dataset.state || 'none')
    .reduce((acc, s) => ({ ...acc, [s]: (acc[s] || 0) + 1 }), {}),
});

/**
 * S5 starts in a plain List view. After S4 the search panel stays open:
 * resetView clears the search and clicks the toggle in one page call, before
 * React has re-rendered, so the toggle still sees an active search and only
 * focuses the box. Once the search is gone, one click closes the panel.
 */
async function closeSearchPanel() {
  const open = () => browser.execute((s) => !!document.querySelector(s)?.offsetHeight, SEL.searchInput);
  for (let i = 0; i < 3 && (await open()); i++) {
    await browser.pause(400);
    await clickSel(SEL.searchToggle);
    await waitPage((s) => !document.querySelector(s)?.offsetHeight, { timeout: 2500 }, SEL.searchInput);
  }
  await browser.execute(() => document.activeElement?.blur?.());
  facts.s5SearchPanelOpen = await open();
  if (facts.s5SearchPanelOpen) console.warn('[footage] s5: the search panel is still open');
  await browser.pause(400);
}

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

/**
 * One clip: back to the plain inbox, wait for a quiet frame, record `body`.
 * A take that throws has its recorder stopped (no actions.json, so run.sh
 * leaves the half clip out) and the error goes to mocha; the next clip still runs.
 */
async function shoot(ctx, clip, body, { prepare } = {}) {
  if (!want(clip)) ctx.skip();
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

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: boot A', function () {
  this.timeout(1800000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    try { await seedVaultStates(); } catch (e) { console.error(`[setup] vault states NOT seeded: ${e.message}`); facts.seedError = e.message; }
    try { await prewarmInsights(); } catch (e) { console.error(`[setup] insights prewarm failed: ${e.message}`); }
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'boot-a.facts.json'), JSON.stringify(facts, null, 2));
  });

  it('s1-hero', async function () {
    const load = sampleLoad('s1-hero', 3);
    await shoot(this, 's1-hero', async (take) => {
      await take.hold(1600);
      await take.click(SEL.row, 'row-newsletter', { text: 'The Marinade #142' });
      await take.waitFor(readerOpen, 'newsletter to open', 10000, L('viewer.selectEmailRead'));
      await take.hold(2000);
      await take.scrollEase(SEL.row, 620, 'list', { ms: 3400 });
      await take.hold(1600);
    });
    await load();
  });

  it('s2-vault-states', async function () {
    const onlyCopyRow = '[data-testid="email-row"]:has([data-state^="local-only"])';
    await shoot(this, 's2-vault-states', async (take) => {
      await take.hold(1200);
      await take.click(SEL.sourceServer, 'source-server');
      await take.hold(1600);
      await take.click(SEL.sourceVault, 'source-vault');
      await take.hold(1600);
      await take.click(SEL.sourceAll, 'source-all');
      await take.hold(1100);
      await take.click(onlyCopyRow, 'only-copy-row');
      await take.waitFor(readerOpen, 'only-copy message to open', 10000, L('viewer.selectEmailRead'));
      await take.hold(2400);
    }, {
      prepare: async () => {
        if (!(await browser.execute((s) => !!document.querySelector(s), onlyCopyRow))) {
          throw new Error(`no only-copy row on screen to open (row states ${JSON.stringify(await browser.execute(rowStates))})`);
        }
      },
    });
    facts.s2Opened = await browser.execute((only) => document.body.innerText.includes(only), L('email.state.onlyCopy'));
  });

  it('s4-search', async function () {
    await shoot(this, 's4-search', async (take) => {
      await take.hold(1100);
      await take.click(SEL.searchToggle, 'search-toggle');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'search input', 5000, SEL.searchInput);
      await take.focus(SEL.searchInput, 'search-box');
      await take.hold(400);
      await take.type(SEL.searchInput, QUERY, 'search-box', { base: 150, jitter: 40, seed: 11 });
      await take.hold(450);
      await take.submit(SEL.searchInput, 'search-box');
      // Local hits land first and the server's follow ("Searching server
      // folder 1 of 1..."): the take waits for the finished count.
      const searching = L('search.searchingServerFolder').split('{{')[0].trim();
      await take.waitFor((title, sel, busy, found) => {
        const panel = document.querySelector('#mail-search-panel')?.parentElement?.innerText || '';
        return (document.querySelector('[data-testid="mailbox-title"]')?.textContent || '').trim() === title
          && document.querySelectorAll(sel).length > 0 && !panel.includes(busy) && panel.includes(found);
      }, 'search results', 30000, L('list.searchResults'), SEL.row, searching, L('search.found'));
      facts.s4Found = await browser.execute(() => (document.querySelector('#mail-search-panel')?.parentElement?.innerText || '').replace(/\s+/g, ' ').slice(0, 240));
      await take.hold(1800);
      await take.click(SEL.row, 'result-1');
      await take.waitFor(readerOpen, 'result to open', 10000, L('viewer.selectEmailRead'));
      await take.hold(1800);
    }, { prepare: archiveEverything });
    console.log('[footage] s4 found line:', facts.s4Found);
  });

  // S5 sits after S4 on purpose: S4's prepare archived the whole INBOX, so
  // Explorer's groups and rows read the vault S4 shows ("N in vault", vault
  // glyphs), and before S6 (S6c adds a tag, S6b a draft). Its own prepare runs
  // the same archive step (a no-op after S4), so FOOTAGE_ONLY without S4 still
  // shoots it on the archived vault.
  it('s5-explorer-insights', async function () {
    const year = process.env.FOOTAGE_S5_YEAR || '2025';
    // The film holds the map at the end for at least 6 s.
    const mapHold = Number(process.env.FOOTAGE_S5_MAP_HOLD_MS || 7600);
    await shoot(this, 's5-explorer-insights', async (take) => {
      await take.hold(1000);
      await take.click(SEL.explorer, 'explorer-toggle');
      await take.waitFor(() => document.querySelectorAll('[data-testid="explorer-group-row"]').length > 0, 'explorer groups', 10000);
      facts.s5Years = await browser.execute(() => [...document.querySelectorAll('[data-testid="explorer-group-row"]')].map((r) => r.dataset.label));
      facts.s5YearView = await browser.execute(explorerText);
      await take.hold(1400);
      const yearSel = `[data-testid="explorer-group-row"][data-label="${year}"] [data-testid="explorer-group-open"]`;
      const hasYear = await browser.execute((s) => !!document.querySelector(s), yearSel);
      await take.click(hasYear ? yearSel : '[data-testid="explorer-group-open"]', `year-${hasYear ? year : 'first'}`);
      await take.waitFor(() => document.querySelectorAll('.explorer-crumb').length >= 2, 'year breadcrumb', 8000);
      facts.s5Months = await browser.execute(() => [...document.querySelectorAll('[data-testid="explorer-group-row"]')].map((r) => r.dataset.label));
      facts.s5MonthView = await browser.execute(explorerText);
      await take.hold(1400);
      await take.click('[data-testid="explorer-group-open"]', 'month');
      await take.waitFor(() => document.querySelectorAll('.explorer-crumb').length >= 3, 'month breadcrumb', 8000);
      facts.s5Crumbs = await browser.execute(() => [...document.querySelectorAll('.explorer-crumb')].map((c) => c.textContent));
      await browser.pause(300);
      facts.s5MessageView = await browser.execute(explorerText);
      await take.hold(1700);
      // Every open reads the whole vault again (closing Insights disposes its
      // snapshot), about 4.6 s with 2,842 files in the E2E build's debug
      // daemon: "Reading local headers... N found", then "Updating
      // Insights...", over an empty panel. It cannot be loaded ahead of the
      // take (Insights replaces both panes), so it is recorded and its exact
      // window goes into notes.insights for the compositor to cut.
      await browser.execute(watchInsights);
      const click = await take.click(SEL.insights, 'insights');
      const busy = [L('insights.loading').split('{{')[0].trim(), L('insights.querying').replace('\u2026', '').trim()];
      await take.waitFor((words) => {
        const page = document.querySelector('[data-testid="insights-page"]');
        return page?.dataset.status === 'ready' && !words.some((w) => (page.innerText || '').includes(w))
          && page.querySelectorAll('.insights-map-node').length > 0;
      }, 'insights ready with a drawn map', 60000, busy);
      facts.s5InsightsReadyAt = take.t(Date.now());
      const watch = await browser.execute(readInsightsWatch);
      await take.hold(700);
      // The map is the lower half of the panel: bring the tab strip up under the header.
      const dy = await browser.execute(() => {
        const scroller = document.querySelector('[data-testid="insights-page"] .insights-scroll');
        const tabs = document.querySelector('.insights-tabs');
        if (!scroller || !tabs) return 0;
        return Math.round(tabs.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16);
      });
      let scrollEnd = null;
      if (dy > 4) {
        const r = await take.scrollEase('[data-testid="insights-page"] .insights-scroll > *', dy, 'insights-map', { ms: 1500 });
        scrollEnd = take.t(r.end);
      }
      facts.s5Insights = await browser.execute(() => {
        const page = document.querySelector('[data-testid="insights-page"]');
        const txt = (sel) => (page?.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();
        return {
          status: page?.dataset.status, total: txt('[data-testid="insights-total"]'), counts: txt('[data-testid="insights-counts"]'),
          coverage: txt('[data-testid="insights-coverage"]').slice(0, 400),
          captions: [...(page?.querySelectorAll('.insights-map-section .insights-chart-caption, .insights-map-recency') || [])].map((c) => (c.innerText || '').trim()),
          bubbles: [...(page?.querySelectorAll('.insights-map-node') || [])].map((b) => (b.innerText || '').trim()),
          list: [...(page?.querySelectorAll('.insights-map-section li, .insights-map-section [role="listitem"]') || [])].slice(0, 6)
            .map((li) => (li.innerText || '').replace(/\s+/g, ' ').trim()),
        };
      });
      await take.hold(mapHold);
      const at = (ms) => (ms == null ? null : Number(take.t(ms).toFixed(3)));
      take.note('insights', {
        click: Number(take.t(click.at).toFixed(3)),
        timeline: (watch?.events || []).map((e) => ({ t: at(e.at), ...(e.status != null ? { status: e.status } : { busyLine: e.busyLine }) })),
        mapDrawn: at(watch?.mapAt),
        mapNodes: watch?.mapNodes ?? null,
        readySeen: Number(facts.s5InsightsReadyAt.toFixed(3)),
        scrollEnd: scrollEnd == null ? null : Number(scrollEnd.toFixed(3)),
        why: 'Every Insights open reads the whole vault again (2,842 .eml, debug daemon in the E2E build): the panel shows its busy line over an empty map from the click until mapDrawn (a DOM commit; the first complete painted map is about 3 frames later, check the frames). Cut from the frame before the click shows to that first complete frame; after scrollEnd only the overlay scrollbar at the right edge fades out (about 0.8 s), then nothing moves.',
      });
    }, {
      prepare: async () => {
        await archiveEverything();
        await closeSearchPanel();
      },
    });
  });

  it('s6a-chat', async function () {
    await shoot(this, 's6a-chat', async (take) => {
      await take.hold(1200);
      take.cut('chat-view', 'Mail view: Email -> Chat, switched through the settings store (Settings > Workspace > Mail view)');
      await setSetting('viewStyle', 'chat');
      await take.waitFor(() => !!document.querySelector('[data-testid="chat-view"]')?.offsetHeight, 'chat view', 10000);
      await take.hold(1700);
      if (!(await markSmallest('[data-testid="chat-view"]', 'Ana Brandt', 'person'))) throw new Error('no Ana Brandt conversation');
      await take.click('[data-footage-target="person"]', 'person-ana');
      await browser.pause(700);
      if (!(await markSmallest('[data-testid="chat-view"]', 'launch campaign, round three', 'topic'))) throw new Error('no Rack & Rind topic');
      await take.hold(900);
      await take.click('[data-footage-target="topic"]', 'topic-rack-rind');
      await take.waitFor((reply) => (document.querySelector('[data-testid="chat-view"]')?.innerText || '').includes(reply),
        'bubbles', 15000, L('chat.bubble.reply'));
      await take.hold(3600);
    });
  });

  it('s6b-undo', async function () {
    await shoot(this, 's6b-undo', async (take) => {
      await take.hold(1000);
      await take.click(SEL.row, 'row-theo', { text: 'Press slot Friday 06:00' });
      await take.waitFor(readerOpen, 'message to open', 10000, L('viewer.selectEmailRead'));
      await take.hold(1100);
      await take.click('[data-quick-action="reply"]', 'reply');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'compose', 10000, SEL.editor);
      await take.hold(800);
      await take.typeRich(SEL.editor, 'Perfect, thank you Theo. See you Friday.', 'compose-body', { base: 65, jitter: 25, seed: 5, caret: 'keep' });
      facts.s6bBody = await browser.execute((s) => document.querySelector(s)?.innerText?.slice(0, 200), SEL.editor);
      await take.hold(800);
      await take.click(SEL.send, 'send');
      await take.waitFor(() => !!document.querySelector('[data-testid="undo-send-toast"]'), 'undo toast', 10000);
      await take.hold(2800);
      await take.click(SEL.undoSend, 'undo-send');
      await take.waitFor(() => !document.querySelector('[data-testid="undo-send-toast"]'), 'toast gone', 8000);
      await take.hold(1600);
    });
    facts.s6bAfterUndo = await probe();
  });

  it('s6c-autotags', async function () {
    const inTags = '[data-testid="settings-auto-tags"]';
    await shoot(this, 's6c-autotags', async (take) => {
      await take.hold(1000);
      await take.click('[data-testid="open-settings"]', 'settings');
      await take.waitFor(() => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings', 8000);
      await take.hold(1000);
      await take.click('[data-testid="settings-page"] button', 'auto-tags-tab', { text: L('autoTag.tabLabel') });
      await take.waitFor(() => document.querySelector('[data-testid="settings-content"]')?.dataset.page === 'auto-tags', 'auto tags page', 8000);
      await take.hold(1100);
      await take.click(`${inTags} button`, 'new-rule', { text: L('autoTag.newRule') });
      const nameSel = `${inTags} input[aria-label="${L('autoTag.name')}"]`;
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'rule editor', 8000, nameSel);
      await take.hold(500);
      await take.focus(nameSel, 'rule-name');
      await take.type(nameSel, 'Receipts', 'rule-name', { base: 95, jitter: 30, seed: 3 });
      await take.hold(400);
      // The tag first, the rule last: 1.5 s after the rule text stops
      // changing, the editor samples it against recent mail with the local
      // model, which the test build does not have, and fills the panel above
      // Save with "Could not decide". Saving inside that window keeps it out.
      const tagSel = `${inTags} input[aria-label="${L('autoTag.newTagPlaceholder')}"]`;
      await take.click(tagSel, 'new-tag-name');
      await take.type(tagSel, 'Receipts', 'new-tag-name', { base: 85, jitter: 25, seed: 6 });
      await take.hold(300);
      await take.click(`${inTags} button`, 'create-tag', { text: L('autoTag.newTag') });
      // createTag is a daemon round trip; the field clears when the new tag
      // has been picked for the rule.
      await take.waitFor((s) => document.querySelector(s)?.value === '', 'tag created', 10000, tagSel);
      await take.hold(600);
      const ruleSel = `${inTags} textarea[aria-label="${L('autoTag.instruction')}"]`;
      await take.click(ruleSel, 'rule-instruction');
      await take.type(ruleSel, 'Receipts, invoices and order confirmations', 'rule-instruction', { base: 55, jitter: 20, seed: 4 });
      await take.reveal(`${inTags} .settings-editor-actions button`, 'save', { text: L('common.save'), ms: 550 });
      await take.click(`${inTags} .settings-editor-actions button`, 'save', { text: L('common.save'), dur: 420 });
      facts.s6cPreviewShown = await browser.execute(() => !!document.querySelector('[data-testid="auto-tag-preview-results"]'));
      await take.waitFor((sel, name) => {
        const root = document.querySelector(sel);
        return !!root && !root.querySelector('textarea') && (root.innerText || '').includes(name);
      }, 'rule saved', 10000, inTags, 'Receipts');
      await take.reveal(`${inTags} button`, 'rule-list', { text: L('autoTag.newRule') });
      await take.hold(2400);
    });
    await closeSettings();
  });
});
