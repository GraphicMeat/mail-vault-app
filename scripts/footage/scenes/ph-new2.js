/**
 * Product Hunt tour, new features batch 2: one `it` (one .mov) per clip, each
 * boot taking only the clips of its own FOOTAGE_THEME (FOOTAGE_ONLY narrows):
 *
 *   light  n04-search-tags     Settings > Storage (50,000 / 50,000 indexed), then the tag search bar:
 *                              a typed prefix, index suggestions, a sender picked as a tag, a word
 *                              committed with Enter, an operator from the / menu with its value;
 *                              each tag runs the search; the summary line (time, emails read).
 *   dark   n05-more-fonts      Settings > Appearance > Text > More fonts: Serif, search, pick: the
 *                              family is downloaded for real from Google Fonts and the app re-renders.
 *   light  n06-signature-html  Settings > Accounts signature editor: Rendered / Code, one tag edited
 *                              in the HTML, back to Rendered with the change.
 *
 * Light boot (n04 needs the 50,000-message vault, n06 rides along):
 *   FOOTAGE_SPEC=ph-new2 FOOTAGE_THEME=light FOOTAGE_CORPUS_50K=1 FOOTAGE_CORPUS_N=49932 \
 *     FOOTAGE_LIST_PANE=640 FOOTAGE_EXPECT_TOTAL=82 FOOTAGE_BODY_DELAY_MS=0 bash scripts/footage/run.sh
 * Dark boot:
 *   FOOTAGE_SPEC=ph-new2 FOOTAGE_THEME=dark FOOTAGE_HISTORY=1 FOOTAGE_BODY_DELAY_MS=0 \
 *     FOOTAGE_EXPECT_TOTAL=2842 bash scripts/footage/run.sh
 *
 * Staged off camera (n04): location Vault and folder "all" through the search
 * store, search history recording off (limit 0) so no recent-search list
 * covers the results, the operators hint marked seen. Every query is dry-run
 * first and the sender / word / date picked from what the index answers.
 * n06: the account's signature is set through the settings store first.
 *
 * Helpers are copied from ph-search50k.js / ph-tier3b.js on purpose: importing
 * a spec would register its clips in this run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, bootToInbox, resetView, beforeTake, waitPage, since, setSetting, clickSel,
} from '../lib/scene.js';

const THEME = process.env.FOOTAGE_THEME;
if (THEME !== 'light' && THEME !== 'dark') throw new Error(`ph-new2 needs FOOTAGE_THEME=light|dark (got ${THEME})`);
const CLIP_THEME = {
  'n04-search-tags': 'light',
  'n05-more-fonts': 'dark',
  'n06-signature-html': 'light',
};
const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => CLIP_THEME[clip] === THEME && (!ONLY.length || ONLY.includes(clip));
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = { theme: THEME };

// ── Page predicates (serialised into the page; no closures) ─────────────────

const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const visible = (s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0);
const blurActive = () => browser.execute(() => { document.activeElement?.blur?.(); });
const CLOSE_SETTINGS = `[data-testid="settings-page"] button[aria-label="${L('common.close')}"]`;
const NAV = '[data-testid="settings-page"] .settings-nav-item';

/** The search finished for `q` (store query, case and quotes aside), whatever it found. */
const searchSettled = (q) => {
  const st = window.__SEARCH_STORE__?.getState?.();
  const norm = (x) => String(x || '').toLowerCase().replace(/"/g, '').trim();
  return !!st && st.searchActive && !st.isSearching && norm(st.searchQuery) === norm(q);
};

// ── Take plumbing (from ph-tier3b.js) ───────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  facts[`${clip}Seconds`] = rec.seconds;
  return rec;
}

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
    facts[`${clip}Error`] = String(e?.message || e);
    await take.abort();
    throw e;
  }
}

/** Settings > `navLabel` by real clicks; `ready` is the page predicate. */
async function toSettingsPage(take, navLabel, ready, what, ...args) {
  await take.click('[data-testid="open-settings"]', 'settings');
  await take.waitFor(settingsOpen, 'settings', 8000);
  await blurActive();
  await take.hold(600);
  await take.reveal(NAV, 'nav-reveal', { text: navLabel, ms: 600 });
  await take.click(NAV, 'nav', { text: navLabel });
  await take.waitFor(ready, what, 15000, ...args);
}

async function closeSettingsInTake(take) {
  await take.click(CLOSE_SETTINGS, 'close-settings');
  await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 8000);
}

/**
 * Every visible "N emails" / "N messages" label (the deepest element saying
 * it), with its box in viewport CSS px: where the small demo counts show next
 * to the 50,000 the clip is about.
 */
const countLabels = () => browser.execute(() => {
  const re = /\b\d[\d,.]*\s*(emails?|messages?)\b/i;
  const hits = [];
  for (const el of document.querySelectorAll('body *')) {
    const tx = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!tx || tx.length > 120 || !re.test(tx)) continue;
    if ([...el.children].some((c) => re.test((c.innerText || '').replace(/\s+/g, ' ')))) continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0 || b.bottom < 0 || b.top > window.innerHeight) continue;
    hits.push({ text: tx, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
  }
  return hits;
});

async function noteLabels(take, when) {
  const labels = await countLabels();
  const t = take ? Number(take.t(Date.now()).toFixed(2)) : null;
  (facts.n04Labels ||= []).push({ when, t, labels });
  console.log(`[fact] labels at ${when} (t ${t}): ${JSON.stringify(labels)}`);
}

// ── n04 helpers (from ph-search50k.js) ──────────────────────────────────────

const indexStatus = () => browser.executeAsync((done) => {
  window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'search_index_status', params: {} })
    .then(done, (e) => done({ error: String(e?.message || e) }));
});

const suggest = (prefix, accounts) => browser.executeAsync((p, a, done) => {
  window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'search.suggest', params: { prefix: p, accounts: a, limit: 10 } })
    .then(done, (e) => done({ error: String(e?.message || e) }));
}, prefix, accounts);

/** The search store and the summary line, in one round trip. */
const searchState = () => browser.execute(() => {
  const st = window.__SEARCH_STORE__?.getState?.();
  const text = (sel) => (document.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();
  const input = document.querySelector('[data-testid="mail-search-input"]');
  return {
    active: !!st?.searchActive,
    searching: !!st?.isSearching,
    query: st?.searchQuery ?? null,
    results: st?.searchResults?.length ?? null,
    coverage: st?.searchIndexCoverage || null,
    durationMs: st?.searchDurationMs ?? null,
    filters: st?.searchFilters || null,
    summary: text('[data-testid="search-summary"]'),
    duration: text('[data-testid="search-duration"]'),
    line: text('[data-testid="search-summary"]')
      ? (document.querySelector('[data-testid="search-summary"]').parentElement.innerText || '').replace(/\s+/g, ' ').trim() : '',
    capped: text('[data-testid="search-index-capped"]'),
    building: text('[data-testid="search-index-building"]'),
    tags: [...document.querySelectorAll('[data-testid="search-tag"]')].map((t) => (t.innerText || '').trim()),
    dropdown: !!document.querySelector('[data-testid="search-dropdown"]'),
    expanded: input?.getAttribute('aria-expanded') ?? null,
    rows: document.querySelectorAll('[data-testid="email-row"]').length,
    history: window.__SETTINGS_STORE__?.getState?.().searchHistory?.length ?? null,
  };
});

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

/** The take's search scope, history off, hint seen (all off camera). */
const stageSearch = () => browser.execute(() => {
  const ss = window.__SETTINGS_STORE__;
  ss?.getState?.().clearSearchHistory?.();
  ss?.setState?.({ searchHistoryLimit: 0, filterUsageHistory: [] });
  ss?.getState?.().markSearchOperatorsHintSeen?.();
  window.__SEARCH_STORE__?.getState?.().setSearchFilters?.({ folder: 'all', location: 'local' });
});

/** Run `q` off camera with the take's filters (search panel open); what it found and said. */
async function dryRun(q) {
  await browser.execute((query) => {
    const st = window.__SEARCH_STORE__.getState();
    st.setSearchFilters({ folder: 'all', location: 'local' });
    st.setSearchQuery(query);
    setTimeout(() => window.__SEARCH_STORE__.getState().performSearch(), 0);
  }, q);
  await browser.pause(200);
  await waitPage(searchSettled, { timeout: 60000, interval: 300 }, q);
  await browser.pause(600);
  const s = await searchState();
  console.log(`[setup] dry run "${q}": ${s.results} results, line "${s.line}", capped "${s.capped}", coverage ${JSON.stringify(s.coverage)}`);
  return s;
}

/** Type into `selector` replacing [start, start+del) with `text`, caret following (a textarea or input). */
function pageSplice(selector, start, del, text, delays, done) {
  const el = [...document.querySelectorAll(selector)].find((e) => e.offsetHeight > 0);
  if (!el) { done({ error: `no visible ${selector}` }); return; }
  const r = el.getBoundingClientRect();
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  // The word to replace shows selected first, as a double-click would leave it.
  el.setSelectionRange(start, start + del);
  const log = [];
  const chars = [...text];
  let pos = start;
  let end = start + del;
  let i = 0;
  const step = () => {
    if (i >= chars.length) { setTimeout(() => done({ log, value: el.value, box: { x: r.x, y: r.y, w: r.width, h: r.height } }), 40); return; }
    const ch = chars[i];
    const key = { key: ch, bubbles: true, cancelable: true, composed: true };
    const entry = { ch, at: Date.now() };
    el.dispatchEvent(new KeyboardEvent('keydown', key));
    const v = el.value;
    setter.call(el, v.slice(0, pos) + ch + v.slice(end));
    pos += ch.length;
    end = pos;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new KeyboardEvent('keyup', key));
    requestAnimationFrame(() => { entry.raf = Date.now(); });
    log.push(entry);
    const wait = delays[i];
    i += 1;
    setTimeout(step, wait);
  };
  setTimeout(step, 450);
}

async function splice(take, selector, start, del, text, label) {
  const delays = [...text].map((_, k) => 110 + ((k * 37) % 50));
  const r = await browser.executeAsync(pageSplice, selector, start, del, text, delays);
  if (r.error) throw new Error(`splice ${label}: ${r.error}`);
  const b = r.box;
  for (const e of r.log) {
    take.log({ t: take.t(e.at), raf: e.raf ? take.t(e.raf) : undefined, type: 'type', x: b.x + b.w / 2, y: b.y + b.h / 2, bbox: b, label, text: e.ch });
  }
  return r.value;
}

// ── The clips ───────────────────────────────────────────────────────────────

describe(`footage: Product Hunt new features 2 (${THEME})`, function () {
  this.timeout(2400000);
  let plan = null;

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    // The account rows' data-usage hover card never gets its stats in the harness.
    await setSetting('transferHoverEnabled', false);
    facts.settingsAtBoot = await browser.execute(() => {
      const s = window.__SETTINGS_STORE__?.getState?.() || {};
      return { appFont: s.appFont, textScale: s.textScale, searchHistoryLimit: s.searchHistoryLimit, operatorsHintSeen: s.searchOperatorsHintSeen };
    });
    console.log(`[setup] settings at boot ${JSON.stringify(facts.settingsAtBoot)}`);

    if (want('n04-search-tags')) {
      facts.index = await waitForIndex();
      await browser.pause(6000);
      facts.indexSettled = await indexStatus();
      console.log(`[fact] index status: ${JSON.stringify(facts.indexSettled)}`);
      if (facts.indexSettled?.total !== 50000) console.warn(`[fact] index total is ${facts.indexSettled?.total}, not 50000`);
      await resetView();
      const account = (await probe()).account;
      facts.account = account;

      // Suggestions: a prefix whose answer has a named sender and a word.
      const prefixes = ['pri', 'mor', 'ana', 'theo', 'pro'];
      let chosen = null;
      for (const p of prefixes) {
        const found = await suggest(p, account ? [account] : []);
        console.log(`[setup] suggest "${p}": ${JSON.stringify(found)}`);
        (facts.suggestDry ||= {})[p] = found;
        if (!Array.isArray(found)) continue;
        const senders = found.filter((f) => f.kind === 'sender' && f.name && f.address);
        const terms = found.filter((f) => f.kind === 'term');
        if (!senders.length || !terms.length) continue;
        const sender = senders.find((s) => s.name.toLowerCase().startsWith(p)) || senders[0];
        chosen = { prefix: p, sender };
        break;
      }
      if (!chosen) throw new Error(`no prefix gave a named sender and a word: ${JSON.stringify(facts.suggestDry)}`);

      // The queries the tags will say, dry-run with the panel open.
      await stageSearch();
      await clickSel(SEL.searchToggle);
      await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 5000 }, SEL.searchInput);
      const fromTag = `from:${chosen.sender.address}`;
      const s1 = await dryRun(fromTag);
      if (!s1.results) throw new Error(`${fromTag} finds nothing`);
      let word = null;
      for (const w of ['invoice', 'budget', 'meeting', 'delivery']) {
        const s = await dryRun(`${fromTag} ${w}`);
        if ((s.results || 0) >= 3) { word = w; break; }
      }
      if (!word) throw new Error(`no word narrows ${fromTag}`);
      let after = null;
      for (const d of ['2026-06-01', '2026-03-01', '2026-01-01']) {
        const s = await dryRun(`${fromTag} ${word} after:${d}`);
        if ((s.results || 0) >= 1) { after = d; facts.n04Dry3 = s; break; }
      }
      if (!after) throw new Error(`no after: date keeps results for ${fromTag} ${word}`);
      plan = { ...chosen, fromTag, word, after, q1: fromTag, q2: `${fromTag} ${word}`, q3: `${fromTag} ${word} after:${after}` };
      facts.n04Plan = plan;
      console.log(`[setup] n04 plan ${JSON.stringify(plan)}`);
      await resetView();
      await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().clearSearchHistory?.());
    }
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-new2.facts.json'), JSON.stringify(facts, null, 2));
  });

  // n04. Search: Storage card, then tags built from suggestions, Enter and the / menu.
  it('n04-search-tags', async function () {
    if (!want('n04-search-tags')) this.skip();
    if (!plan) throw new Error('n04: no plan from setup');
    const SUGGESTION = '[data-testid="search-suggestion"]';
    const OP = (id) => `[data-testid="search-dropdown"] li[data-operator="${id}"]`;
    const EDIT = '[data-testid="search-tag-edit"]';
    /** A search's tags landed: wait for it, then close any list over the summary by a click on it. */
    const landed = async (take, q, what) => {
      await take.hold(200);
      await take.waitFor(searchSettled, `results for ${what}`, 30000, q);
      const s = await searchState();
      facts[`n04${what}`] = s;
      console.log(`[fact] n04 ${what}: ${JSON.stringify(s)}`);
      if (s.expanded === 'true' || s.dropdown) {
        console.warn(`[take] n04 ${what}: list open over the summary, clicking the summary`);
        await take.click('[data-testid="search-summary"]', `summary-${what}`);
      }
      return s;
    };
    await shoot(this, 'n04-search-tags', async (take) => {
      await take.hold(900);
      await noteLabels(take, 'start');

      // 1. Settings > Storage: 50,000 / 50,000 indexed.
      await toSettingsPage(take, L('settings.tab.storage'), () => !!document.querySelector('[data-testid="search-index-status"]')?.offsetHeight, 'index card');
      await take.reveal('#settings-search-index', 'index-card');
      facts.indexCardText = await browser.execute(() => (document.querySelector('[data-testid="search-index-status"]')?.innerText || '').trim());
      console.log(`[fact] index card on screen: "${facts.indexCardText}"`);
      await take.hover('[data-testid="search-index-status"]', 'index-status');
      await take.hold(2600);
      await take.unhover();
      await noteLabels(take, 'storage');
      await closeSettingsInTake(take);
      await take.hold(400);

      // 2. The search bar.
      await take.click(SEL.searchToggle, 'search-toggle');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'search input', 5000, SEL.searchInput);
      facts.n04Staged = await searchState();
      await take.hold(500);
      await take.click(SEL.searchInput, 'search-box');
      await take.hold(300);

      // 3. A prefix; the index suggests senders and words; a sender becomes a tag.
      await take.type(SEL.searchInput, plan.prefix, 'search-box', { base: 150, jitter: 40, seed: 4 });
      await take.waitFor((s) => [...document.querySelectorAll(s)].some((e) => e.offsetHeight > 0), 'suggestions', 8000, SUGGESTION);
      await take.hold(400);
      facts.n04Suggestions = await browser.execute((s) => [...document.querySelectorAll(s)].map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()), SUGGESTION);
      facts.n04Dropdown = await browser.execute(() => (document.querySelector('[data-testid="search-dropdown"]')?.innerText || '').replace(/\s+/g, ' ').trim());
      console.log(`[fact] n04 suggestions on screen: ${JSON.stringify(facts.n04Suggestions)}`);
      await take.hold(1200);
      await take.click(SUGGESTION, 'suggestion-sender', { text: plan.sender.address });
      await landed(take, plan.q1, 'Q1');
      await take.hold(2600);
      await noteLabels(take, 'q1');

      // 4. A word, committed as a tag with Enter (the tag runs the search).
      await take.type(SEL.searchInput, plan.word, 'search-box', { base: 120, jitter: 40, seed: 5 });
      await take.hold(350);
      await take.submit(SEL.searchInput, 'search-box');
      await landed(take, plan.q2, 'Q2');
      await take.hold(2200);
      await noteLabels(take, 'q2');

      // 5. "/" lists the operators; after: takes its value in the new tag.
      await take.click(SEL.searchInput, 'search-box-2');
      await take.type(SEL.searchInput, '/', 'search-box', { base: 120 });
      await take.waitFor(visible, 'operator list', 5000, OP('after'));
      facts.n04Operators = await browser.execute(() => (document.querySelector('[data-testid="search-dropdown"]')?.innerText || '').replace(/\s+/g, ' ').trim());
      await take.hold(1300);
      await take.click(OP('after'), 'operator-after');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'after: value field', 5000, EDIT);
      await take.hold(300);
      await take.type(EDIT, plan.after, 'after-value', { base: 120, jitter: 30, seed: 6 });
      await take.hold(350);
      await take.submit(EDIT, 'after-value');
      const s3 = await landed(take, plan.q3, 'Q3');
      await take.hold(600);
      // The summary line: results, emails read, time.
      await take.hover('[data-testid="search-summary"]', 'summary');
      await take.hold(3000);
      await take.unhover();
      await noteLabels(take, 'q3');
      facts.n04Final = s3;
    }, { prepare: async () => { await stageSearch(); await blurActive(); } });
  });

  // n06. Signature as HTML: Rendered / Code, one tag edited, Rendered again.
  it('n06-signature-html', async function () {
    const SIG_GROUP = `[data-testid="settings-page"] [role="group"][aria-label="${L('settings.accounts.signatureView')}"] button`;
    const SOURCE = '[data-testid="signature-source"]';
    const RENDERED = '[data-testid="settings-page"] .ProseMirror[contenteditable="true"]';
    const SIG_HTML = '<p><strong>Rowan Marsh</strong></p><p>Prime Cut Studio, Lisbon</p><p><a href="https://primecut.studio">primecut.studio</a></p>';
    await shoot(this, 'n06-signature-html', async (take) => {
      await take.hold(700);
      await toSettingsPage(take, L('settings.tab.accounts'), visible, 'signature editor', RENDERED);
      // The editor box sits at the bottom edge: bring the switch row up to about a third of the window.
      const top = await browser.execute((s) => {
        const btn = [...document.querySelectorAll(s)].find((b) => b.offsetHeight > 0);
        return btn ? btn.getBoundingClientRect().top : null;
      }, SIG_GROUP);
      if (top == null) throw new Error('no signature view switch');
      facts.n06SwitchTop = top;
      if (top > 360) await take.scrollEase(SIG_GROUP, top - 320, 'signature-scroll', { ms: 1100 });
      await take.reveal(SIG_GROUP, 'signature-reveal', { text: L('settings.accounts.signatureViewCode'), ms: 600 });
      facts.n06SwitchTopAfter = await browser.execute((s) => [...document.querySelectorAll(s)].find((b) => b.offsetHeight > 0)?.getBoundingClientRect().top, SIG_GROUP);
      facts.n06RenderedBefore = await browser.execute((s) => document.querySelector(s)?.innerHTML?.slice(0, 400), RENDERED);
      await take.hold(900);
      await take.click(SIG_GROUP, 'code', { text: L('settings.accounts.signatureViewCode') });
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'html source', 5000, SOURCE);
      const src0 = await browser.execute((s) => document.querySelector(s).value, SOURCE);
      facts.n06Source = src0;
      console.log(`[fact] n06 source: ${JSON.stringify(src0)}`);
      await take.hold(1300);
      // <strong> becomes <em>: the opening tag, then the closing one.
      const open = src0.indexOf('<strong>');
      if (open < 0) throw new Error(`no <strong> in the source: ${src0}`);
      await take.moveTo(SOURCE, 'source');
      const src1 = await splice(take, SOURCE, open + 1, 'strong'.length, 'em', 'source-open');
      await take.hold(250);
      const close = src1.indexOf('</strong>');
      if (close < 0) throw new Error(`no </strong> after the first edit: ${src1}`);
      const src2 = await splice(take, SOURCE, close + 2, 'strong'.length, 'em', 'source-close');
      facts.n06Edited = src2;
      await take.hold(1100);
      await take.click(SIG_GROUP, 'rendered', { text: L('settings.accounts.signatureViewRendered') });
      await take.waitFor((s) => !!document.querySelector(s)?.querySelector('em'), 'italic name rendered', 5000, RENDERED);
      facts.n06RenderedAfter = await browser.execute((s) => document.querySelector(s)?.innerHTML?.slice(0, 400), RENDERED);
      console.log(`[fact] n06 rendered after: ${facts.n06RenderedAfter}`);
      await take.hover(`${RENDERED} em`, 'italic-name');
      await take.hold(2200);
      await take.unhover();
    }, {
      prepare: async () => {
        facts.n06SignatureWas = await browser.execute((html) => {
          const st = window.__SETTINGS_STORE__.getState();
          const id = window.__MAIL_STORE__?.getState?.().activeAccountId;
          const was = st.getSignature(id);
          st.setSignature(id, { ...was, html, text: '', enabled: true });
          return { id, was };
        }, SIG_HTML);
      },
    });
  });

  // n05. More fonts: a Google family downloaded and applied to the whole app.
  it('n05-more-fonts', async function () {
    const FAMILY = 'Playfair Display';
    const DIALOG = '[role="dialog"]';
    const ROW = `[data-testid="google-font-${FAMILY}"] button`;
    await shoot(this, 'n05-more-fonts', async (take) => {
      await take.hold(800);
      await take.click('[data-testid="open-settings"]', 'settings');
      await take.waitFor(settingsOpen, 'settings', 8000);
      await blurActive();
      await take.hold(500);
      await take.click(NAV, 'appearance', { text: L('settings.appearance.appearance') });
      await take.waitFor((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
        .some((b) => (b.innerText || '').includes(t)), 'appearance tabs', 8000, L('settings.appearance.section.text'));
      await take.hold(400);
      await take.click('[data-testid="settings-page"] [role="tab"]', 'text-tab', { text: L('settings.appearance.section.text') });
      const MORE = '[data-testid="settings-page"] button';
      await take.waitFor((s, t) => [...document.querySelectorAll(s)].some((b) => b.offsetHeight > 0 && (b.innerText || '').includes(t)), 'more fonts', 8000, MORE, L('settings.text.moreFonts'));
      await take.reveal(MORE, 'more-reveal', { text: L('settings.text.moreFonts'), ms: 700 });
      await take.hold(700);
      await take.click(MORE, 'more-fonts', { text: L('settings.text.moreFonts') });
      await take.waitFor((s, t) => [...document.querySelectorAll(s)].some((d) => d.offsetHeight > 0 && (d.innerText || '').includes(t)), 'picker', 8000, DIALOG, L('fonts.picker.title'));
      await blurActive();
      await take.hold(1200);
      await take.click(`${DIALOG} [role="group"] button`, 'serif', { text: L('fonts.category.serif') });
      await take.hold(1100);
      await take.click(`${DIALOG} input[type="search"]`, 'font-search');
      await take.type(`${DIALOG} input[type="search"]`, 'playfair', 'font-search', { base: 120, jitter: 30, seed: 7 });
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'family row', 5000, ROW);
      await take.hold(900);
      await take.click(ROW, 'pick-family');
      const t0 = Date.now();
      // Ready (the picker closes, the app font switches) or a failure in the row.
      const outcome = await browser.waitUntil(() => browser.execute((fam) => {
        const st = window.__SETTINGS_STORE__?.getState?.();
        if (st?.appFont === `google:${fam}`) return 'applied';
        const row = document.querySelector(`[data-testid="google-font-${fam}"]`);
        const err = row && row.querySelector('.text-mail-danger');
        return err ? `failed: ${(err.innerText || '').replace(/\s+/g, ' ').trim()}` : false;
      }, FAMILY), { timeout: 60000, interval: 100, timeoutMsg: 'font download neither applied nor failed in 60 s' });
      facts.n05Outcome = outcome;
      facts.n05DownloadSeconds = Number(since(t0));
      console.log(`[fact] n05 ${outcome} after ${facts.n05DownloadSeconds} s`);
      await take.hold(outcome === 'applied' ? 900 : 2500);
      if (outcome === 'applied') {
        // Proof the face is the downloaded one, not the Georgia fallback.
        await browser.waitUntil(() => browser.execute((fam) => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === fam && f.status === 'loaded'), FAMILY),
          { timeout: 15000, interval: 200 }).catch(() => {});
        facts.n05Fonts = await browser.executeAsync((fam, done) => {
          const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '').includes(fam)).map((f) => ({ family: f.family, weight: f.weight, status: f.status }));
          const check = document.fonts.check(`16px "${fam}"`);
          const body = getComputedStyle(document.body).fontFamily;
          const row = getComputedStyle(document.querySelector('[data-testid="settings-page"]') || document.body).fontFamily;
          window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'fonts.list', params: {} })
            .then((list) => done({ faces, check, body, row, list }), (e) => done({ faces, check, body, row, listError: String(e?.message || e) }));
        }, FAMILY);
        console.log(`[fact] n05 fonts ${JSON.stringify(facts.n05Fonts)}`);
        await take.hold(1800);
        await closeSettingsInTake(take);
        await take.hold(3200);
      }
    });
  });
});
