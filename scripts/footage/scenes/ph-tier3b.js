/**
 * Product Hunt tour, Tier 3 montage batch B (docs/product-hunt-demo-script.md
 * rows 43 to 50): short working clips, one `it` (one .mov) per clip. Tier 3
 * alternates themes, so this spec runs twice, each boot taking only the clips
 * of its own FOOTAGE_THEME (the others are skipped):
 *
 *   dark   c43-default-mail-app   Settings > Mail preferences: the default email app row (hovered, never clicked)
 *   light  c44-settings-search    "Find a setting", type, pick the result, the setting is outlined
 *   dark   c45-preview-lines      Settings > Appearance > Layout: preview lines 1/2/3, list density, then the list
 *   light  c46-attachment-preview a message with a photo and a PDF: thumbnail, both previews
 *   dark   c47-reply-starters     a question proposing a time: the starters, one opens Compose, edited, not sent
 *   light  c48-templates          Settings > Templates: add one; Compose: insert it
 *   dark   c49-signature-images   the signature editor: paste a logo, select it (corner handles), resize, the 3x offer
 *   light  c50-code-as-code       a received plain-text message with `inline` and fenced code, shown as code
 *
 * Mail: FOOTAGE_TIER3B=1 seeds three invented messages (lib/tier3bMail.js),
 * FOOTAGE_EXPECT_TOTAL goes up by 3. Nothing else is staged on screen.
 * c49 must stay last of the dark clips (it leaves an unsaved signature).
 *
 * Helpers are copied from ph-tier1.js / ph-tier2a.js on purpose: importing a
 * spec would register its clips in this run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, bootToInbox, resetView, beforeTake, since, setSetting,
} from '../lib/scene.js';
import { ATTACH_SUBJECT, STARTER_SUBJECT, CODE_SUBJECT } from '../lib/tier3bMail.js';

const THEME = process.env.FOOTAGE_THEME;
if (THEME !== 'light' && THEME !== 'dark') throw new Error(`ph-tier3b needs FOOTAGE_THEME=light|dark (got ${THEME})`);
const CLIP_THEME = {
  'c43-default-mail-app': 'dark',
  'c44-settings-search': 'light',
  'c45-preview-lines': 'dark',
  'c46-attachment-preview': 'light',
  'c47-reply-starters': 'dark',
  'c48-templates': 'light',
  'c49-signature-images': 'dark',
  'c50-code-as-code': 'light',
};
const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => CLIP_THEME[clip] === THEME && (!ONLY.length || ONLY.includes(clip));
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = { theme: THEME };

// ── Page predicates (serialised into the page; no closures) ─────────────────

const readerOpen = (empty) => !document.body.innerText.includes(empty);
const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const visible = (s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0);
const blurActive = () => browser.execute(() => { document.activeElement?.blur?.(); });

// ── Take plumbing (from ph-tier2a.js) ───────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
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
 * Tag the button reading `buttonText` in the settings row labelled
 * `rowLabel` (two rows can both offer "Compact").
 */
function tagRowButton(rowLabel, buttonText, tag) {
  return browser.execute((label, text, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const root = document.querySelector('[data-testid="settings-page"]');
    if (!root) return false;
    const labels = [...root.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim() === label);
    for (const l of labels) {
      let row = l.parentElement;
      while (row && row !== root && !row.querySelector('.settings-segments')) row = row.parentElement;
      const btn = row && [...row.querySelectorAll('.settings-segments button')].find((b) => (b.textContent || '').trim() === text);
      if (btn) { btn.setAttribute('data-footage-target', t); return true; }
    }
    return false;
  }, rowLabel, buttonText, tag);
}

/** Settings > `navLabel` by real clicks; `ready` is the page predicate. */
async function toSettingsPage(take, navLabel, ready, what, ...args) {
  await take.click('[data-testid="open-settings"]', 'settings');
  await take.waitFor(settingsOpen, 'settings', 8000);
  await blurActive();
  await take.hold(700);
  await take.reveal('[data-testid="settings-page"] .settings-nav-item', 'nav-reveal', { text: navLabel, ms: 600 });
  await take.click('[data-testid="settings-page"] .settings-nav-item', 'nav', { text: navLabel });
  await take.waitFor(ready, what, 15000, ...args);
}

const CLOSE_SETTINGS = `[data-testid="settings-page"] button[aria-label="${L('common.close')}"]`;
const COMPOSE_BTN = '.mail-sidebar .sidebar-compose button';
const EDITOR = SEL.editor;
const composeOpen = (s) => !!document.querySelector(s)?.offsetHeight;

/** Compose opens in the main window (not a separate one the recorder cannot see). */
async function composeInApp() {
  const mode = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().composeOpenMode);
  if (mode !== 'app') await setSetting('composeOpenMode', 'app');
  return mode;
}

/** Settled = no search-index chip for 8 s in a row, up to 5 min (from ph-tier2a.js). */
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

/**
 * A left-button drag the way a mouse does it for a handle that listens on the
 * document (TipTap's resize handles): mousedown on the handle, mousemove and
 * mouseup on the document, eased over `ms`. Logged as a drag move.
 */
async function mouseDrag(take, selector, dx, dy, label, ms = 1200) {
  await take.moveTo(selector, label);
  const r = await browser.executeAsync((s, ddx, ddy, dur, done) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.getBoundingClientRect().width > 0);
    if (!el) { done({ error: `no visible ${s}` }); return; }
    const b = el.getBoundingClientRect();
    const x0 = b.x + b.width / 2, y0 = b.y + b.height / 2;
    const ev = (x, y, buttons) => ({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons, view: window });
    const at = Date.now();
    el.dispatchEvent(new MouseEvent('mousedown', ev(x0, y0, 1)));
    const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
    const start = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - start) / dur);
      const x = x0 + ddx * ease(p), y = y0 + ddy * ease(p);
      document.dispatchEvent(new MouseEvent('mousemove', ev(x, y, 1)));
      if (p < 1) { requestAnimationFrame(step); return; }
      setTimeout(() => {
        document.dispatchEvent(new MouseEvent('mouseup', ev(x, y, 0)));
        requestAnimationFrame(() => done({ at, end: Date.now(), from: { x: x0, y: y0 }, to: { x, y }, box: { x: b.x, y: b.y, w: b.width, h: b.height } }));
      }, 160);
    };
    requestAnimationFrame(step);
  }, selector, dx, dy, ms);
  if (r.error) throw new Error(`drag ${label}: ${r.error}`);
  take.log({ t: take.t(r.at), type: 'move', drag: true, x: r.to.x, y: r.to.y, from: r.from, bbox: r.box, label, dur: (r.end - r.at) / 1000 });
  take.cursor = { x: r.to.x, y: r.to.y };
  return r;
}

// ── The clips ───────────────────────────────────────────────────────────────

describe(`footage: Product Hunt tier 3b (${THEME})`, function () {
  this.timeout(1800000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    // The account rows' data-usage hover card never gets its stats in the
    // harness and sat on "Loading..." over the list (ph-tier2a.js).
    await setSetting('transferHoverEnabled', false);
    facts.composeModeWas = await composeInApp();
    facts.settingsAtBoot = await browser.execute(() => {
      const s = window.__SETTINGS_STORE__?.getState?.() || {};
      return { listPreviewLines: s.listPreviewLines, listDensity: s.listDensity, templates: (s.emailTemplates || []).length, viewStyle: s.viewStyle };
    });
    await resetView();
    const left = await quiet({ timeout: 90000 });
    facts.topRows = await browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 10)
      .map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 90)));
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}; settings ${JSON.stringify(facts.settingsAtBoot)}`);
  });

  // A dialog resetView does not know about (attachment preview, the 3x offer) is closed between clips.
  afterEach(async function () {
    const closed = await browser.execute((close) => {
      const out = [];
      const keep = document.querySelector('[data-testid="image-scale-keep"]');
      if (keep?.offsetHeight) { keep.click(); out.push('image-scale'); }
      const prev = document.querySelector('[data-testid="attachment-preview-dialog"]');
      if (prev) { prev.querySelector(`button[aria-label="${close}"]`)?.click(); out.push('attachment-preview'); }
      return out;
    }, L('common.close'));
    if (closed.length) { console.log(`[footage] afterEach closed ${closed.join(', ')}`); await browser.pause(600); }
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-tier3b.facts.json'), JSON.stringify(facts, null, 2));
  });

  // 43. Default mail app: the row only. The button is hovered, never clicked
  // (a click would ask macOS to change the mini's mailto handler).
  it('c43-default-mail-app', async function () {
    const STATE = '[data-testid="default-mail-state"]';
    const ACTION = '[data-testid="default-mail-action"]';
    await shoot(this, 'c43-default-mail-app', async (take) => {
      await take.hold(1000);
      await toSettingsPage(take, L('settings.navigation.mailPreferences'), visible, 'default mail row', STATE);
      await take.hold(500);
      await take.reveal(STATE, 'default-mail-reveal', { ms: 900 });
      facts.c43 = await browser.execute((s, a) => ({
        state: document.querySelector(s)?.dataset.default,
        text: document.querySelector(s)?.innerText,
        action: document.querySelector(a)?.dataset.action || null,
        button: document.querySelector(a)?.innerText || null,
        hint: document.querySelector('[data-testid="default-mail-hint"]')?.innerText || null,
      }), STATE, ACTION);
      console.log(`[footage] c43 ${JSON.stringify(facts.c43)}`);
      await take.hold(1300);
      if (facts.c43.action) await take.hover(ACTION, 'make-default-hover');
      else await take.moveTo(STATE, 'default-state');
      await take.hold(2600);
    });
  });

  // 44. Settings search: type, pick the setting, it is scrolled to and outlined.
  it('c44-settings-search', async function () {
    const FIELD = '[data-testid="settings-page"] .settings-search input';
    const RESULT = '[data-testid="settings-page"] .settings-search-result';
    const target = L('listPreview.title');
    await shoot(this, 'c44-settings-search', async (take) => {
      await take.hold(1000);
      await take.click('[data-testid="open-settings"]', 'settings');
      await take.waitFor(settingsOpen, 'settings', 8000);
      await take.hold(700);
      await take.click(FIELD, 'find-a-setting');
      await take.type(FIELD, 'preview', 'query', { base: 120, jitter: 30, seed: 44 });
      await take.waitFor((s, t) => [...document.querySelectorAll(s)].some((b) => (b.innerText || '').includes(t)), 'result', 5000, RESULT, target);
      facts.c44Results = await browser.execute((s) => [...document.querySelectorAll(s)].map((b) => (b.innerText || '').replace(/\s+/g, ' ')), RESULT);
      await take.hold(1100);
      await take.click(RESULT, 'pick-result', { text: target });
      await take.waitFor(() => !!document.querySelector('.settings-search-target'), 'outlined setting', 4000);
      facts.c44Landed = await browser.execute(() => (document.querySelector('.settings-search-target')?.innerText || '').replace(/\s+/g, ' ').slice(0, 120));
      console.log(`[footage] c44 results ${JSON.stringify(facts.c44Results)} landed "${facts.c44Landed}"`);
      await take.hold(2800);
    });
  });

  // 45. Preview lines and list density, live in the row preview, then the list itself.
  it('c45-preview-lines', async function () {
    const LINES = '[data-testid="list-preview-lines"] button';
    const was = await browser.execute(() => {
      const s = window.__SETTINGS_STORE__?.getState?.() || {};
      return { listPreviewLines: s.listPreviewLines, listDensity: s.listDensity };
    });
    facts.c45Was = was;
    try {
      await shoot(this, 'c45-preview-lines', async (take) => {
        await take.hold(1200);
        await take.click('[data-testid="open-settings"]', 'settings');
        await take.waitFor(settingsOpen, 'settings', 8000);
        await blurActive();
        await take.hold(600);
        await take.click('[data-testid="settings-page"] .settings-nav-item', 'appearance', { text: L('settings.appearance.appearance') });
        await take.waitFor((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
          .some((b) => (b.innerText || '').includes(t)), 'appearance tabs', 8000, L('settings.appearance.section.layout'));
        await take.hold(500);
        await take.click('[data-testid="settings-page"] [role="tab"]', 'layout-tab', { text: L('settings.appearance.section.layout') });
        await take.waitFor(visible, 'preview lines row', 8000, LINES);
        // Density first (its row sits above), each row scrolled into view before its clicks.
        if (!(await tagRowButton(L('workspace.listDensity'), L('workspace.sidebarDensityCompact'), 'density-compact'))) throw new Error('no list density Compact button');
        await tagRowButton(L('workspace.listDensity'), L('workspace.sidebarDensityComfortable'), 'density-comfortable');
        await take.reveal('[data-footage-target="density-compact"]', 'density-reveal', { ms: 800 });
        await take.hold(400);
        await take.click('[data-footage-target="density-compact"]', 'density-compact');
        await take.waitFor(() => window.__SETTINGS_STORE__?.getState?.().listDensity === 'compact', 'compact', 3000);
        await take.hold(1100);
        await take.click('[data-footage-target="density-comfortable"]', 'density-comfortable');
        await take.waitFor(() => window.__SETTINGS_STORE__?.getState?.().listDensity === 'comfortable', 'comfortable', 3000);
        await take.hold(700);
        await take.reveal(LINES, 'lines-reveal', { ms: 900 });
        await take.hold(400);
        for (const [key, n] of [['listPreview.one', 1], ['listPreview.two', 2], ['listPreview.three', 3]]) {
          await take.click(LINES, `lines-${n}`, { text: L(key) });
          await take.waitFor((v) => window.__SETTINGS_STORE__?.getState?.().listPreviewLines === v, `${n} lines`, 3000, n);
          await take.hold(900);
        }
        facts.c45InView = await browser.execute(() => {
          const pane = document.querySelector('[data-testid="settings-page"]');
          const vis = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return b.top > 0 && b.bottom < window.innerHeight; };
          return { lines: vis('[data-testid="list-preview-lines"]'), pane: !!pane };
        });
        await take.click(CLOSE_SETTINGS, 'close-settings');
        await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 8000);
        await take.moveTo(SEL.row, 'list');
        facts.c45Rows = await browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 5)
          .map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 160)));
        console.log(`[footage] c45 rows ${JSON.stringify(facts.c45Rows)}`);
        await take.hold(2600);
      }, {
        prepare: async () => {
          facts.c45IndexSettled = await indexSettled();
          // Start from no preview lines and roomy rows, so the change reads.
          await setSetting('listPreviewLines', 0);
          await setSetting('listDensity', 'comfortable');
          await browser.pause(600);
        },
      });
    } finally {
      if (want('c45-preview-lines')) {
        if (was.listPreviewLines !== undefined) await setSetting('listPreviewLines', was.listPreviewLines);
        if (was.listDensity !== undefined) await setSetting('listDensity', was.listDensity);
      }
    }
  });

  // 46. Attachment preview: the photo's thumbnail, then the photo and the PDF in place.
  it('c46-attachment-preview', async function () {
    const DIALOG = '[data-testid="attachment-preview-dialog"]';
    const CLOSE = `${DIALOG} button[aria-label="${L('common.close')}"]`;
    await shoot(this, 'c46-attachment-preview', async (take) => {
      await take.hold(1000);
      await take.reveal(SEL.row, 'row-reveal', { text: ATTACH_SUBJECT, ms: 700 });
      await take.click(SEL.row, 'proofs-row', { text: ATTACH_SUBJECT });
      await take.waitFor(readerOpen, 'reader', 10000, L('viewer.selectEmailRead'));
      await take.waitFor(() => document.querySelectorAll('[data-testid="attachment-item"]').length >= 2
        && [...document.querySelectorAll('[data-testid="attachment-thumb"]')].some((i) => i.complete && i.naturalWidth > 0), 'thumbnail', 15000);
      facts.c46Items = await browser.execute(() => [...document.querySelectorAll('[data-testid="attachment-item"]')].map((r) => (r.innerText || '').replace(/\s+/g, ' ')));
      await browser.execute(() => {
        for (const item of document.querySelectorAll('[data-testid="attachment-item"]')) {
          const b = item.querySelector('[data-testid="attachment-preview"]');
          if (!b) continue;
          if ((item.innerText || '').includes('cover-photo')) b.setAttribute('data-footage-target', 'prev-img');
          if ((item.innerText || '').includes('menu-proof')) b.setAttribute('data-footage-target', 'prev-pdf');
        }
      });
      await take.hold(1300);
      await take.click('[data-footage-target="prev-img"]', 'preview-photo');
      await take.waitFor(() => [...document.querySelectorAll('[data-testid="attachment-preview-image"]')].some((i) => i.complete && i.naturalWidth > 0), 'photo preview', 10000);
      await take.hold(1900);
      await take.click(CLOSE, 'close-photo');
      await take.waitFor((s) => !document.querySelector(s), 'photo closed', 5000, DIALOG);
      await take.hold(500);
      await take.click('[data-footage-target="prev-pdf"]', 'preview-pdf');
      await take.waitFor(visible, 'pdf preview', 10000, '[data-testid="attachment-preview-pdf"]');
      await take.hold(3200);
      facts.c46Pdf = await browser.execute(() => {
        const f = document.querySelector('[data-testid="attachment-preview-pdf"]');
        return f ? { src: (f.getAttribute('src') || '').slice(0, 30), h: f.getBoundingClientRect().height } : null;
      });
      await take.click(CLOSE, 'close-pdf');
      await take.waitFor((s) => !document.querySelector(s), 'pdf closed', 5000, DIALOG);
      await take.hold(800);
      console.log(`[footage] c46 items ${JSON.stringify(facts.c46Items)} pdf ${JSON.stringify(facts.c46Pdf)}`);
    });
  });

  // 47. Reply starters: one click fills Compose, the reply is edited, never sent.
  it('c47-reply-starters', async function () {
    const CHIP = '[data-testid="quick-reply-chip"]';
    await shoot(this, 'c47-reply-starters', async (take) => {
      await take.hold(1000);
      await take.reveal(SEL.row, 'row-reveal', { text: STARTER_SUBJECT, ms: 700 });
      await take.click(SEL.row, 'tasting-row', { text: STARTER_SUBJECT });
      await take.waitFor(readerOpen, 'reader', 10000, L('viewer.selectEmailRead'));
      await take.waitFor(visible, 'starters', 10000, CHIP);
      facts.c47Chips = await browser.execute((s) => [...document.querySelectorAll(s)].map((c) => c.innerText), CHIP);
      const pick = facts.c47Chips.find((c) => c === L('ai.quickReply.time.accept')) || facts.c47Chips[0];
      facts.c47Pick = pick;
      await take.moveTo(CHIP, 'starters', { text: facts.c47Chips[facts.c47Chips.length - 1] });
      await take.hold(1200);
      await take.click(CHIP, 'starter', { text: pick });
      await take.waitFor(composeOpen, 'compose', 10000, EDITOR);
      await take.waitFor((s, p) => (document.querySelector(s)?.innerText || '').includes(p), 'starter in compose', 5000, EDITOR, pick);
      await take.hold(900);
      // The caret goes to the end of the starter's own line, then the reply is edited there.
      facts.c47Caret = await browser.execute((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        el.focus();
        const block = el.firstElementChild || el;
        const range = document.createRange();
        range.selectNodeContents(block);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return (block.innerText || '').slice(0, 80);
      }, EDITOR);
      if (facts.c47Caret && facts.c47Caret.includes(pick)) {
        await take.typeRich(EDITOR, '. See you at 3, I will bring the menu proofs.', 'edit-reply', { base: 55, jitter: 20, seed: 47, caret: 'keep' });
      }
      facts.c47Body = await browser.execute((s) => (document.querySelector(s)?.innerText || '').slice(0, 200), EDITOR);
      console.log(`[footage] c47 chips ${JSON.stringify(facts.c47Chips)} caret "${facts.c47Caret}" body ${JSON.stringify(facts.c47Body)}`);
      await take.hold(2400);
    }, { prepare: composeInApp });
  });

  // 48. Templates: add one in Settings, insert it into a new message.
  it('c48-templates', async function () {
    const CARD = '[data-testid="settings-templates"]';
    const NAME = `${CARD} input[aria-label="${L('settings.templates.templateName')}"]`;
    const BODY = `${CARD} textarea[aria-label="${L('settings.templates.templateBody')}"]`;
    const name = 'Proof follow-up';
    const text = 'Thanks for the proofs. Two small notes below, otherwise we are good to print.';
    await shoot(this, 'c48-templates', async (take) => {
      await take.hold(900);
      await toSettingsPage(take, L('settings.tab.templates'), visible, 'templates page', CARD);
      await take.hold(600);
      await take.click(`${CARD} button`, 'add-template', { text: L('settings.templates.addTemplate') });
      await take.waitFor(visible, 'template form', 5000, NAME);
      await take.click(NAME, 'template-name');
      await take.type(NAME, name, 'name', { base: 75, jitter: 25, seed: 48 });
      await take.click(BODY, 'template-body');
      await take.type(BODY, text, 'body', { base: 38, jitter: 15, seed: 49 });
      await take.hold(400);
      await take.click(`${CARD} button`, 'save-template', { text: L('common.save') });
      await take.waitFor((n) => (window.__SETTINGS_STORE__?.getState?.().emailTemplates || []).some((t) => t.name === n), 'template saved', 5000, name);
      await take.hold(1000);
      await take.click(CLOSE_SETTINGS, 'close-settings');
      await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 8000);
      await take.hold(500);
      await take.click(COMPOSE_BTN, 'compose');
      await take.waitFor(composeOpen, 'compose', 10000, EDITOR);
      await take.hold(500);
      await take.click('[data-testid="compose-subject"]', 'subject');
      await take.type('[data-testid="compose-subject"]', 'Autumn card', 'subject', { base: 70, jitter: 25, seed: 50 });
      await take.hold(300);
      await take.click('[data-testid="compose-templates-btn"]', 'templates');
      await take.waitFor(visible, 'template list', 5000, '[data-testid="compose-template-item"]');
      await take.hold(900);
      await take.click('[data-testid="compose-template-item"]', 'insert-template', { text: name });
      await take.waitFor((s, t) => (document.querySelector(s)?.innerText || '').includes(t), 'template inserted', 5000, EDITOR, text.slice(0, 30));
      facts.c48Body = await browser.execute((s) => (document.querySelector(s)?.innerText || '').slice(0, 200), EDITOR);
      console.log(`[footage] c48 body ${JSON.stringify(facts.c48Body)}`);
      await take.hold(2400);
    }, { prepare: composeInApp });
  });

  // 49. Signature images: a pasted logo, selected (corner handles), resized, the 3x offer.
  it('c49-signature-images', async function () {
    const SIG = '[data-testid="settings-page"] .ProseMirror[contenteditable="true"]';
    const IMG = `${SIG} img`;
    const HANDLE = `${SIG} .ProseMirror-selectednode [data-resize-handle="bottom-right"]`;
    await shoot(this, 'c49-signature-images', async (take) => {
      await take.hold(900);
      await toSettingsPage(take, L('settings.tab.accounts'), visible, 'signature editor', SIG);
      await take.reveal(SIG, 'signature-reveal', { ms: 900 });
      facts.c49Initial = await browser.execute((s) => document.querySelector(s)?.innerHTML?.slice(0, 300), SIG);
      await take.hold(600);
      await take.click(SIG, 'signature');
      const empty = await browser.execute((s) => !(document.querySelector(s)?.innerText || '').trim(), SIG);
      if (empty) await take.typeRich(SIG, 'Rowan Marsh, Prime Cut Studio\n', 'signature-text', { base: 50, jitter: 18, seed: 51, caret: 'end' });
      else await browser.execute((s) => { const el = document.querySelector(s); el.focus(); const r = document.createRange(); r.selectNodeContents(el.lastElementChild || el); r.collapse(false); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }, SIG);
      await take.hold(500);
      // The logo, drawn in the page and pasted the way Cmd+V delivers a copied picture.
      const pasted = await browser.executeAsync((s, done) => {
        const el = document.querySelector(s);
        if (!el) { done({ error: 'no editor' }); return; }
        const W = Math.max(480, Math.min(620, Math.floor(el.clientWidth - 48)));
        const H = Math.round(W / 5);
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, W, H);
        grad.addColorStop(0, '#7c2d12'); grad.addColorStop(1, '#c2410c');
        g.fillStyle = grad; g.fillRect(0, 0, W, H);
        for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(255,255,255,${0.02 + (i % 5) * 0.012})`; g.fillRect((i * 37) % W, 0, 6, H); }
        g.fillStyle = '#fff7ed';
        g.beginPath(); g.arc(H * 0.55, H / 2, H * 0.32, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#7c2d12';
        g.font = `bold ${Math.round(H * 0.34)}px Georgia, serif`; g.textBaseline = 'middle'; g.textAlign = 'center';
        g.fillText('PC', H * 0.55, H / 2 + 1);
        g.fillStyle = '#fff7ed'; g.textAlign = 'left';
        g.font = `bold ${Math.round(H * 0.36)}px Helvetica, Arial, sans-serif`;
        g.fillText('PRIME CUT', H * 1.05, H * 0.42);
        g.font = `${Math.round(H * 0.17)}px Helvetica, Arial, sans-serif`;
        g.fillText('S T U D I O', H * 1.07, H * 0.74);
        c.toBlob((blob) => {
          if (!blob) { done({ error: 'no blob' }); return; }
          const file = new File([blob], 'prime-cut-logo.jpg', { type: 'image/jpeg' });
          const dt = new DataTransfer();
          dt.items.add(file);
          let how = null;
          try {
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            if (ev.clipboardData && ev.clipboardData.files.length) { el.dispatchEvent(ev); how = 'ClipboardEvent'; }
          } catch { /* not supported: below */ }
          if (!how) {
            const ev = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'clipboardData', { value: dt });
            el.dispatchEvent(ev);
            how = 'Event+clipboardData';
          }
          done({ how, W, H, bytes: blob.size });
        }, 'image/jpeg', 0.95);
      }, SIG);
      facts.c49Paste = pasted;
      if (pasted.error) throw new Error(`paste: ${pasted.error}`);
      const landed = await take.waitFor((s) => [...document.querySelectorAll(s)].some((i) => i.complete && i.naturalWidth > 0), 'logo in signature', 5000, IMG)
        .then(() => true, () => false);
      if (!landed) throw new Error(`pasted logo never showed (${JSON.stringify(pasted)})`);
      console.log(`[footage] c49 paste ${JSON.stringify(pasted)}`);
      await take.reveal(IMG, 'logo-reveal', { ms: 500 });
      await take.hold(1000);
      await take.click(IMG, 'select-logo');
      const selected = await browser.execute((s) => !!document.querySelector(s), HANDLE);
      facts.c49Selected = selected;
      if (!selected) throw new Error('clicking the logo did not select it (no handles)');
      await take.hold(1300);
      const size = await browser.execute((s) => { const i = document.querySelector(s); const b = i.getBoundingClientRect(); return { w: b.width, h: b.height, nw: i.naturalWidth }; }, IMG);
      const finalW = Math.min(150, Math.floor((size.nw - 2) / 3) - 8);
      const dx = finalW - size.w;
      facts.c49Resize = { ...size, finalW, dx };
      await mouseDrag(take, HANDLE, dx, dx * size.h / size.w, 'resize-logo', 1300);
      await take.waitFor(visible, 'scale offer', 8000, '[data-testid="image-scale"]');
      facts.c49Offer = await browser.execute(() => (document.querySelector('[data-testid="image-scale"]')?.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
      console.log(`[footage] c49 resize ${JSON.stringify(facts.c49Resize)} offer "${facts.c49Offer}"`);
      await take.hold(2200);
      await take.click('[data-testid="image-scale-apply"]', 'scale-3x');
      await take.waitFor(() => !document.querySelector('[data-testid="image-scale"]'), 'offer closed', 5000);
      await take.hold(1800);
      facts.c49After = await browser.execute((s) => { const i = document.querySelector(s); return i ? { w: i.getBoundingClientRect().width, nw: i.naturalWidth } : null; }, IMG);
    });
  });

  // 50. Code as code: a received plain-text message with inline and fenced code.
  it('c50-code-as-code', async function () {
    await shoot(this, 'c50-code-as-code', async (take) => {
      await take.hold(1000);
      await take.reveal(SEL.row, 'row-reveal', { text: CODE_SUBJECT, ms: 700 });
      await take.click(SEL.row, 'code-row', { text: CODE_SUBJECT });
      await take.waitFor(readerOpen, 'reader', 10000, L('viewer.selectEmailRead'));
      await take.waitFor(() => [...document.querySelectorAll('pre')].some((p) => (p.innerText || '').includes('grilltheory.co/embed')), 'code block', 10000);
      facts.c50 = await browser.execute(() => ({
        pre: [...document.querySelectorAll('pre')].filter((p) => (p.innerText || '').includes('grilltheory')).length,
        inline: [...document.querySelectorAll('code')].map((c) => c.innerText).slice(0, 8),
      }));
      console.log(`[footage] c50 ${JSON.stringify(facts.c50)}`);
      await take.hold(1500);
      await tagFirst('pre', 'grilltheory.co/embed', 'code-block');
      await take.moveTo('[data-footage-target="code-block"]', 'code-block');
      await take.hold(3200);
    });
  });
});
