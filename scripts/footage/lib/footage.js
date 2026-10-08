/**
 * Footage plumbing for the app preview video: the recorder process and the
 * action log (`actions.json`, schema in video/capture/README.md).
 *
 * A scene script does, in order:
 *
 *   const take = new Take('s4-search');
 *   await take.start();                  // recorder running, t = 0 is its first frame
 *   await take.click(sel, 'search-toggle');
 *   await take.type(sel, 'invoice', 'search-box');
 *   await take.stop();                   // file finalised, actions.json written
 *
 * Every action runs IN THE PAGE and stamps itself with the page's own Date.now()
 * at the moment it dispatches (the same wall clock the recorder's START uses),
 * plus the time of the next animation frame, which is the frame that will first
 * show its effect. The cursor is not recorded: the compositor redraws it from
 * the logged positions.
 *
 * tauri-wd limits this works around (see the e2e memory notes): performActions
 * sends MouseEvents only, there is no hover and no dblclick, and `browser.keys`
 * never reaches an input's value. So clicks are dispatched in the page as a
 * pointer + mouse sequence at the target's centre, and typing goes through the
 * React value setter one character at a time with keydown/input/keyup.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { windowId } from '../../screenshots/capture.js';

export const OUT_DIR = process.env.FOOTAGE_OUT || join(process.cwd(), 'footage-out');
const RECORDER = process.env.FOOTAGE_RECORDER || '';
const FPS = Number(process.env.FOOTAGE_FPS || 60);
const CODEC = process.env.FOOTAGE_CODEC || 'hevc';
const BITRATE = process.env.FOOTAGE_BITRATE || '80';
// window | display: see the --mode note in video/capture/recorder.swift.
const MODE = process.env.FOOTAGE_CAPTURE || 'app';
// FOOTAGE_VERIFY=1: every take runs its steps and assertions with the same
// holds, but no recorder starts and nothing is written for the encoder
// (scripts/footage/web-clips-job.sh verify). The theme, scale and window
// checks still run.
export const VERIFY = process.env.FOOTAGE_VERIFY === '1';

/**
 * Size the footage is shot at, "WxH" in points: the web content (Tauri's inner
 * size). The window adds its 32 pt title bar, so 1536x928 is a 1536x960 window,
 * which is exactly the mini's visible frame height and records at 3072x1920.
 */
export function windowSize() {
  const [w, h] = (process.env.FOOTAGE_WINDOW || '1536x928').split('x').map(Number);
  return { width: w, height: h };
}

/** Raise the async-script timeout; the WebDriver default (30 s) is fine if a driver refuses. */
async function scriptTimeout(ms) {
  try { await browser.setTimeout({ script: ms }); } catch (e) { console.warn(`[take] setTimeout(script) refused: ${e.message}`); }
}

/** Seeded pseudo-random, so a re-take types with the same rhythm. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Human key rhythm: ~90 ms +- 35 ms, a little longer after a space. */
export function typingDelays(text, { base = 90, jitter = 35, seed = 7 } = {}) {
  const r = rng(seed);
  return [...text].map((ch) => Math.round(base + (r() * 2 - 1) * jitter + (ch === ' ' ? 60 : 0)));
}

// ── Page-side actions ───────────────────────────────────────────────────────
// Each runs through executeAsync: a plain `execute` with an async callback
// returns {} under tauri-wd. They receive only serialisable arguments.

/** Box of the first visible match, in viewport CSS px (null when none). */
const BOX = (selector, text) => {
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (text && !(el.innerText || el.value || '').includes(text)) continue;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  return null;
};

function pageClick(selector, text, done) {
  // A disabled control is skipped: clicking it would log a click the app ignored.
  const find = () => {
    for (const el of document.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || el.disabled) continue;
      if (text && !(el.innerText || '').includes(text)) continue;
      return { el, r };
    }
    return null;
  };
  const hit = find();
  if (!hit) { done({ error: `nothing visible and enabled matches ${selector}${text ? ` containing "${text}"` : ''}` }); return; }
  const { el, r } = hit;
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  // What a real pointer would land on. A different, unrelated element there
  // means the target is covered, and the footage would show a click on nothing.
  const top = document.elementFromPoint(x, y);
  const covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
  const target = top && el.contains(top) ? top : el;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, view: window };
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const at = Date.now();
  target.dispatchEvent(new PointerEvent('pointerover', pointer));
  target.dispatchEvent(new MouseEvent('mouseover', base));
  target.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
  target.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1, detail: 1 }));
  // A real click focuses a text field, not a button (WebKit on macOS leaves
  // buttons unfocused; a scripted focus() on one would paint a focus ring).
  if (typeof el.focus === 'function' && el.matches('input, textarea, select, [contenteditable="true"]')) el.focus({ preventScroll: true });
  target.dispatchEvent(new PointerEvent('pointerup', pointer));
  target.dispatchEvent(new MouseEvent('mouseup', { ...base, detail: 1 }));
  target.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
  requestAnimationFrame(() => done({ at, raf: Date.now(), box: { x: r.x, y: r.y, w: r.width, h: r.height }, covered }));
}

function pageType(selector, text, delays, follow, done) {
  const input = [...document.querySelectorAll(selector)].find((e) => e.offsetHeight > 0);
  if (!input) { done({ error: `no visible ${selector}` }); return; }
  const r = input.getBoundingClientRect();
  const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  if (document.activeElement !== input) input.focus({ preventScroll: true });
  const log = [];
  const chars = [...text];
  let i = 0;
  const step = () => {
    if (i >= chars.length) { setTimeout(() => done({ log, box: { x: r.x, y: r.y, w: r.width, h: r.height } }), 40); return; }
    const ch = chars[i];
    const key = { key: ch, bubbles: true, cancelable: true, composed: true };
    const entry = { ch, at: Date.now() };
    input.dispatchEvent(new KeyboardEvent('keydown', key));
    input.dispatchEvent(new KeyboardEvent('keypress', key));
    setter.call(input, input.value + ch);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    // opts.follow: keep the caret and the text's end in view, as real typing
    // does (a value set through the setter never scrolls a narrow field).
    if (follow) {
      const end = input.value.length;
      try { input.setSelectionRange(end, end); } catch { /* not a text field */ }
      input.scrollLeft = input.scrollWidth;
    }
    input.dispatchEvent(new KeyboardEvent('keyup', key));
    requestAnimationFrame(() => { entry.raf = Date.now(); });
    log.push(entry);
    const wait = delays[i];
    i += 1;
    setTimeout(step, wait);
  };
  step();
}

function pageSubmit(selector, done) {
  const input = [...document.querySelectorAll(selector)].find((e) => e.offsetHeight > 0);
  if (!input) { done({ error: `no visible ${selector}` }); return; }
  const r = input.getBoundingClientRect();
  const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
  const at = Date.now();
  const go = input.dispatchEvent(new KeyboardEvent('keydown', key));
  // An implicit submission is what Enter does in a form field; requestSubmit
  // runs the form's own onSubmit exactly as that would.
  if (go && input.form) input.form.requestSubmit();
  input.dispatchEvent(new KeyboardEvent('keyup', key));
  requestAnimationFrame(() => done({ at, raf: Date.now(), box: { x: r.x, y: r.y, w: r.width, h: r.height }, form: !!input.form }));
}

/**
 * A right-click on `selector`: button-2 pointerdown, mousedown and the
 * contextmenu macOS fires on the press (the row's quick actions open on that
 * pointerdown), then the release on the SAME element. Not elementFromPoint:
 * once a wheel opens under the pointer, the top element there is the wheel.
 */
function pageRightClick(selector, text, done) {
  const el = [...document.querySelectorAll(selector)].find((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!text || (e.innerText || '').includes(text));
  });
  if (!el) { done({ error: `nothing visible matches ${selector}${text ? ` containing "${text}"` : ''}` }); return; }
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 2, view: window };
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const at = Date.now();
  el.dispatchEvent(new PointerEvent('pointerover', { ...pointer, button: -1 }));
  el.dispatchEvent(new MouseEvent('mouseover', { ...base, button: 0 }));
  el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 2 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 2, detail: 1 }));
  el.dispatchEvent(new MouseEvent('contextmenu', { ...base, buttons: 2, detail: 1 }));
  setTimeout(() => {
    el.dispatchEvent(new PointerEvent('pointerup', pointer));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, detail: 1 }));
    requestAnimationFrame(() => done({ at, raf: Date.now(), box: { x: r.x, y: r.y, w: r.width, h: r.height } }));
  }, 110);
}

/** Pointer over `selector` (React's onMouseEnter reads mouseover). */
function pageHover(selector, text) {
  const el = [...document.querySelectorAll(selector)].find((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!text || (e.innerText || '').includes(text));
  });
  if (!el) return { error: `nothing visible matches ${selector}` };
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  // The pointer leaves what it last hovered on its way here.
  document.querySelectorAll('[data-footage-hovered]').forEach((h) => {
    h.removeAttribute('data-footage-hovered');
    if (h === el) return;
    const out = { ...base, relatedTarget: el };
    h.dispatchEvent(new PointerEvent('pointerout', { ...out, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    h.dispatchEvent(new MouseEvent('mouseout', out));
  });
  el.setAttribute('data-footage-hovered', '1');
  el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseover', base));
  return { box: { x: r.x, y: r.y, w: r.width, h: r.height } };
}

/** The pointer leaves whatever pageHover last entered (mouseout to the body). */
function pageUnhover() {
  const el = document.querySelector('[data-footage-hovered]');
  if (!el) return false;
  el.removeAttribute('data-footage-hovered');
  const base = { bubbles: true, cancelable: true, composed: true, relatedTarget: document.body, view: window };
  el.dispatchEvent(new PointerEvent('pointerout', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseout', base));
  return true;
}

/**
 * A left-button drag from `selector`'s centre by (dx, dy) over `ms`: every
 * move and the release go to the pressed element (a handle that captures the
 * pointer listens on itself), eased in-out.
 */
function pageDrag(selector, text, dx, dy, ms, done) {
  const el = [...document.querySelectorAll(selector)].find((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!text || (e.getAttribute('aria-label') || e.innerText || '').includes(text));
  });
  if (!el) { done({ error: `nothing visible matches ${selector}${text ? ` labelled "${text}"` : ''}` }); return; }
  const r = el.getBoundingClientRect();
  const x0 = r.x + r.width / 2, y0 = r.y + r.height / 2;
  const ev = (x, y, buttons) => ({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y,
    button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window });
  const at = Date.now();
  let captureError = null;
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', ev(x0, y0, 1)));
  } catch (e) { captureError = String(e?.message || e); }
  el.dispatchEvent(new MouseEvent('mousedown', ev(x0, y0, 1)));
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const start = performance.now();
  const step = () => {
    const p = Math.min(1, (performance.now() - start) / ms);
    const x = x0 + dx * ease(p), y = y0 + dy * ease(p);
    el.dispatchEvent(new PointerEvent('pointermove', ev(x, y, 1)));
    if (p < 1) { requestAnimationFrame(step); return; }
    setTimeout(() => {
      el.dispatchEvent(new PointerEvent('pointerup', ev(x, y, 0)));
      el.dispatchEvent(new MouseEvent('mouseup', ev(x, y, 0)));
      requestAnimationFrame(() => done({ at, end: Date.now(), from: { x: x0, y: y0 }, to: { x, y }, box: { x: r.x, y: r.y, w: r.width, h: r.height }, captureError }));
    }, 180);
  };
  requestAnimationFrame(step);
}

/**
 * Rich-text typing (the compose editor is ProseMirror, which ignores a value
 * setter and synthetic key presses): one `insertText` per character at the
 * caret, which ProseMirror reads back from the DOM the way it reads a real
 * keystroke. "\n" is a real Enter keydown, which ProseMirror turns into a
 * paragraph.
 */
function pageTypeRich(selector, text, delays, caret, done) {
  const el = [...document.querySelectorAll(selector)].find((e) => e.offsetHeight > 0);
  if (!el) { done({ error: `no visible ${selector}` }); return; }
  const r = el.getBoundingClientRect();
  el.focus();
  // 'end': after the last block (a new message); 'start': in the first block
  // (a reply, whose quote sits below the empty first paragraph); 'keep': where
  // the editor put it.
  if (caret !== 'keep') {
    const block = caret === 'start' ? (el.firstElementChild || el) : (el.lastElementChild || el);
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(caret === 'start');
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const log = [];
  const chars = [...text];
  let i = 0;
  const step = () => {
    if (i >= chars.length) { setTimeout(() => done({ log, text: el.innerText, box: { x: r.x, y: r.y, w: r.width, h: r.height } }), 40); return; }
    const ch = chars[i];
    const entry = { ch, at: Date.now() };
    if (ch === '\n') {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    } else {
      let ok = false;
      try { ok = document.execCommand('insertText', false, ch); } catch { ok = false; }
      entry.ok = ok;
    }
    requestAnimationFrame(() => { entry.raf = Date.now(); });
    log.push(entry);
    const wait = delays[i];
    i += 1;
    setTimeout(step, wait);
  };
  step();
}

/**
 * An eased scroll of the element `selector` scrolls (or its first scrolling
 * ancestor): `dy` px over `ms`, ease-in-out, one step per animation frame.
 * Reads as a trackpad flick with a soft landing rather than a jump.
 */
function pageScrollEase(selector, dy, ms, done) {
  const start = [...document.querySelectorAll(selector)].find((e) => e.offsetHeight > 0);
  if (!start) { done({ error: `no visible ${selector}` }); return; }
  let el = start;
  while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
  if (!el) { done({ error: `nothing scrolls around ${selector}` }); return; }
  const r = el.getBoundingClientRect();
  const from = el.scrollTop;
  const to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, from + dy));
  const at = Date.now();
  const t0 = performance.now();
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const frame = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    el.scrollTop = from + (to - from) * ease(k);
    if (k < 1) requestAnimationFrame(frame);
    else done({ at, end: Date.now(), moved: to - from, box: { x: r.x, y: r.y, w: r.width, h: r.height } });
  };
  requestAnimationFrame(frame);
}

/**
 * Bring the first visible match of `selector` (containing `text`) to the
 * middle of the element that scrolls around it, with the same eased motion as
 * pageScrollEase. No-op (moved 0) when it is already comfortably in view.
 */
function pageReveal(selector, text, ms, done) {
  const target = [...document.querySelectorAll(selector)]
    .find((e) => e.getClientRects().length > 0 && (!text || (e.innerText || e.value || '').includes(text)));
  if (!target) { done({ error: `nothing matches ${selector}${text ? ` containing "${text}"` : ''}` }); return; }
  let el = target.parentElement;
  while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  if (!el) { done({ at: Date.now(), end: Date.now(), moved: 0, box: null }); return; }
  const r = el.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const margin = 80;
  let dy = 0;
  if (t.bottom > r.bottom - margin || t.top < r.top + margin) dy = (t.top + t.height / 2) - (r.top + r.height / 2);
  const from = el.scrollTop;
  const to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, from + dy));
  const at = Date.now();
  if (Math.abs(to - from) < 2) { done({ at, end: at, moved: 0, box: { x: r.x, y: r.y, w: r.width, h: r.height } }); return; }
  const t0 = performance.now();
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const frame = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    el.scrollTop = from + (to - from) * ease(k);
    if (k < 1) requestAnimationFrame(frame);
    else done({ at, end: Date.now(), moved: to - from, box: { x: r.x, y: r.y, w: r.width, h: r.height } });
  };
  requestAnimationFrame(frame);
}

function pageWheel(selector, dy, steps, gap, done) {
  const el = [...document.querySelectorAll(selector)].find((e) => e.offsetHeight > 0);
  if (!el) { done({ error: `no visible ${selector}` }); return; }
  const r = el.getBoundingClientRect();
  const at = Date.now();
  let n = 0;
  const tick = () => {
    if (n >= steps) { requestAnimationFrame(() => done({ at, end: Date.now(), box: { x: r.x, y: r.y, w: r.width, h: r.height } })); return; }
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy / steps, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    el.scrollBy({ top: dy / steps, behavior: 'instant' });
    n += 1;
    setTimeout(tick, gap);
  };
  tick();
}

// ── Take ────────────────────────────────────────────────────────────────────

export class Take {
  constructor(name, { travelMs = 650 } = {}) {
    this.name = name;
    this.travelMs = travelMs;
    this.events = [];
    this.startEpochMs = null;
    this.proc = null;
    this.clip = join(OUT_DIR, `${name}.mov`);
    this.stdout = '';
    this.stderr = '';
    this.viewport = null;
    this.cursor = null;
    this.boxes = {};
    this.notes = {};
  }

  /** Seconds since the first recorded frame. */
  t(epochMs) { return (epochMs - this.startEpochMs) / 1000; }

  log(event) {
    this.events.push(event);
    const where = event.x != null ? ` @${event.x.toFixed(0)},${event.y.toFixed(0)}` : '';
    console.log(`[take] ${event.t.toFixed(3)}s ${event.type} ${event.label}${where}${event.text ? ` "${event.text}"` : ''}`);
  }

  async start({ startTimeoutMs = 15000 } = {}) {
    if (!VERIFY && (!RECORDER || !existsSync(RECORDER))) throw new Error(`FOOTAGE_RECORDER not set or missing: "${RECORDER}"`);
    mkdirSync(OUT_DIR, { recursive: true });
    this.viewport = await browser.execute(() => ({
      innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
      visibility: document.visibilityState,
      theme: document.documentElement.getAttribute('data-theme'),
      palette: document.documentElement.getAttribute('data-palette'),
    }));
    // Frame 0 must already be in the theme the run asked for (a light take that
    // starts dark would pass every other guard).
    const theme = process.env.FOOTAGE_THEME;
    if (theme && this.viewport.theme !== theme) {
      throw new Error(`page is data-theme="${this.viewport.theme}" data-palette="${this.viewport.palette}", expected ${theme}`);
    }
    const wid = windowId();
    console.log(`[take] ${this.name}: window ${wid}, viewport ${JSON.stringify(this.viewport)}`);
    // The mini's only display is a Screen Sharing virtual display whose mode has
    // been 1x before; a 1x session would quietly shoot a whole batch at half size.
    const scale = Number(process.env.FOOTAGE_EXPECT_SCALE || 2);
    if (this.viewport.dpr !== scale) throw new Error(`devicePixelRatio is ${this.viewport.dpr}, expected ${scale}: the display is not HiDPI`);
    if (VERIFY) {
      this.startEpochMs = Date.now();
      console.log(`[take] VERIFY ${this.name}: no recorder`);
      return this.startEpochMs;
    }
    this.proc = spawn(RECORDER, [wid, this.clip, '--fps', String(FPS), '--codec', CODEC, '--bitrate', BITRATE, '--mode', MODE],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (d) => { this.stderr += d; process.stderr.write(`[recorder] ${d}`); });
    this.exited = new Promise((res) => this.proc.on('exit', (code, sig) => res({ code, sig })));
    this.startEpochMs = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`recorder printed no START within ${startTimeoutMs} ms: ${this.stderr.trim()}`)), startTimeoutMs);
      this.proc.stdout.on('data', (d) => {
        this.stdout += d;
        const m = this.stdout.match(/^START ([\d.]+)$/m);
        if (m) { clearTimeout(timer); res(Number(m[1])); }
      });
      this.proc.on('exit', (code) => { clearTimeout(timer); rej(new Error(`recorder exited ${code} before START: ${this.stderr.trim()}`)); });
    });
    console.log(`[take] START ${this.startEpochMs}`);
    return this.startEpochMs;
  }

  /** Viewport CSS px -> window logical px is applied at write time (needs the window size). */
  box(selector, text) { return browser.execute(BOX, selector, text || ''); }

  async hold(ms) { await browser.pause(ms); }

  /**
   * The cursor starts travelling to the target now and arrives `dur` later,
   * which is when the click that follows lands.
   */
  async moveTo(selector, label, { text, dur = this.travelMs } = {}) {
    const b = await this.box(selector, text);
    if (!b) throw new Error(`move: nothing visible matches ${selector}`);
    const x = b.x + b.w / 2, y = b.y + b.h / 2;
    this.log({ t: this.t(Date.now()), type: 'move', x, y, bbox: b, label, dur: dur / 1000 });
    this.cursor = { x, y };
    await browser.pause(dur);
  }

  async click(selector, label, { text, move = true, dur } = {}) {
    if (move) await this.moveTo(selector, label, { text, dur });
    const r = await browser.executeAsync(pageClick, selector, text || '');
    if (r.error) throw new Error(`click ${label}: ${r.error}`);
    if (r.covered) console.warn(`[take] click ${label}: target is covered at its centre`);
    const x = r.box.x + r.box.w / 2, y = r.box.y + r.box.h / 2;
    this.log({ t: this.t(r.at), raf: this.t(r.raf), type: 'click', x, y, bbox: r.box, label });
    this.cursor = { x, y };
    return r;
  }

  /** A right-click (press and release) on `selector`; logged as a click with `button: 'right'`. */
  async rightClick(selector, label, { text, move = true, dur } = {}) {
    if (move) await this.moveTo(selector, label, { text, dur });
    const r = await browser.executeAsync(pageRightClick, selector, text || '');
    if (r.error) throw new Error(`right-click ${label}: ${r.error}`);
    const x = r.box.x + r.box.w / 2, y = r.box.y + r.box.h / 2;
    this.log({ t: this.t(r.at), raf: this.t(r.raf), type: 'click', button: 'right', x, y, bbox: r.box, label });
    this.cursor = { x, y };
    return r;
  }

  /** Move onto `selector` and hover it (tooltips, a wheel's center label). */
  async hover(selector, label, { text, dur } = {}) {
    await this.moveTo(selector, label, { text, dur });
    const r = await browser.execute(pageHover, selector, text || '');
    if (r.error) throw new Error(`hover ${label}: ${r.error}`);
    return r;
  }

  /** The pointer leaves the last hovered element (no cursor move). */
  async unhover() { return browser.execute(pageUnhover); }

  /**
   * A left-button drag of `selector` by (dx, dy) CSS px over `ms`, logged as a
   * `move` with `drag: true` from the press point to the release point.
   */
  async drag(selector, dx, dy, label, { text, ms = 1400 } = {}) {
    await this.moveTo(selector, label, { text });
    await scriptTimeout(ms + 15000);
    const r = await browser.executeAsync(pageDrag, selector, text || '', dx, dy, ms);
    if (r.error) throw new Error(`drag ${label}: ${r.error}`);
    this.log({ t: this.t(r.at), type: 'move', drag: true, x: r.to.x, y: r.to.y, from: r.from, bbox: r.box, label, dur: (r.end - r.at) / 1000 });
    this.cursor = { x: r.to.x, y: r.to.y };
    return r;
  }

  /** A field that took focus without a click (autofocus): a camera target. */
  async focus(selector, label) {
    const b = await this.box(selector);
    if (!b) throw new Error(`focus: nothing visible matches ${selector}`);
    this.log({ t: this.t(Date.now()), type: 'focus', x: b.x + b.w / 2, y: b.y + b.h / 2, bbox: b, label });
  }

  async type(selector, text, label, opts = {}) {
    const delays = typingDelays(text, opts);
    const total = delays.reduce((a, b) => a + b, 0);
    await scriptTimeout(total + 15000);
    const r = await browser.executeAsync(pageType, selector, text, delays, !!opts.follow);
    if (r.error) throw new Error(`type ${label}: ${r.error}`);
    const b = r.box;
    for (const e of r.log) {
      this.log({ t: this.t(e.at), raf: e.raf ? this.t(e.raf) : undefined, type: 'type', x: b.x + b.w / 2, y: b.y + b.h / 2, bbox: b, label, text: e.ch });
    }
  }

  async submit(selector, label) {
    const r = await browser.executeAsync(pageSubmit, selector);
    if (r.error) throw new Error(`submit ${label}: ${r.error}`);
    const b = r.box;
    this.log({ t: this.t(r.at), raf: this.t(r.raf), type: 'type', x: b.x + b.w / 2, y: b.y + b.h / 2, bbox: b, label, text: '\n', key: 'Enter' });
  }

  async scroll(selector, dy, label, { steps = 12, gap = 16 } = {}) {
    const r = await browser.executeAsync(pageWheel, selector, dy, steps, gap);
    if (r.error) throw new Error(`scroll ${label}: ${r.error}`);
    const b = r.box;
    this.log({ t: this.t(r.at), type: 'scroll', x: b.x + b.w / 2, y: b.y + b.h / 2, bbox: b, label, dy, dur: (r.end - r.at) / 1000 });
  }

  /**
   * An eased scroll of whatever scrolls around `selector` (see pageScrollEase):
   * logged as a `scroll` event with the distance it really moved.
   */
  async scrollEase(selector, dy, label, { ms = 2500 } = {}) {
    await scriptTimeout(ms + 15000);
    const r = await browser.executeAsync(pageScrollEase, selector, dy, ms);
    if (r.error) throw new Error(`scroll ${label}: ${r.error}`);
    const b = r.box;
    this.log({ t: this.t(r.at), type: 'scroll', x: b.x + b.w / 2, y: b.y + b.h / 2, bbox: b, label, dy: r.moved, dur: (r.end - r.at) / 1000, ease: 'inOutCubic' });
    return r;
  }

  /** Scroll `selector` into comfortable view first, when it is not (logged as a scroll). */
  async reveal(selector, label, { text, ms = 900 } = {}) {
    await scriptTimeout(ms + 15000);
    const r = await browser.executeAsync(pageReveal, selector, text || '', ms);
    if (r.error) throw new Error(`reveal ${label}: ${r.error}`);
    if (r.moved && r.box) {
      const b = r.box;
      this.log({ t: this.t(r.at), type: 'scroll', x: b.x + b.w / 2, y: b.y + b.h / 2, bbox: b, label: `${label}-reveal`, dy: r.moved, dur: (r.end - r.at) / 1000, ease: 'inOutCubic' });
    }
    return r;
  }

  /** Type into a rich-text editor (ProseMirror), one character at a time. */
  async typeRich(selector, text, label, opts = {}) {
    const delays = typingDelays(text, opts);
    const total = delays.reduce((a, b) => a + b, 0);
    await scriptTimeout(total + 15000);
    const r = await browser.executeAsync(pageTypeRich, selector, text, delays, opts.caret || 'end');
    if (r.error) throw new Error(`type ${label}: ${r.error}`);
    const b = r.box;
    for (const e of r.log) {
      this.log({ t: this.t(e.at), raf: e.raf ? this.t(e.raf) : undefined, type: 'type', x: b.x + b.w / 2, y: b.y + b.h / 2, bbox: b, label,
        text: e.ch, ...(e.ch === '\n' ? { key: 'Enter' } : {}) });
    }
    return r;
  }

  /**
   * The picture changes here without a pointer action the video can show (a
   * setting switched through the store because its control is a native menu
   * the driver cannot open). The compositor covers a `cut` with a cross-fade;
   * the cursor rests. Call it right before the change is made.
   */
  cut(label, note) {
    this.log({ t: this.t(Date.now()), type: 'cut', label, ...(note ? { note } : {}) });
  }

  /** A named box (viewport CSS px) to carry into actions.json `boxes`, in window points. */
  markBox(name, b) { this.boxes[name] = b; }

  /** A free-form note for actions.json `notes` (what the compositor should know). */
  note(key, value) { this.notes[key] = value; }

  /** Poll a page predicate (a function source run in the page). */
  async waitFor(pred, what, timeout = 20000, ...args) {
    await browser.waitUntil(() => browser.execute(pred, ...args), { timeout, interval: 100, timeoutMsg: `timed out waiting for ${what}` });
  }

  /**
   * A take that failed part way: stop its recorder so it cannot keep writing
   * underneath the next take, and mark the clip as aborted (no actions.json is
   * written, so run.sh skips it).
   */
  async abort() {
    if (VERIFY) return;
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill('SIGINT');
    await Promise.race([this.exited, new Promise((res) => setTimeout(res, 15000))]);
    console.warn(`[take] ${this.name}: aborted, recorder stopped`);
  }

  async stop() {
    if (VERIFY) {
      const seconds = this.t(Date.now());
      return { verify: true, seconds, delivered: Math.round(seconds * FPS), fps: FPS };
    }
    this.proc.kill('SIGINT');
    const { code, sig } = await Promise.race([
      this.exited,
      new Promise((res) => setTimeout(() => res({ code: 'timeout' }), 30000)),
    ]);
    const m = this.stdout.match(/^STOP (\d+) (\d+)$/m);
    if (code !== 0 || !m) throw new Error(`recorder did not stop cleanly (exit ${code}${sig ? ` ${sig}` : ''}): ${this.stderr.trim().slice(-600)}`);
    const rec = JSON.parse(readFileSync(`${this.clip}.json`, 'utf-8'));
    // Blank capture: pictures that were delivered but are all the same, or flat.
    // (Padded slots repeat by design and are not counted.)
    if (rec.blankSuspect) throw new Error(`blank capture: ${rec.delivered} delivered frames, ${rec.uniqueDelivered} distinct, ${rec.uniformDelivered} flat`);
    this.writeActions(rec);
    console.log(`[take] STOP written=${m[1]} dropped=${m[2]} delivered=${rec.delivered} padded=${rec.padded} unique=${rec.uniqueDelivered} cpu=${rec.cpuPercent.toFixed(0)}%`);
    // The clip must be the size every scene is composed for (window + 32 pt
    // title bar, at 2x, unless FOOTAGE_EXPECT says otherwise; "" skips).
    const { width, height } = windowSize();
    const expect = process.env.FOOTAGE_EXPECT ?? `${width * 2}x${(height + 32) * 2}`;
    if (expect && `${rec.pixelW}x${rec.pixelH}` !== expect) {
      throw new Error(`clip is ${rec.pixelW}x${rec.pixelH}, expected ${expect} (scale ${rec.scale}, window ${rec.logicalW}x${rec.logicalH} pt)`);
    }
    return rec;
  }

  writeActions(rec) {
    // The webview is bottom-aligned and horizontally centred in the window
    // (same assumption scripts/screenshots/capture.js makes for its crops).
    const vp = this.viewport;
    const ox = (rec.logicalW - vp.innerWidth) / 2;
    const oy = rec.logicalH - vp.innerHeight;
    const shift = (b) => (b ? { x: b.x + ox, y: b.y + oy, w: b.w, h: b.h } : null);
    // A `cut` has no position: the cursor rests where it is.
    const events = this.events.map((e) => (e.x == null ? { ...e } : {
      ...e,
      x: e.x + ox,
      y: e.y + oy,
      bbox: shift(e.bbox),
    }));
    const boxes = Object.fromEntries(Object.entries(this.boxes).map(([k, b]) => [k, shift(b)]));
    const actions = {
      version: 1,
      scene: this.name,
      clip: `${this.name}.mov`,
      fps: rec.fps,
      window: {
        logicalW: rec.logicalW, logicalH: rec.logicalH, scale: rec.scale, pixelW: rec.pixelW, pixelH: rec.pixelH,
        webview: { x: ox, y: oy, w: vp.innerWidth, h: vp.innerHeight },
      },
      recorderStartEpochMs: this.startEpochMs,
      durationSeconds: rec.seconds,
      events,
      boxes,
      notes: this.notes,
    };
    if (Math.abs(vp.dpr - rec.scale) > 0.01) console.warn(`[take] devicePixelRatio ${vp.dpr} != capture scale ${rec.scale}`);
    const path = join(OUT_DIR, `${this.name}.actions.json`);
    writeFileSync(path, JSON.stringify(actions, null, 2));
    console.log(`[take] wrote ${path} (${events.length} events)`);
  }
}

/**
 * CPU of every process while a take runs, sampled by `top` in the background.
 * Returns a function that waits for the sample and writes it to OUT_DIR.
 */
export function sampleLoad(name, seconds = 3) {
  const out = [];
  const p = spawn('top', ['-l', String(seconds + 1), '-s', '1', '-n', '12', '-o', 'cpu', '-stats', 'pid,command,cpu,mem'], { stdio: ['ignore', 'pipe', 'ignore'] });
  p.stdout.on('data', (d) => out.push(d));
  const done = new Promise((res) => p.on('exit', res));
  return async () => {
    await done;
    const text = Buffer.concat(out).toString();
    // The first top sample has no CPU history; keep the last one.
    const last = text.split(/^Processes:/m).pop();
    writeFileSync(join(OUT_DIR, `${name}.load.txt`), `Processes:${last}`);
    return last;
  };
}

/**
 * The E2E build switches framer-motion off (src/e2eMotion.js sets
 * MotionGlobalConfig.skipAnimations) because a hidden window freezes its
 * timeline. A footage window is raised and visible, so the real transitions
 * can run: find framer-motion's config object among the modules the page has
 * already loaded and switch it back. Only when the page is visible and native
 * animation frames are actually ticking; otherwise leave it alone.
 */
export async function restoreMotion() {
  await scriptTimeout(20000);
  const result = await browser.executeAsync((done) => {
    const ticks = (ms) => new Promise((res) => {
      let n = 0;
      const t0 = performance.now();
      const f = () => { n += 1; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(n); };
      requestAnimationFrame(f);
    });
    (async () => {
      const visibility = document.visibilityState;
      const rafPerSecond = (await ticks(1000));
      if (visibility !== 'visible' || rafPerSecond < 30) { done({ restored: false, visibility, rafPerSecond }); return; }
      const urls = new Set();
      for (const s of document.querySelectorAll('script[type="module"][src]')) urls.add(s.src);
      for (const l of document.querySelectorAll('link[rel="modulepreload"][href]')) urls.add(l.href);
      const found = [];
      for (const u of urls) {
        try {
          const mod = await import(u);
          for (const [k, v] of Object.entries(mod)) {
            if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'skipAnimations')) {
              found.push({ module: u.split('/').pop(), exportName: k, was: v.skipAnimations });
              v.skipAnimations = false;
            }
          }
        } catch (e) {
          found.push({ module: u.split('/').pop(), error: String(e).slice(0, 120) });
        }
      }
      done({ restored: found.some((f) => f.was !== undefined), visibility, rafPerSecond, found });
    })();
  });
  console.log('[take] motion:', JSON.stringify(result));
  writeFileSync(join(OUT_DIR, 'motion.json'), JSON.stringify(result, null, 2));
  return result;
}

/**
 * The real pointer, via video/capture/tools/cursor.swift (FOOTAGE_CURSOR_TOOL).
 * `pointer(x, y)` parks it (global points, top-left origin; no click, no
 * event), `pointer()` reads it. Parking it over the window's title bar before a
 * take makes "no cursor in the frames" evidence of showsCursor = false, without
 * giving the web content a hover.
 */
export function pointer(x, y) {
  const tool = process.env.FOOTAGE_CURSOR_TOOL;
  if (!tool || !existsSync(tool)) return 'no cursor tool';
  const args = x == null ? [] : ['set', String(Math.round(x)), String(Math.round(y))];
  try { return execFileSync(tool, args, { encoding: 'utf-8' }).trim(); } catch (e) { return `cursor tool failed: ${e.message}`; }
}

/** The real bounds of the window the recorder will see, from the window server. */
export function windowInfo() {
  try {
    windowId(); // compiles the helper on first use
    return execFileSync(join(import.meta.dirname, '../../screenshots/.windowid'), ['--info'], { encoding: 'utf-8' }).trim();
  } catch (e) {
    return `windowid --info failed: ${e.message}`;
  }
}
