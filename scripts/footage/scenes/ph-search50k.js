/**
 * Product Hunt tour, clip 3 (docs/product-hunt-demo-script.md): offline search
 * over a 50,000-message vault. Its own boot, because the vault is seeded before
 * the app starts:
 *
 *   FOOTAGE_SPEC=ph-search50k FOOTAGE_THEME=light FOOTAGE_CORPUS_50K=1 FOOTAGE_CORPUS_N=49932 \
 *     FOOTAGE_LIST_PANE=640 FOOTAGE_EXPECT_TOTAL=82 FOOTAGE_BODY_DELAY_MS=0 bash scripts/footage/run.sh
 *
 * No history and no extra mail: the corpus (scripts/screenshots/search50kCorpus.mjs)
 * is 50,000 minus the 68 demo messages this boot puts in the vault index (the
 * corpus default assumes the screenshot run's 82; the first footage run read
 * 49,986), so the index card reads 50,000 / 50,000 only on the plain demo mailbox.
 *
 *   c03-search-50k  Settings > Storage > Search index (the 50,000 count), then
 *                   search: location Vault, `invoice`, an operator query, the
 *                   "?" operators popover, an example appended, `has:attachment`.
 *
 * The app searches on Enter, not as you type: results land right after each
 * submit. The location select is native (no menu the driver can open), so it
 * is switched through React's value setter and logged as a `cut`.
 *
 * Before the take the daemon's index must be finished: `search_index_status`
 * is polled hands-off (folder switches are foreground work and starve the
 * throttled index). Every query of the take is dry-run first, off camera, and a
 * query that finds nothing is swapped for its fallback.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, bootToInbox, resetView, beforeTake, waitPage, since,
} from '../lib/scene.js';

const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const CLIP = 'c03-search-50k';
const facts = {};

const PANEL = '[data-testid="search-operators-panel"]';
const HELP = '[data-testid="search-operators-help"]';
const LOCATION = '#mail-search-panel select:has(option[value="local"])';
const SETTINGS_CLOSE = `[data-testid="settings-page"] button[title="${L('common.close')}"]`;
const EXAMPLE = 'after:2026-01-31';

// Candidates per step, first that finds anything wins (dry-run in setup).
const Q1 = ['invoice'];
const Q2 = ['invoice from:ana before:2026-03-01', 'invoice from:moreau before:2026-03-01', 'invoice before:2026-03-01'];
const Q3 = ['invoice has:attachment', 'has:attachment'];

// ── Page side ────────────────────────────────────────────────────────────────

const indexStatus = () => browser.executeAsync((done) => {
  window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'search_index_status', params: {} })
    .then(done, (e) => done({ error: String(e?.message || e) }));
});

/** The search store and the header lines, in one round trip. */
const searchState = () => browser.execute(() => {
  const st = window.__SEARCH_STORE__?.getState?.();
  const text = (sel) => (document.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();
  return {
    active: !!st?.searchActive,
    searching: !!st?.isSearching,
    query: st?.searchQuery ?? null,
    results: st?.searchResults?.length ?? null,
    coverage: st?.searchIndexCoverage || null,
    filters: st?.searchFilters || null,
    header: text('#mail-search-panel .mt-2.text-xs'),
    capped: text('[data-testid="search-index-capped"]'),
    building: text('[data-testid="search-index-building"]'),
    rows: document.querySelectorAll('[data-testid="email-row"]').length,
    history: window.__SETTINGS_STORE__?.getState?.().searchHistory?.length ?? null,
  };
});

/** A search for `q` has finished and its rows are on screen. */
const searchDone = (q) => {
  const st = window.__SEARCH_STORE__?.getState?.();
  return !!st && st.searchActive && !st.isSearching && st.searchQuery === q
    && document.querySelectorAll('[data-testid="email-row"]').length > 0;
};

/** The search finished for `q`, whatever it found. */
const searchSettled = (q) => {
  const st = window.__SEARCH_STORE__?.getState?.();
  return !!st && st.searchActive && !st.isSearching && st.searchQuery === q;
};

/** Empty the search box the way select-all + delete would (React sees an input event). */
const clearBox = () => browser.execute(() => {
  const input = document.querySelector('[data-testid="mail-search-input"]');
  if (!input) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  return true;
});

/** The native location select to `value` through React's value setter. */
const setLocation = (sel, value) => browser.execute((s, v) => {
  const el = document.querySelector(s);
  if (!el || el.offsetHeight === 0) return null;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.options[el.selectedIndex]?.text || el.value;
}, sel, value);

/** Search scope for the take: every folder (the corpus is not in INBOX), no history dropdown. */
const scopeAllFolders = () => browser.execute(() => {
  window.__SEARCH_STORE__?.getState?.().setSearchFilters?.({ folder: 'all' });
  window.__SETTINGS_STORE__?.getState?.().clearSearchHistory?.();
});

const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;

// ── Setup ────────────────────────────────────────────────────────────────────

/** Hands-off: wait for the daemon's first index pass over the whole vault. */
async function waitForIndex(timeoutMs = 1200000) {
  const t0 = Date.now();
  let last = null;
  let stableSince = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < timeoutMs) {
    const s = await indexStatus();
    const done = s && s.available && s.state === 'idle' && s.complete;
    if (!last || s.total !== last.total || s.indexed !== last.indexed || !done) stableSince = Date.now();
    last = s;
    if (Date.now() - lastLog > 20000) {
      console.log(`[setup] index ${since(t0)} s: ${JSON.stringify(s)}`);
      lastLog = Date.now();
    }
    if (done && Date.now() - stableSince > 8000) {
      console.log(`[setup] index finished in ${since(t0)} s: ${JSON.stringify(s)}`);
      return s;
    }
    await browser.pause(2000);
  }
  console.error(`[setup] index NOT finished after ${since(t0)} s: ${JSON.stringify(last)}`);
  return last;
}

/** Run `q` off camera with the take's filters; returns what it found. */
async function dryRun(q) {
  await browser.execute((query) => {
    const st = window.__SEARCH_STORE__.getState();
    st.setSearchFilters({ folder: 'all', location: 'local' });
    st.setSearchQuery(query);
    setTimeout(() => window.__SEARCH_STORE__.getState().performSearch(), 0);
  }, q);
  await waitPage(searchSettled, { timeout: 60000, interval: 300 }, q);
  await browser.pause(600);
  const s = await searchState();
  console.log(`[setup] dry run "${q}": ${s.results} results, rows ${s.rows}, coverage ${JSON.stringify(s.coverage)}`);
  return s;
}

async function pickQuery(candidates, name) {
  for (const q of candidates) {
    const s = await dryRun(q);
    if ((s.results || 0) > 0) { facts[`${name}DryRun`] = { q, results: s.results, coverage: s.coverage }; return q; }
  }
  console.warn(`[setup] ${name}: every candidate found nothing, using "${candidates[0]}"`);
  return candidates[0];
}

// ── The clip ─────────────────────────────────────────────────────────────────

describe('footage: Product Hunt clip 3, search 50k', function () {
  this.timeout(2400000);
  let queries = {};

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.index = await waitForIndex();
    // The demo bodies can still be landing in the vault: one more settled read.
    await browser.pause(6000);
    facts.indexSettled = await indexStatus();
    console.log(`[fact] index status: ${JSON.stringify(facts.indexSettled)}`);
    if (facts.indexSettled?.total !== 50000) console.warn(`[fact] index total is ${facts.indexSettled?.total}, not 50000`);
    await resetView();
    queries = {
      q1: await pickQuery(Q1, 'q1'),
      q2: await pickQuery(Q2, 'q2'),
      q3: await pickQuery(Q3, 'q3'),
    };
    // The example appended to q2 must still find something.
    const q2b = await dryRun(`${queries.q2} ${EXAMPLE}`);
    facts.q2bDryRun = { q: `${queries.q2} ${EXAMPLE}`, results: q2b.results };
    facts.queries = queries;
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-search50k.facts.json'), JSON.stringify(facts, null, 2));
  });

  it(CLIP, async function () {
    await resetView();
    await scopeAllFolders();
    await browser.pause(400);
    await beforeTake(CLIP);
    const take = new Take(CLIP);
    await take.start();
    try {
      await take.hold(1000);

      // 1. Settings > Storage: the index card says 50,000 / 50,000.
      await take.click('[data-testid="open-settings"]', 'settings');
      await take.waitFor(settingsOpen, 'settings', 8000);
      await take.hold(500);
      // Storage sits below the fold of the settings nav: scroll it into view first.
      await take.reveal('[data-testid="settings-page"] .settings-nav-item', 'storage-nav', { text: L('settings.tab.storage') });
      await take.hold(200);
      await take.click('[data-testid="settings-page"] .settings-nav-item', 'storage', { text: L('settings.tab.storage') });
      await take.waitFor(() => !!document.querySelector('[data-testid="search-index-status"]')?.offsetHeight, 'index card', 8000);
      await take.reveal('#settings-search-index', 'index-card');
      facts.indexCardText = await browser.execute(() => (document.querySelector('[data-testid="search-index-status"]')?.innerText || '').trim());
      facts.indexCardBusy = await browser.execute(() => !!document.querySelector('#settings-search-index [role="progressbar"]'));
      console.log(`[fact] index card on screen: "${facts.indexCardText}" busy ${facts.indexCardBusy}`);
      await take.hover('[data-testid="search-index-status"]', 'index-status');
      await take.hold(2400);
      await take.unhover();
      try {
        await take.click(SETTINGS_CLOSE, 'settings-close');
        await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings to close', 5000);
      } catch (e) {
        console.warn(`[take] settings close by click failed (${e.message}); closing with a cut`);
        take.cut('settings-close', 'settings closed through Escape');
        await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings to close', 5000);
      }
      await take.hold(500);

      // 2. Search, scoped to the vault: offline.
      await take.click(SEL.searchToggle, 'search-toggle');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'search input', 5000, SEL.searchInput);
      await browser.execute(() => document.activeElement?.blur?.());
      await take.hold(400);
      await take.moveTo(LOCATION, 'location');
      take.cut('location-vault', 'native select switched from All to Vault through the React value setter');
      facts.location = await setLocation(LOCATION, 'local');
      if (!facts.location) throw new Error('location select not found');
      await take.hold(700);
      await take.click(SEL.searchInput, 'search-box');
      await take.hold(300);

      // 3. A word.
      await take.type(SEL.searchInput, queries.q1, 'search-box', { follow: true });
      await take.hold(250);
      await take.submit(SEL.searchInput, 'search-box');
      await take.waitFor(searchDone, `results for ${queries.q1}`, 30000, queries.q1);
      facts.q1 = await searchState();
      console.log(`[fact] q1 on screen: ${JSON.stringify(facts.q1)}`);
      await take.hold(2400);

      // 4. Operators.
      await clearBox();
      await take.hold(250);
      await take.type(SEL.searchInput, queries.q2, 'search-box', { follow: true });
      await take.hold(250);
      await take.submit(SEL.searchInput, 'search-box');
      await take.waitFor(searchDone, `results for ${queries.q2}`, 30000, queries.q2);
      facts.q2 = await searchState();
      console.log(`[fact] q2 on screen: ${JSON.stringify(facts.q2)}`);
      await take.hold(2000);

      // 5. The "?" popover, an example appended to the query.
      await take.click(HELP, 'operators-help');
      await take.waitFor((p) => !!document.querySelector(p)?.offsetHeight, 'operators popover', 5000, PANEL);
      await take.hold(500);
      await take.reveal(`${PANEL} button`, 'example', { text: EXAMPLE });
      await take.hold(1700);
      // The example refocuses the box, and a focused box with a search history
      // opens the recent-searches dropdown over the results until the submit.
      await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().clearSearchHistory?.());
      await take.click(`${PANEL} button`, 'example-after', { text: EXAMPLE });
      await take.waitFor((p) => !document.querySelector(p)?.offsetHeight, 'popover to close', 5000, PANEL);
      // The appended example in view, caret at the end (the box is narrower than the query).
      await take.waitFor((s, ex) => (document.querySelector(s)?.value || '').endsWith(ex), 'example in the box', 3000, SEL.searchInput, EXAMPLE);
      await browser.execute((s) => {
        const input = document.querySelector(s);
        const end = input.value.length;
        input.setSelectionRange(end, end);
        input.scrollLeft = input.scrollWidth;
      }, SEL.searchInput);
      await take.hold(700);
      const q2b = `${queries.q2} ${EXAMPLE}`;
      facts.boxAfterExample = await browser.execute((s) => document.querySelector(s)?.value, SEL.searchInput);
      await take.submit(SEL.searchInput, 'search-box');
      await take.waitFor(searchSettled, `results for ${q2b}`, 30000, facts.boxAfterExample);
      facts.q2b = await searchState();
      console.log(`[fact] q2b on screen: ${JSON.stringify(facts.q2b)}`);
      await take.hold(2000);

      // 6. has:attachment.
      await clearBox();
      await take.hold(250);
      await take.type(SEL.searchInput, queries.q3, 'search-box', { follow: true });
      await take.hold(250);
      await take.submit(SEL.searchInput, 'search-box');
      await take.waitFor(searchDone, `results for ${queries.q3}`, 30000, queries.q3);
      facts.q3 = await searchState();
      console.log(`[fact] q3 on screen: ${JSON.stringify(facts.q3)}`);
      await take.hold(2600);

      const rec = await take.stop();
      if (rec.delivered < 10) throw new Error(`${CLIP}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
      console.log(`[footage] ${CLIP}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
      facts.seconds = rec.seconds;
    } catch (e) {
      await take.abort();
      throw e;
    }
  });
});
