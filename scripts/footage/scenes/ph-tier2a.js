/**
 * Product Hunt tour, Tier 2 batch A (docs/product-hunt-demo-script.md rows
 * 13 to 16), dark: one app boot, one `it` (one .mov) per clip.
 *
 *   c13-unified-inbox   the three accounts in the sidebar, switch between them, All Inboxes mixing them
 *   c14-bulk-by-year    tick a row, shift-click a range; the bulk dialog: a preset, a year, Archive, progress, Cancel
 *   c15-slash-menu      compose: "/rocket" for an emoji, the bare "/" menu, "/div" a divider, "/code" a code block
 *   c16-scheduled-send  (Premium) compose to Priya, Date & time: her zone suggested, a day and a slot,
 *                       the zone list, Schedule, Send, the Scheduled list
 *
 * Nothing is staged on screen. Nothing is deleted: c14 archives (copies into
 * the vault, the server keeps everything) and cancels part way, so the boot
 * stays reusable; c16 leaves one scheduled message and must stay last.
 *
 * Run knobs beyond the batch's usual env: FOOTAGE_BODY_DELAY_MS=65 (as c02)
 * so c14's archive runs long enough to cancel; FOOTAGE_ALIGN_ALL=1
 * (lib/mailbox.js) so the other accounts' newest mail is not dated after now
 * in c13. `FOOTAGE_ONLY=c13-unified-inbox,c16-scheduled-send` limits a run.
 *
 * Helpers are copied from ph-tier1.js on purpose: importing a spec would
 * register its clips in this run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, bootToInbox, resetView, beforeTake,
  waitPage, since, dismissBulkBubble, setSetting,
} from '../lib/scene.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = {};

// ── Page predicates (serialised into the page; no closures) ─────────────────

/** The bulk progress bubble's text ('' when there is none). */
const bubbleText = () => {
  for (const el of document.querySelectorAll('.fixed.bottom-4.right-4')) {
    if (el.offsetHeight > 0) return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }
  return '';
};

const visible = (s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0);

// ── Take plumbing (from ph-tier1.js) ────────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  return rec;
}

/** One clip: back to the plain inbox, wait for a quiet frame, record `body`. */
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

/** Tag the first visible `selector` whose text contains `needle`, for a Take to click by selector. */
function tagFirst(selector, needle, tag) {
  return browser.execute((s, n, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const hit = [...document.querySelectorAll(s)]
      .find((el) => el.getBoundingClientRect().height > 0 && (!n || (el.innerText || '').includes(n)));
    if (!hit) return false;
    hit.setAttribute('data-footage-target', t);
    return true;
  }, selector, needle, tag);
}

/**
 * A click with Shift held. `Take.click` carries no modifiers, so the events
 * are dispatched here the same way (pointer travels first, then down/up/click
 * at the target's centre), each with `shiftKey: true`; logged like a click.
 */
async function shiftClick(take, selector, label) {
  await take.moveTo(selector, label);
  const r = await browser.executeAsync((s, done) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.getBoundingClientRect().height > 0);
    if (!el) { done({ error: `no visible ${s}` }); return; }
    const b = el.getBoundingClientRect();
    const x = b.x + b.width / 2; const y = b.y + b.height / 2;
    const top = document.elementFromPoint(x, y);
    const target = top && el.contains(top) ? top : el;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, view: window, shiftKey: true };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const at = Date.now();
    target.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, detail: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', ptr));
    target.dispatchEvent(new MouseEvent('mouseup', { ...base, detail: 1 }));
    target.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
    requestAnimationFrame(() => done({ at, raf: Date.now(), box: { x: b.x, y: b.y, w: b.width, h: b.height } }));
  }, selector);
  if (r.error) throw new Error(`shift-click ${label}: ${r.error}`);
  take.log({ t: take.t(r.at), raf: take.t(r.raf), type: 'click', modifiers: ['shift'], x: r.box.x + r.box.w / 2, y: r.box.y + r.box.h / 2, bbox: r.box, label });
  return r;
}

/**
 * A click where `selector` sits, delivered to whatever is on top there (a
 * popover's full-page backdrop, as a real pointer would hit it).
 */
async function clickThrough(take, selector, label) {
  await take.moveTo(selector, label);
  const r = await browser.executeAsync((s, done) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.getBoundingClientRect().height > 0);
    if (!el) { done({ error: `no visible ${s}` }); return; }
    const b = el.getBoundingClientRect();
    const x = b.x + b.width / 2; const y = b.y + b.height / 2;
    const top = document.elementFromPoint(x, y) || el;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, view: window };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const at = Date.now();
    top.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
    top.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, detail: 1 }));
    top.dispatchEvent(new PointerEvent('pointerup', ptr));
    top.dispatchEvent(new MouseEvent('mouseup', { ...base, detail: 1 }));
    top.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
    requestAnimationFrame(() => done({ at, raf: Date.now(), hit: `${top.tagName}.${String(top.className).slice(0, 40)}`, box: { x: b.x, y: b.y, w: b.width, h: b.height } }));
  }, selector);
  if (r.error) throw new Error(`click-through ${label}: ${r.error}`);
  take.log({ t: take.t(r.at), raf: take.t(r.raf), type: 'click', x: r.box.x + r.box.w / 2, y: r.box.y + r.box.h / 2, bbox: r.box, label });
  return r;
}

/**
 * The search index goes on working after an archive (a rebuild pass shows
 * "Indexing N%" again a few seconds later). Settled = no chip for 8 s in a row,
 * up to 5 min.
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

const COMPOSE_BTN = '.mail-sidebar .sidebar-compose button';
const EDITOR = SEL.editor;
const composeOpen = (s) => !!document.querySelector(s)?.offsetHeight;

/** Compose opens in the main window (not a separate one the recorder cannot see). */
async function composeInApp() {
  const mode = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().composeOpenMode);
  if (mode !== 'app') await setSetting('composeOpenMode', 'app');
  return mode;
}

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: Product Hunt tier 2a', function () {
  this.timeout(1800000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    facts.accounts = (browser.demoAccounts || []).map((a) => ({ id: a.id, email: a.email, name: a.name }));
    // The account rows' data-usage hover card (Settings, transferHoverEnabled)
    // is turned off: a take's pointer rests on the rows, and in the harness the
    // card's stats never arrive, so it sat on "Loading..." over the list.
    facts.transferHoverWas = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().transferHoverEnabled);
    await setSetting('transferHoverEnabled', false);
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-tier2a.facts.json'), JSON.stringify(facts, null, 2));
  });

  // 13. Unified inbox: three accounts, their colours, All Inboxes.
  it('c13-unified-inbox', async function () {
    const accounts = browser.demoAccounts || [];
    if (accounts.length < 3) throw new Error(`only ${accounts.length} demo accounts`);
    const acct = (i) => `.mail-sidebar .sidebar-account-open[aria-label*="${accounts[i].email}"]`;
    const ALL = '.mail-sidebar [data-testid="all-inboxes-btn"]';
    // One account's list: rows, none carrying the unified list's account dot.
    const activeIs = () => document.querySelectorAll('[data-testid="email-row"]').length > 0
      && !document.querySelector('[data-testid="account-dot"]');
    const dots = () => {
      const seen = {};
      for (const d of document.querySelectorAll('[data-testid="email-row"] [data-testid="account-dot"]')) {
        if (d.getBoundingClientRect().height <= 0) continue;
        const c = getComputedStyle(d).backgroundColor;
        seen[c] = (seen[c] || 0) + 1;
      }
      return seen;
    };
    await shoot(this, 'c13-unified-inbox', async (take) => {
      await take.hold(1400);
      await take.hover(acct(0), 'account-work');
      await take.hold(700);
      await take.click(acct(1), 'account-2');
      await take.waitFor(activeIs, 'second account inbox', 10000);
      await take.hold(1700);
      await take.click(acct(2), 'account-3');
      await take.waitFor(activeIs, 'third account inbox', 10000);
      await take.hold(1700);
      await take.click(ALL, 'all-inboxes');
      await take.waitFor(() => !!document.querySelector('[data-testid="account-dot"]'), 'unified rows', 10000);
      facts.c13Dots = await browser.execute(dots);
      await take.hold(2200);
      await take.scrollEase(SEL.row, 420, 'unified-down', { ms: 2600 });
      await take.hold(900);
      facts.c13DotsScrolled = await browser.execute(dots);
      await take.scrollEase(SEL.row, -420, 'unified-up', { ms: 2000 });
      await take.hold(1500);
    }, {
      prepare: async () => {
        facts.c13Rows = await browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 4)
          .map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 90)));
      },
    });
    facts.c13UnifiedTop = await browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 8)
      .map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 90)));
    console.log(`[footage] c13 dots ${JSON.stringify(facts.c13Dots)}; top rows ${JSON.stringify(facts.c13UnifiedTop)}`);
    if (Object.keys(facts.c13Dots || {}).length < 2) throw new Error(`unified list shows ${Object.keys(facts.c13Dots || {}).length} account colour(s)`);
  });

  // 14. Bulk actions: a shift-click range, then the bulk dialog by year, progress, cancel.
  it('c14-bulk-by-year', async function () {
    const SELECT = `.mail-list-toolbar button[aria-label="${L('workspace.selectMessages')}"]`;
    const BAR = '[data-testid="selection-action-bar"]';
    const CLEAR = `${BAR} button[title="${L('selection.clearSelection')}"]`;
    const BUBBLE = '.fixed.bottom-4.right-4';
    const barText = (s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').trim();
    await shoot(this, 'c14-bulk-by-year', async (take) => {
      await take.hold(1200);
      await take.click('[data-footage-target="check-a"]', 'tick-first');
      await take.waitFor(visible, 'selection bar', 5000, BAR);
      await take.hold(700);
      await shiftClick(take, '[data-footage-target="check-b"]', 'shift-click-range');
      await take.hold(400);
      facts.c14Bar = await browser.execute(barText, BAR);
      facts.c14Checked = await browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"] input[type="checkbox"]')]
        .filter((c) => c.checked).length);
      console.log(`[footage] c14 range: ${facts.c14Checked} ticked, bar "${facts.c14Bar}"`);
      if (facts.c14Checked !== 6) throw new Error(`shift-click ticked ${facts.c14Checked}, expected 6`);
      await take.hold(1300);
      await take.click(CLEAR, 'clear-selection');
      await take.waitFor((s) => !document.querySelector(s), 'selection cleared', 5000, BAR);
      await take.hold(500);
      await take.click(SELECT, 'select-messages');
      await take.waitFor((t) => document.body.innerText.includes(t), 'bulk dialog', 10000, L('bulk.ops.bulkEmailOperations'));
      const reading = L('bulk.ops.readingAllEmails').split('{{')[0].trim();
      await take.waitFor((r) => !document.body.innerText.includes(r) && [...document.querySelectorAll('[role="dialog"] button')]
        .filter((b) => /^\d{4} \(/.test((b.textContent || '').trim())).length >= 2, 'year buttons', 30000, reading);
      facts.c14Years = await browser.execute(() => [...document.querySelectorAll('[role="dialog"] button')]
        .map((b) => (b.textContent || '').trim()).filter((s) => /^\d{4} \(/.test(s)));
      const count = (s) => Number((/\(([\d,]+)\)/.exec(s)?.[1] || '0').replace(/,/g, ''));
      const year = [...facts.c14Years].sort((a, b) => count(b) - count(a))[0].slice(0, 4);
      facts.c14Year = year;
      await take.hold(900);
      await take.click('[role="dialog"] button', 'preset-last-30', { text: L('bulk.ops.last30Days') });
      const selectedWord = L('bulk.ops.emailsSelected').replace('{{selectedCount}}', '').trim();
      await take.waitFor((w) => document.body.innerText.includes(w), 'preset count', 10000, selectedWord);
      await take.hold(1100);
      await take.click('[role="dialog"] button', `year-${year}`, { text: `${year} (` });
      await take.waitFor((w, y) => document.body.innerText.includes(w)
        && [...document.querySelectorAll('[role="dialog"] button[aria-pressed="true"]')].some((b) => (b.textContent || '').startsWith(`${y} (`)),
      'year selected', 10000, selectedWord, year);
      facts.c14Selected = await browser.execute((w) => document.body.innerText.match(new RegExp(`([\\d,]+) ${w}`))?.[1], selectedWord);
      await take.hold(1000);
      await take.waitFor((n) => [...document.querySelectorAll('[role="dialog"] button')]
        .some((b) => (b.textContent || '').trim().startsWith(n) && !b.disabled), 'Next enabled', 15000, L('common.next'));
      await take.click('[role="dialog"] button', 'next', { text: L('common.next') });
      const ARCHIVE = '[data-testid="bulk-action-archive"]';
      await take.waitFor((s) => { const b = document.querySelector(s); return !!b && !b.disabled; }, 'archive option', 8000, ARCHIVE);
      await take.hold(700);
      await take.click(ARCHIVE, 'archive');
      await take.hold(800);
      await take.click('[data-testid="bulk-step2-confirm"]', 'start');
      // Progress: wait for a percentage in the bubble, let it run, then cancel.
      const progress = [];
      const sample = async () => {
        const text = await browser.execute(bubbleText);
        if (!progress.length || progress.at(-1).text !== text) progress.push({ t: Number(take.t(Date.now()).toFixed(3)), text });
        return text;
      };
      const tStart = Date.now();
      while (Date.now() - tStart < 15000 && !/\d+%/.test(await sample())) await browser.pause(150);
      const runUntil = Date.now() + 2600;
      while (Date.now() < runUntil) { await sample(); await browser.pause(200); }
      const midRun = await sample();
      if (midRun.includes(L('bulk.progress.operationComplete'))) throw new Error(`archive finished before cancel: ${midRun}`);
      await take.click(`${BUBBLE} button`, 'cancel', { text: L('common.cancel') });
      await take.waitFor((s, y) => [...document.querySelectorAll(`${s} button`)].some((b) => (b.innerText || '').includes(y)),
        'cancel confirmation', 5000, BUBBLE, L('bulk.progress.yesStop'));
      await sample();
      await take.hold(1300);
      await take.click(`${BUBBLE} button`, 'yes-stop', { text: L('bulk.progress.yesStop') });
      const cancelled = L('bulk.progress.operationCancelled');
      const deadline = Date.now() + 15000;
      let stopped = false;
      while (Date.now() < deadline) {
        const text = await sample();
        if (text.includes(cancelled) || text === '') { stopped = true; break; }
        if (text.includes(L('bulk.progress.operationComplete'))) break;
        await browser.pause(150);
      }
      facts.c14Progress = progress;
      writeFileSync(join(OUT_DIR, 'c14-bulk-by-year.progress.json'), JSON.stringify(progress, null, 2));
      // The bubble may go straight away on a stop instead of saying "Operation Cancelled".
      if (!stopped && progress.at(-1)?.text === '') stopped = true;
      facts.c14StopShown = progress.at(-1)?.text || '(bubble gone)';
      if (!stopped) throw new Error(`bulk archive never showed "${cancelled}": ${progress.at(-1)?.text}`);
      take.note('progress', { firstPercent: progress.find((p) => /\d+%/.test(p.text))?.t ?? null, cancelled: progress.at(-1).t });
      await take.hold(2400);
    }, {
      prepare: async () => {
        const ok = await browser.execute(() => {
          document.querySelectorAll('[data-footage-target^="check-"]').forEach((el) => el.removeAttribute('data-footage-target'));
          const rows = [...document.querySelectorAll('[data-testid="email-row"]')].filter((r) => r.getBoundingClientRect().height > 0);
          if (rows.length < 8) return false;
          rows[1].querySelector('.row-gutter-check')?.setAttribute('data-footage-target', 'check-a');
          rows[6].querySelector('.row-gutter-check')?.setAttribute('data-footage-target', 'check-b');
          return !!document.querySelector('[data-footage-target="check-a"]') && !!document.querySelector('[data-footage-target="check-b"]');
        });
        if (!ok) throw new Error('no row checkboxes to tick');
      },
    });
    facts.c14After = await browser.execute(bubbleText);
    console.log(`[footage] c14 year ${facts.c14Year} (${facts.c14Selected} selected), bubble after: ${facts.c14After}`);
  });

  // 15. Slash menu in compose.
  it('c15-slash-menu', async function () {
    const MENU = `[role="listbox"][aria-label="${L('editor.slash.label')}"]`;
    const menuHas = (s, label) => [...document.querySelectorAll(`${s} [role="option"]`)].some((o) => (o.innerText || '').includes(label));
    const menuCount = (s, n) => document.querySelectorAll(`${s} [role="option"]`).length >= n;
    await shoot(this, 'c15-slash-menu', async (take) => {
      await take.hold(1000);
      await take.click(COMPOSE_BTN, 'compose');
      await take.waitFor(composeOpen, 'compose', 10000, EDITOR);
      await take.hold(700);
      facts.c15EditorInitial = await browser.execute((s) => document.querySelector(s)?.innerHTML?.slice(0, 400), EDITOR);
      await take.click('[data-testid="compose-subject"]', 'subject');
      await take.type('[data-testid="compose-subject"]', 'Launch checklist', 'subject', { base: 70, jitter: 25, seed: 3 });
      await take.hold(300);
      await take.moveTo(EDITOR, 'body');
      await take.typeRich(EDITOR, 'We launch on Friday /rocket', 'body-1', { base: 75, jitter: 25, seed: 11, caret: 'start' });
      await take.waitFor(menuHas, 'rocket in the menu', 5000, MENU, 'rocket');
      await take.hold(900);
      await take.typeRich(EDITOR, '\n', 'pick-rocket', { caret: 'keep' });
      await take.hold(500);
      await take.typeRich(EDITOR, '\n/', 'slash', { base: 120, caret: 'keep' });
      await take.waitFor(menuCount, 'full menu', 5000, MENU, 6);
      facts.c15FullMenu = await browser.execute((s) => [...document.querySelectorAll(`${s} [role="option"]`)]
        .map((o) => (o.innerText || '').replace(/\s+/g, ' ').trim()), MENU);
      await take.hold(1800);
      await take.typeRich(EDITOR, 'div', 'filter-divider', { base: 140, caret: 'keep' });
      await take.waitFor(menuHas, 'divider row', 5000, MENU, L('editor.slash.divider'));
      await take.hold(700);
      await take.typeRich(EDITOR, '\n', 'pick-divider', { caret: 'keep' });
      await take.hold(600);
      await take.typeRich(EDITOR, '/code', 'code-cmd', { base: 120, caret: 'keep' });
      await take.waitFor(menuHas, 'code block row', 5000, MENU, L('editor.slash.codeBlock'));
      await take.hold(800);
      await take.typeRich(EDITOR, '\n', 'pick-code', { caret: 'keep' });
      await take.hold(300);
      await take.typeRich(EDITOR, 'npm run release', 'code', { base: 70, jitter: 20, seed: 4, caret: 'keep' });
      await take.hold(2200);
      facts.c15Html = await browser.execute((s) => document.querySelector(s)?.innerHTML?.slice(0, 1200), EDITOR);
      const html = facts.c15Html || '';
      facts.c15Has = { rocket: html.includes('🚀'), hr: /<hr/i.test(html), pre: /<pre/i.test(html) };
      console.log(`[footage] c15 editor: ${JSON.stringify(facts.c15Has)} ${html.slice(0, 300)}`);
      if (!facts.c15Has.rocket || !facts.c15Has.hr || !facts.c15Has.pre) throw new Error(`slash commands did not all land: ${JSON.stringify(facts.c15Has)}`);
    }, {
      prepare: async () => {
        facts.c15ComposeMode = await composeInApp();
        facts.c15Bubble = await dismissBulkBubble();
        facts.c15IndexSettled = await indexSettled();
        await resetView();
      },
    });
  });

  // 16. Scheduled Send (Premium): a reply-style message to Priya, whose mail is dated on New York's clock.
  it('c16-scheduled-send', async function () {
    const TZ = 'America/New_York';
    const PANEL = '[data-testid="compose-schedule-panel"]';
    const TIME = '[data-testid="compose-schedule-time"]';
    const TZBOX = '[data-testid="compose-schedule-tz"]';
    const tzState = (s, n) => ({ tz: document.querySelector(s)?.dataset.value || '', note: !!document.querySelector(n)?.offsetHeight });
    await shoot(this, 'c16-scheduled-send', async (take) => {
      await take.hold(900);
      await take.click(COMPOSE_BTN, 'compose');
      await take.waitFor(composeOpen, 'compose', 10000, EDITOR);
      await take.hold(600);
      await take.click('[data-testid="compose-to"]', 'to');
      await take.type('[data-testid="compose-to"]', 'Pri', 'to', { base: 110, jitter: 25, seed: 9 });
      const suggested = await waitPage((n) => [...document.querySelectorAll('[data-testid="compose-modal"] button')]
        .some((b) => b.offsetHeight > 0 && (b.innerText || '').includes(n)), { timeout: 4000 }, 'Priya');
      facts.c16Autocomplete = suggested;
      if (suggested) {
        await tagFirst('[data-testid="compose-modal"] button', 'Priya', 'priya');
        await take.hold(500);
        await take.click('[data-footage-target="priya"]', 'priya-suggestion');
      } else {
        const rest = (facts.priya || 'priya@tenderloin.type').slice(3);
        await take.type('[data-testid="compose-to"]', rest, 'to-rest', { base: 70, jitter: 20, seed: 9 });
      }
      facts.c16To = await browser.execute(() => document.querySelector('[data-testid="compose-to"]')?.value);
      await take.hold(500);
      await take.click('[data-testid="compose-subject"]', 'subject');
      await take.type('[data-testid="compose-subject"]', 'Licence renewal', 'subject', { base: 70, jitter: 25, seed: 5 });
      await take.moveTo(EDITOR, 'body');
      await take.typeRich(EDITOR, 'Happy to renew the five seats. Invoice to accounts, please.', 'body', { base: 45, jitter: 20, seed: 6, caret: 'start' });
      await take.hold(600);
      await take.click('[data-testid="compose-schedule-toggle"]', 'schedule-toggle');
      await take.waitFor(visible, 'schedule panel', 5000, PANEL);
      await take.hold(500);
      await take.click('[data-testid="compose-later-tab-at"]', 'tab-date-time');
      if (await browser.execute((s) => !!document.querySelector(s), '[data-testid="compose-schedule-locked"]')) {
        throw new Error('Scheduled Send is locked: the Premium seed did not take');
      }
      await take.waitFor((s, n, z) => {
        const tz = document.querySelector(s)?.dataset.value || '';
        return tz === z && !!document.querySelector(n)?.offsetHeight;
      }, `suggested zone ${TZ}`, 10000, TZBOX, '[data-testid="compose-schedule-tz-note"]', TZ);
      facts.c16Suggested = await browser.execute(tzState, TZBOX, '[data-testid="compose-schedule-tz-note"]');
      facts.c16Note = await browser.execute(() => document.querySelector('[data-testid="compose-schedule-tz-note"]')?.innerText);
      await take.hold(1700);
      // An exact date and time: tomorrow in her zone, 9:00 AM.
      await take.click(TIME, 'time-trigger');
      const day = await browser.execute((z) => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(Date.now() + 86400000)), TZ);
      facts.c16Day = day;
      const DAY = `[data-testid="compose-schedule-time-day-${day}"]`;
      await take.waitFor((s) => !!document.querySelector('[data-testid^="compose-schedule-time-day-"]'), 'calendar', 5000);
      if (!(await browser.execute((s) => !!document.querySelector(s), DAY))) {
        await take.hold(400);
        await take.click(`button[aria-label="${L('common.nextMonth')}"]`, 'next-month');
        await take.waitFor((s) => !!document.querySelector(s), 'next month', 3000, DAY);
      }
      await take.hold(700);
      await take.click(DAY, 'day-tomorrow');
      await take.hold(600);
      const SLOT = '[data-testid="compose-schedule-time-slot-09:00"]';
      await take.reveal(SLOT, 'slot', { ms: 700 });
      await take.hold(300);
      await take.click(SLOT, 'slot-0900');
      await take.waitFor((s, v) => (document.querySelector(s)?.dataset.value || '') === v, 'time picked', 3000, TIME, `${day}T09:00`);
      await take.hold(800);
      // Close the calendar with a click on the panel's own title.
      // The calendar's backdrop covers the page, so the click lands on it.
      await tagFirst(`${PANEL} div.text-sm.font-medium`, '', 'panel-title');
      await clickThrough(take, '[data-footage-target="panel-title"]', 'close-calendar');
      await take.waitFor(() => !document.querySelector('[data-testid^="compose-schedule-time-day-"]'), 'calendar closed', 3000);
      await take.hold(600);
      // The zone list, her zone selected.
      await take.click(TZBOX, 'tz-open');
      const OPTION = `[data-testid="compose-schedule-tz-option-${TZ}"]`;
      await take.waitFor(visible, 'zone list', 5000, OPTION);
      await take.reveal(OPTION, 'tz-option', { ms: 600 });
      await take.hold(1500);
      await take.click(OPTION, 'tz-new-york');
      await take.waitFor((s) => !document.querySelector(s), 'zone list closed', 3000, OPTION);
      facts.c16Picked = await browser.execute((t, z) => ({ time: document.querySelector(t)?.dataset.value, tz: document.querySelector(z)?.dataset.value,
        sends: document.querySelector('[data-testid="compose-schedule-sends"]')?.innerText || null }), TIME, TZBOX);
      if (facts.c16Picked.tz !== TZ) throw new Error(`zone changed to ${facts.c16Picked.tz}`);
      await take.hold(1800);
      await take.click('[data-testid="compose-schedule-submit"]', 'schedule');
      await take.waitFor((s) => !document.querySelector(s), 'panel closed', 3000, PANEL);
      facts.c16Plan = await browser.execute(() => document.querySelector('[data-testid="compose-send-plan"]')?.innerText || null);
      await take.hold(1300);
      await take.click(SEL.send, 'send');
      await take.waitFor((s) => !document.querySelector(s)?.offsetHeight, 'compose closed', 15000, '[data-testid="compose-modal"]');
      await take.hold(900);
      await take.click('.mail-sidebar [data-testid="sidebar-scheduled-btn"]', 'scheduled');
      await take.waitFor(() => !!document.querySelector('[data-testid="scheduled-folder-modal"] [data-testid^="scheduled-row-"]'), 'scheduled row', 10000);
      facts.c16Scheduled = await browser.execute(() => (document.querySelector('[data-testid="scheduled-folder-modal"]')?.innerText || '')
        .replace(/\s+/g, ' ').slice(0, 400));
      await take.hold(2800);
    }, {
      prepare: async () => {
        await composeInApp();
        facts.priya = await browser.execute(() => {
          const rows = window.__MAIL_STORE__?.getState?.().sortedEmails || [];
          const hit = rows.find((e) => /Priya/.test(JSON.stringify(e.from || '')));
          const f = hit?.from;
          return (f && (f.address || f.email || f.value?.[0]?.address)) || null;
        });
      },
    });
    console.log(`[footage] c16: ${JSON.stringify({ to: facts.c16To, suggested: facts.c16Suggested, note: facts.c16Note, picked: facts.c16Picked, plan: facts.c16Plan, scheduled: facts.c16Scheduled })}`);
  });
});
