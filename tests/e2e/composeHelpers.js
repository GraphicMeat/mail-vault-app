/**
 * Shared helpers for the compose-window e2e specs.
 *
 * Harness facts these lean on (tests/e2e/helpers.js and the existing compose
 * specs are the references):
 *  - WebDriver never delivers Escape to the webview → `pressEscape()` dispatches
 *    a synthetic keydown. Character keys DO arrive (`browser.keys('c')` opens
 *    compose), so typing into the editor goes through `browser.keys`.
 *  - The editor toolbar acts on mousedown (so the editor keeps focus) —
 *    `.click()` on those buttons does nothing. Use `clickToolbar()`.
 *  - A native file drag cannot be driven through WebDriver, so `dropFiles()` /
 *    `dragFilesOver()` / `pasteFiles()` build a DataTransfer inside the page and
 *    dispatch the events themselves. That exercises the page's handlers (the
 *    code under test). The native half is one config line
 *    (tauri.conf.json `dragDropEnabled: false`) and is not provable here.
 *  - framer-motion exits never finish under the occluded E2E window → assert
 *    on state the app makes visible (attributes, counts, text), not on an
 *    animated element's absence.
 *  - `expect(value, 'message')` throws in this runner — one argument only.
 */
import { pressKey } from './helpers.js';

export const MODAL = '[data-testid="compose-modal"]';
export const EDITOR = `${MODAL} .ProseMirror`;

// 1×1 transparent PNG — small enough to inline anywhere, a real image to the decoder.
export const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const PDF_STUB = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');

export const pngFile = (name = 'pixel.png') => ({ name, type: 'image/png', base64: PNG_1X1 });
export const pdfFile = (name = 'notes.pdf') => ({ name, type: 'application/pdf', base64: PDF_STUB });

// ---------------------------------------------------------------------------
// In-page DnD / clipboard tooling
// ---------------------------------------------------------------------------

/**
 * Install `window.__mvDnD` once per session. `browser.execute` serialises the
 * callback, so nothing from this module's scope is visible in the page — the
 * tools have to be defined inside the callback body.
 */
async function installDndTools() {
  await browser.execute(() => {
    if (window.__mvDnD) return;
    const toFile = (f) => {
      const bin = atob(f.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], f.name, { type: f.type });
    };
    const transfer = (files) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(toFile(f));
      return dt;
    };
    // DragEvent's constructor honours `dataTransfer` in current WebKit; the
    // fallback defines it by hand for an engine that drops it.
    const fire = (el, type, dt, x, y) => {
      let ev = null;
      try {
        ev = new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt });
      } catch { ev = null; }
      if (!ev || !ev.dataTransfer) {
        ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
      }
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const point = (el, where) => {
      const r = el.getBoundingClientRect();
      if (where && typeof where === 'object') return { x: where.x, y: where.y };
      switch (where) {
        case 'top-left': return { x: r.left + 4, y: r.top + 4 };
        case 'bottom-right': return { x: r.right - 4, y: r.bottom - 4 };
        default: return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    };
    window.__mvDnD = { transfer, fire, point };
  });
}

/**
 * Hover `files` over `selector`: dragenter + dragover, no drop. Returns
 * whether dragover was accepted (defaultPrevented).
 */
export async function dragFilesOver(selector, files, where = 'center') {
  await installDndTools();
  return browser.execute((sel, fs, wh) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const dt = window.__mvDnD.transfer(fs);
    const { x, y } = window.__mvDnD.point(el, wh);
    window.__mvDnD.fire(el, 'dragenter', dt, x, y);
    const accepted = window.__mvDnD.fire(el, 'dragover', dt, x, y);
    return { found: true, accepted };
  }, selector, files, where);
}

/** Leave `selector` with the drag still in progress (dragleave, no drop). */
export async function dragLeave(selector, files = [pngFile()]) {
  await installDndTools();
  return browser.execute((sel, fs) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const dt = window.__mvDnD.transfer(fs);
    const { x, y } = window.__mvDnD.point(el, 'center');
    window.__mvDnD.fire(el, 'dragleave', dt, x, y);
    return true;
  }, selector, files);
}

/**
 * Drop `files` on `selector` at `where` ('center' | 'top-left' |
 * 'bottom-right' | {x, y}): dragenter → dragover → drop, all on the same
 * element, the way WebKit sequences a real drop. Returns whether the drop was
 * claimed (defaultPrevented) — an unclaimed drop is what makes WebKit navigate
 * to the file.
 */
export async function dropFiles(selector, files, where = 'center') {
  await installDndTools();
  const result = await browser.execute((sel, fs, wh) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const dt = window.__mvDnD.transfer(fs);
    const { x, y } = window.__mvDnD.point(el, wh);
    window.__mvDnD.fire(el, 'dragenter', dt, x, y);
    window.__mvDnD.fire(el, 'dragover', dt, x, y);
    const claimed = window.__mvDnD.fire(el, 'drop', dt, x, y);
    return { found: true, claimed, x, y };
  }, selector, files, where);
  // FileReader + React state: give the handlers a beat to land.
  await browser.pause(400);
  return result;
}

/** Paste `files` into the editor as a clipboard event. */
export async function pasteFiles(files) {
  await installDndTools();
  const result = await browser.execute((sel, fs) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    el.focus();
    const dt = window.__mvDnD.transfer(fs);
    let ev = null;
    try {
      ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    } catch { ev = null; }
    if (!ev || !ev.clipboardData) {
      ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
    }
    el.dispatchEvent(ev);
    return { found: true, claimed: ev.defaultPrevented };
  }, EDITOR, files);
  await browser.pause(400);
  return result;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export const editorHtml = () => browser.execute((sel) => document.querySelector(sel)?.innerHTML ?? null, EDITOR);
export const editorText = () => browser.execute((sel) => document.querySelector(sel)?.innerText ?? null, EDITOR);
export const editorImages = () => browser.execute((sel) =>
  [...(document.querySelector(sel)?.querySelectorAll('img') || [])]
    .map((img) => ({ src: (img.getAttribute('src') || '').slice(0, 40), alt: img.getAttribute('alt') || '' })), EDITOR);

/**
 * Put `text` into the editor the way a keyboard would, as far as ProseMirror
 * can tell. `browser.keys()` is NOT that: under tauri-wd the key events drive
 * the app's shortcuts but never produce text in a contenteditable — the editor
 * stayed at its placeholder in every spec that typed this way (2026-08-21).
 * `execCommand('insertText')` goes through WebKit's editing pipeline
 * (beforeinput/input + DOM mutation), which ProseMirror reads back as a typed
 * transaction: undoable, grouped like typing. A plain-text paste is the
 * fallback for an engine that refuses the command.
 */
export async function typeInBody(text) {
  const result = await browser.execute((sel, value) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    el.focus();
    // Caret at the end of the last block so the text appends.
    const last = el.lastElementChild || el;
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    let ok = false;
    try { ok = document.execCommand('insertText', false, value); } catch { ok = false; }
    if (!ok) {
      const dt = new DataTransfer();
      dt.setData('text/plain', value);
      let ev = null;
      try { ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }); } catch { ev = null; }
      if (!ev || !ev.clipboardData) {
        ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
      }
      el.dispatchEvent(ev);
    }
    return { found: true, ok };
  }, EDITOR, text);
  if (!result.found) throw new Error(`typeInBody: no editor at ${EDITOR}`);
  await browser.pause(250);
  const now = await editorText();
  if (!(now || '').includes(text)) {
    throw new Error(
      `typeInBody: "${text}" never landed in the editor (execCommand ok=${result.ok}) — ` +
      `ProseMirror did not read the DOM change back. Editor holds ${JSON.stringify(now)}`,
    );
  }
}

/** Focus the editor and select everything in it (ProseMirror follows the DOM selection). */
export async function selectAllInBody() {
  await browser.execute((sel) => {
    const el = document.querySelector(sel);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, EDITOR);
  await browser.pause(150);
}

/** Press a toolbar button by its `title` prefix ('Bold', 'Undo', 'Insert Link', …). */
export async function clickToolbar(titlePrefix) {
  const hit = await browser.execute((sel, prefix) => {
    const btn = [...document.querySelectorAll(`${sel} button[title]`)]
      .find((b) => b.getAttribute('title').startsWith(prefix));
    if (!btn) return { found: false };
    const disabled = btn.disabled;
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    return { found: true, disabled, active: btn.className.includes('text-mail-accent') };
  }, MODAL, titlePrefix);
  await browser.pause(150);
  return hit;
}

export const toolbarState = (titlePrefix) => browser.execute((sel, prefix) => {
  const btn = [...document.querySelectorAll(`${sel} button[title]`)]
    .find((b) => b.getAttribute('title').startsWith(prefix));
  return btn ? { disabled: btn.disabled, active: btn.className.includes('text-mail-accent') } : null;
}, MODAL, titlePrefix);

// ---------------------------------------------------------------------------
// Fields, attachments, modal state
// ---------------------------------------------------------------------------

/** Set a React-controlled input/select by data-testid (value setter + input/change). */
export async function setField(testid, value) {
  const ok = await browser.execute((id, v) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return false;
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, testid, String(value));
  await browser.pause(150);
  return ok;
}

export const fieldValue = (testid) => browser.execute((id) =>
  document.querySelector(`[data-testid="${id}"]`)?.value ?? null, testid);

/** Press a key inside a field (keydown only — enough for the form's Enter/Shift+Enter handling). */
export async function keyInField(testid, key, init = {}) {
  await browser.execute((id, k, extra) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    el?.focus();
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  }, testid, key, init);
  await browser.pause(200);
}

export const attachments = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="compose-attachment"]')].map((el) => el.dataset.filename));

export async function removeAttachment(filename) {
  const ok = await browser.execute((name) => {
    const row = [...document.querySelectorAll('[data-testid="compose-attachment"]')]
      .find((el) => el.dataset.filename === name);
    const btn = row?.querySelector('button[title="Remove attachment"]');
    if (!btn) return false;
    btn.click();
    return true;
  }, filename);
  await browser.pause(150);
  return ok;
}

/** Attach through the paperclip's hidden input (what the "Attach files" button drives). */
export async function attachViaInput(files) {
  await installDndTools();
  const ok = await browser.execute((fs) => {
    const input = document.querySelector('[data-testid="compose-attach-input"]');
    if (!input) return false;
    input.files = window.__mvDnD.transfer(fs).files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, files);
  await browser.pause(400);
  return ok;
}

export const modalCount = () => browser.execute((sel) => document.querySelectorAll(sel).length, MODAL);
export const modalOpen = () => browser.execute((sel) => {
  const m = document.querySelector(sel);
  return !!m && m.offsetHeight > 0;
}, MODAL);
export const modalAttr = (name) => browser.execute((sel, n) =>
  document.querySelector(sel)?.getAttribute(n) ?? null, MODAL, name);
export const modalTitle = () => browser.execute((sel) =>
  document.querySelector(`${sel} h2`)?.textContent.trim() ?? null, MODAL);
export const testidPresent = (testid) => browser.execute((id) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  return !!el && el.offsetHeight > 0;
}, testid);
export const testidText = (testid) => browser.execute((id) =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent.trim() ?? null, testid);

/** Click a button inside the modal (or inside `scope`) by its exact trimmed text. */
export async function clickButtonText(text, scope = MODAL) {
  const ok = await browser.execute((sel, wanted) => {
    const root = sel ? document.querySelector(sel) : document;
    if (!root) return false;
    for (const btn of root.querySelectorAll('button')) {
      if (btn.offsetHeight > 0 && btn.textContent.trim() === wanted) { btn.click(); return true; }
    }
    return false;
  }, scope, text);
  await browser.pause(250);
  return ok;
}

/** Click a button inside the modal by its `title` attribute. */
export async function clickButtonTitle(title, scope = MODAL) {
  const ok = await browser.execute((sel, wanted) => {
    const root = sel ? document.querySelector(sel) : document;
    const btn = root?.querySelector(`button[title="${wanted}"]`);
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  }, scope, title);
  await browser.pause(250);
  return ok;
}

/** Click the translucent backdrop (outside the modal box). */
export async function clickBackdrop() {
  await browser.execute((sel) => {
    const modal = document.querySelector(sel);
    modal?.parentElement?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, MODAL);
  await browser.pause(300);
}

/**
 * Escape as the app sees it. WebDriver's Escape never reaches the webview, so
 * dispatch on the focused element (bubbles to document + window, where every
 * compose Escape handler lives).
 */
export async function pressEscape() {
  await browser.execute(() => {
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
    }));
  });
  await browser.pause(300);
}

// ---------------------------------------------------------------------------
// Bubbles / outbox
// ---------------------------------------------------------------------------

export const bubbles = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="compose-bubble"]')]
    .map((b) => (b.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)));

export async function clickBubble(index = 0) {
  const ok = await browser.execute((i) => {
    const b = document.querySelectorAll('[data-testid="compose-bubble"]')[i];
    if (!b) return false;
    b.click();
    return true;
  }, index);
  await browser.pause(400);
  return ok;
}

export async function closeBubble(index = 0) {
  const ok = await browser.execute((i) => {
    const b = document.querySelectorAll('[data-testid="compose-bubble"]')[i];
    const btn = b?.querySelector('button');
    if (!btn) return false;
    btn.click();
    return true;
  }, index);
  await browser.pause(300);
  return ok;
}

export const outboxStatuses = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid^="outbox-bubble-"]')]
    .map((el) => el.getAttribute('data-testid').replace('outbox-bubble-', '')));

/** Store-side outbox state — the DOM bubble may still be animating. */
export const outboxItems = () => browser.execute(() =>
  (window.__MAIL_STORE__.getState().outboxItems || []).map(({ id, status, error }) => ({ id, status, error })));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Tear everything compose-related down without going through any animation:
 * close each modal through its own Close button (confirming the discard dialog
 * when it appears), close every bubble, then clear pending/outbox sends in the
 * store — the outbox buttons RESTORE the draft, which is not a cleanup.
 */
export async function closeComposeHard() {
  for (let i = 0; i < 4; i++) {
    const closed = await browser.execute((sel) => {
      const modal = document.querySelector(sel);
      if (!modal || modal.offsetHeight === 0) return false;
      modal.querySelector('button[title="Close"]')?.click();
      return true;
    }, MODAL);
    if (!closed) break;
    await browser.pause(200);
    await browser.execute(() => {
      const dialog = document.querySelector('[data-testid="compose-discard-dialog"]');
      for (const btn of dialog?.querySelectorAll('button') || []) {
        if (btn.textContent.trim() === 'Discard') btn.click();
      }
    });
    await browser.pause(200);
  }
  await browser.execute(() => {
    for (const b of document.querySelectorAll('[data-testid="compose-bubble"]')) b.querySelector('button')?.click();
    const s = window.__MAIL_STORE__?.getState?.();
    if (!s) return;
    s.cancelPendingSend?.();
    for (const item of s.outboxItems || []) s.dismissOutbox?.(item.id);
  });
  await browser.pause(300);
}

/** Start from a clean slate and open a new compose window. */
export async function openComposeFresh() {
  await closeComposeHard();
  await pressKey('c');
  await browser.waitUntil(modalOpen, {
    timeout: 10_000, interval: 200, timeoutMsg: 'compose modal did not open on "c"',
  });
  await browser.pause(300);
}

// ---------------------------------------------------------------------------
// Tauri / store access
// ---------------------------------------------------------------------------

/**
 * `browser.execute()` serialises the return value before a Promise settles, so
 * a Tauri invoke has to go through the execute/async endpoint.
 */
export function invoke(cmd, args) {
  return browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a)
      .then((r) => done({ ok: true, value: r }))
      .catch((e) => done({ ok: false, error: String((e && e.message) || e) }));
  }, cmd, args);
}

export const settingsCall = (method, ...args) => browser.execute((m, a) => {
  const r = window.__SETTINGS_STORE__.getState()[m](...a);
  return r === undefined ? null : JSON.parse(JSON.stringify(r));
}, method, args);

export const mailStoreSet = (patch) => browser.execute((p) => {
  window.__MAIL_STORE__.setState(p);
  return true;
}, patch);

export const firstAccount = () => browser.execute(() => {
  const a = window.__MAIL_STORE__.getState().accounts[0];
  return a ? JSON.parse(JSON.stringify(a)) : null;
});
