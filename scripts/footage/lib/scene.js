/**
 * What every footage spec does around its takes: raise and measure the
 * window, hide the version label, get the work INBOX on screen, wait for the
 * app to go quiet, and put the view back to a known state between clips.
 *
 * Nothing here is recorded. A take (lib/footage.js `Take`) starts only once the
 * window is in the state its first frame should show.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForApp, waitForEmails, openSettings, closeSettings } from '../../../tests/e2e/helpers.js';
import { raiseWindow } from '../../screenshots/window.js';
import { makeLabels } from '../../screenshots/labels.js';
import { windowSize, restoreMotion, windowInfo, pointer, OUT_DIR } from './footage.js';
import { APP_LOCALE } from './locale.js';

// The app's own strings in the run's UI language (FOOTAGE_LOCALE, lib/locale.js),
// resolved before SEL below is built from them.
export const L = makeLabels(APP_LOCALE);

export const SEL = {
  row: '[data-testid="email-row"]',
  searchToggle: '[data-testid="mail-search-toggle"]',
  searchInput: '[data-testid="mail-search-input"]',
  explorer: '[data-testid="mail-view-explorer"]',
  list: '[data-testid="mail-view-list"]',
  insights: '[data-testid="open-insights"]',
  compose: '[data-testid="compose-modal"]',
  editor: '[data-testid="compose-modal"] .ProseMirror',
  send: '[data-testid="compose-send"]',
  undoSend: '[data-testid="undo-send-btn"]',
  sourceAll: `button[title="${L('workspace.sourceHint.all')}"]`,
  sourceServer: `button[title="${L('workspace.sourceHint.server')}"]`,
  sourceVault: `button[title="${L('workspace.sourceHint.local')}"]`,
};

/** Seconds since `t0`, for log lines. */
export const since = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

/** Wait on a page predicate; false (not a throw) when it never holds. */
export async function waitPage(pred, { timeout = 20000, interval = 250 } = {}, ...args) {
  try {
    await browser.waitUntil(() => browser.execute(pred, ...args), { timeout, interval });
    return true;
  } catch {
    return false;
  }
}

/** Everything a spec asserts on, in one round trip. */
export function probe() {
  return browser.execute(() => {
    const vis = (sel) => { const el = document.querySelector(sel); return !!el && el.offsetHeight > 0; };
    const st = window.__MAIL_STORE__?.getState?.();
    return {
      title: (document.querySelector('[data-testid="mailbox-title"]')?.textContent || '').trim(),
      rows: document.querySelectorAll('[data-testid="email-row"]').length,
      total: st?.totalEmails ?? null,
      loaded: st?.sortedEmails?.length ?? null,
      archived: st?.archivedEmailIds?.size ?? null,
      account: st?.activeAccountId ?? null,
      mailbox: st?.activeMailbox ?? null,
      viewMode: st?.viewMode ?? null,
      selected: st?.selectedEmailId ?? null,
      settings: vis('[data-testid="settings-page"]'),
      compose: vis('[data-testid="compose-modal"]'),
      explorer: document.querySelector('[data-testid="explorer-view"]')?.dataset.grouping || '',
      insights: document.querySelector('[data-testid="insights-page"]')?.dataset.status || '',
      chat: vis('[data-testid="chat-view"]'),
      dialog: vis('.mail-dialog'),
      theme: document.documentElement.getAttribute('data-theme'),
      palette: document.documentElement.getAttribute('data-palette'),
    };
  });
}

/**
 * The native title bar (the 32 pt strip with the traffic lights) is window
 * chrome, drawn in the app's appearance, which follows the system (the mini
 * runs Dark): over a light web UI it stays a dark bar. A light take sets the
 * app's own appearance with Tauri's window setTheme (NSApp.appearance = Aqua,
 * this process only; no system setting changes). Needs
 * core:window:allow-set-theme, which scripts/footage/run.sh grants in the job
 * clone only. Dark takes leave the window alone, as the dark cut was shot.
 */
export async function setWindowTheme(theme) {
  if (theme !== 'light') return { requested: theme, skipped: true };
  const r = await browser.executeAsync((t, done) => {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (!win?.setTheme) { done({ requested: t, error: 'no tauri window setTheme' }); return; }
    let before = null;
    Promise.resolve(win.theme())
      .then((b) => { before = b; return win.setTheme(t); })
      .then(() => win.theme())
      .then((after) => done({ requested: t, before, after }))
      .catch((e) => done({ requested: t, before, error: String(e) }));
  }, theme);
  if (r.error || r.after !== theme) console.error(`[footage] window theme NOT set: ${JSON.stringify(r)}`);
  return r;
}

/**
 * The window's own overlays: every visible `position: fixed` element (toasts,
 * chips, bubbles, dialogs, tooltips). Logged before each take; `quiet()` waits
 * until none of the transient kinds is left.
 */
export function census() {
  return browser.execute(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || cs.display === 'none') continue;
      out.push({
        testid: el.dataset.testid || '',
        role: el.getAttribute('role') || '',
        cls: String(el.className || '').slice(0, 80),
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100),
        box: [r.x, r.y, r.width, r.height].map(Math.round),
      });
    }
    return out;
  });
}

// Fixed elements that are part of a calm frame, not an interruption.
const CALM = (o) => o.testid === 'compose-modal' || o.testid === 'settings-page'
  || (!o.text && o.box[2] >= 1000 && o.box[3] >= 600);

/** Wait until no toast, chip, bubble or dialog is on screen. Returns what is left. */
export async function quiet({ timeout = 60000, allow = () => false } = {}) {
  const t0 = Date.now();
  let left = [];
  while (Date.now() - t0 < timeout) {
    left = (await census()).filter((o) => !CALM(o) && !allow(o));
    if (!left.length) return [];
    await browser.pause(500);
  }
  console.warn(`[footage] not quiet after ${timeout} ms: ${JSON.stringify(left)}`);
  return left;
}

/** A persisted setting through the store's own setter (the VITE_E2E build publishes it). */
export async function setSetting(key, value) {
  const ok = await browser.execute((k, v) => {
    const store = window.__SETTINGS_STORE__;
    if (!store) return false;
    const state = store.getState();
    const setter = `set${k.charAt(0).toUpperCase()}${k.slice(1)}`;
    if (typeof state[setter] === 'function') state[setter](v);
    else store.setState({ [k]: v });
    return true;
  }, key, value);
  if (!ok) throw new Error(`__SETTINGS_STORE__ missing (${key})`);
}

/** Click through the page (untimed setup only; a take clicks through `Take`). */
export function clickSel(selector, text = '') {
  return browser.execute((s, t) => {
    for (const el of document.querySelectorAll(s)) {
      if (el.offsetHeight === 0 || el.disabled) continue;
      if (t && !(el.textContent || '').trim().startsWith(t)) continue;
      el.click();
      return true;
    }
    return false;
  }, selector, text);
}

/** The work account's INBOX (the account and folder are named, never assumed). */
export async function openWorkInbox() {
  await closeSettings();
  const email = browser.demoAccounts[0].email;
  await browser.execute((mail) => {
    document.querySelector(`.sidebar-account-open[aria-label*="${mail}"]`)?.click();
  }, email);
  await browser.pause(900);
  await browser.execute(() => {
    document.querySelector('[data-testid="folder-row"][data-path="INBOX"]')?.click();
  });
  await browser.pause(900);
}

/**
 * The version label in the sidebar footer ("MailVault v2.16.0") must not be in
 * the video. It is hidden by a stylesheet the harness injects into the page
 * (no app code changes); its box is measured first, for the record and for a
 * compositor that prefers masking. Returns the box in viewport CSS px.
 */
export async function hideVersionLabel() {
  return browser.execute(() => {
    const el = document.querySelector('.sidebar-version');
    const r = el?.getBoundingClientRect();
    const box = r && r.width > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height, text: el.textContent } : null;
    if (!document.getElementById('footage-hide-version')) {
      const style = document.createElement('style');
      style.id = 'footage-hide-version';
      // The second rule: a take's clicks are dispatched in the page, so WebKit
      // never sees a real pointer and treats focus as keyboard focus, painting
      // a :focus-visible ring on buttons a mouse user never sees (a dialog's
      // autofocused close button, the last button clicked). Buttons only: a
      // text field's focus ring is what a mouse user does see.
      style.textContent = '.sidebar-version { visibility: hidden !important; }\n'
        + 'button:focus-visible, [role="button"]:focus-visible, a:focus-visible, [role="tab"]:focus-visible, '
        + '[role="switch"]:focus-visible { outline: none !important; box-shadow: none !important; }';
      document.head.appendChild(style);
    }
    return box;
  });
}

/**
 * Raise, size and measure the window; restore framer-motion; park the real
 * pointer on the title bar; hide the version label. Writes geometry.json.
 */
export async function prepareWindow() {
  mkdirSync(OUT_DIR, { recursive: true });
  const { width, height } = windowSize();
  console.log('[footage] raise:', await raiseWindow(width, height));
  const windowTheme = await setWindowTheme(process.env.FOOTAGE_THEME === 'light' ? 'light' : 'dark');
  console.log('[footage] window theme:', JSON.stringify(windowTheme));
  await browser.pause(1500);
  const geometry = await browser.executeAsync((done) => {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (!win) { done({ error: 'no tauri window api' }); return; }
    Promise.all([win.outerSize(), win.innerSize(), win.scaleFactor(), win.outerPosition()])
      .then(([outer, inner, scale, pos]) => done({
        outer: [outer.width, outer.height], inner: [inner.width, inner.height], scale, pos: [pos.x, pos.y],
        viewport: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio,
        visibility: document.visibilityState,
      }))
      .catch((e) => done({ error: String(e) }));
  });
  const versionLabel = await hideVersionLabel();
  // Window points = viewport + the title bar above the webview.
  const titleBar = geometry.outer && geometry.inner ? (geometry.outer[1] - geometry.inner[1]) / (geometry.scale || 2) : 32;
  const versionLabelWindow = versionLabel && {
    x: versionLabel.x, y: versionLabel.y + titleBar, w: versionLabel.w, h: versionLabel.h,
    px: { x: versionLabel.x * 2, y: (versionLabel.y + titleBar) * 2, w: versionLabel.w * 2, h: versionLabel.h * 2 },
  };
  console.log('[footage] geometry:', JSON.stringify(geometry), 'version label:', JSON.stringify(versionLabelWindow));
  writeFileSync(join(OUT_DIR, 'geometry.json'), JSON.stringify({
    requested: { width, height }, geometry, windowTheme, windows: windowInfo(),
    versionLabel: {
      hidden: true,
      how: 'harness-injected stylesheet: .sidebar-version { visibility: hidden }',
      text: versionLabel?.text ?? null,
      viewportCss: versionLabel,
      window: versionLabelWindow,
    },
  }, null, 2));
  if (process.env.FOOTAGE_REAL_MOTION !== '0') await restoreMotion();
  if (geometry.pos && geometry.outer) {
    const s = geometry.scale || 2;
    console.log('[footage] pointer parked:', pointer(geometry.pos[0] / s + geometry.outer[0] / s / 2, geometry.pos[1] / s + 16));
  }
  return { geometry, versionLabel };
}

/** How many uids the header cache holds for the active mailbox (what the bulk dialog and Explorer read). */
export async function cachedCount() {
  const r = await browser.executeAsync((done) => {
    const st = window.__MAIL_STORE__?.getState?.();
    const inv = window.__TAURI_INTERNALS__?.invoke;
    if (!st || !inv) { done({ error: 'no store or invoke' }); return; }
    inv('daemon_rpc', { method: 'list_cached_uids', params: { accountId: st.activeAccountId, mailbox: st.activeMailbox } })
      .then((v) => done({ n: v?.uids?.length ?? (Array.isArray(v) ? v.length : null) }))
      .catch((e) => done({ error: String(e?.message || e) }));
  });
  return r.error ? null : r.n;
}

/** Boot to a synced work INBOX. Returns probe numbers for the log. */
export async function bootToInbox({ expectTotal = 0, timeout = 240000 } = {}) {
  const t0 = Date.now();
  await waitForApp(60000);
  await prepareWindow();
  await waitForEmails(120000);
  await openWorkInbox();
  // The whole mailbox in the header cache: the bulk dialog's years and
  // Explorer's groups are read from it.
  let last = null;
  let stableSince = Date.now();
  while (Date.now() - t0 < timeout) {
    const p = await probe();
    p.cached = expectTotal ? await cachedCount() : null;
    if (!last || p.loaded !== last.loaded || p.total !== last.total || p.cached !== last.cached) stableSince = Date.now();
    last = p;
    // `loaded` is the paginated render window, not the mailbox: only its
    // settling counts; the total and the header cache are what must be complete.
    const enough = !expectTotal || ((p.total ?? 0) >= expectTotal && (p.cached ?? 0) >= expectTotal);
    if (enough && Date.now() - stableSince > 3000) break;
    await browser.pause(1000);
  }
  last.seconds = Number(since(t0));
  console.log(`[footage] inbox synced in ${since(t0)} s: ${JSON.stringify(last)}`);
  return last;
}

/**
 * Back to the plain work INBOX between clips: no compose, no settings, no
 * insights, list view, All mail, no search, nothing open, list at the top.
 */
export async function resetView() {
  // A bulk session left open by a failed setup step.
  await browser.execute(() => window.__MAIL_STORE__?.getState?.().endBulkSession?.());
  await dismissBulkBubble();
  // Compose: its own close, then the "Discard message?" confirmation, which
  // mounts a beat later. Twice, for a reopened draft (undo send).
  // The confirmation is a `.mail-dialog`; the compose footer has a "Discard"
  // of its own, which only asks again, so the button is looked up inside the
  // dialog and never in the compose window.
  const confirmDiscard = () => browser.execute((d) => {
    const btn = [...document.querySelectorAll('.mail-dialog button')]
      .find((b) => b.offsetHeight > 0 && (b.textContent || '').trim() === d);
    if (!btn) return false;
    btn.click();
    return true;
  }, L('common.discard'));
  for (let i = 0; i < 3; i++) {
    if (await confirmDiscard()) { await browser.pause(700); continue; }
    const open = await browser.execute(() => !!document.querySelector('[data-testid="compose-modal"]')?.offsetHeight);
    if (!open) break;
    await browser.execute((close) => {
      document.querySelector(`[data-testid="compose-modal"] button[title="${close}"]`)?.click();
    }, L('common.close'));
    await waitPage((d) => [...document.querySelectorAll('.mail-dialog button')]
      .some((b) => b.offsetHeight > 0 && (b.textContent || '').trim() === d), { timeout: 3000 }, L('common.discard'));
    await confirmDiscard();
    await browser.pause(700);
  }
  await closeSettings();
  await browser.execute(() => document.querySelector('[data-testid="insights-close"]')?.click());
  await browser.pause(300);
  if ((await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().viewStyle)) !== 'list') {
    await setSetting('viewStyle', 'list');
    await browser.pause(600);
  }
  await clickSel(SEL.list);
  await browser.execute(() => {
    window.__SEARCH_STORE__?.getState?.().clearSearch?.();
    const search = document.querySelector('[data-testid="mail-search-input"]');
    if (search && search.offsetHeight > 0) document.querySelector('[data-testid="mail-search-toggle"]')?.click();
  });
  await browser.pause(300);
  await openWorkInbox();
  await clickSel(SEL.sourceAll);
  await browser.execute(() => {
    window.__MAIL_STORE__?.getState?.().closeEmail?.();
    document.activeElement?.blur?.();
    const row = document.querySelector('[data-testid="email-row"]');
    let el = row?.parentElement;
    while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
    if (el) el.scrollTop = 0;
  });
  await browser.pause(800);
  const p = await probe();
  if (p.dialog || p.compose || p.settings) console.warn(`[footage] resetView left something open: ${JSON.stringify(p)}`);
}

/**
 * A finished bulk run's bubble ("Operation Complete") dismisses itself after
 * 4 s only when nothing failed; one that reports a failure stays until its X
 * is clicked. Clicks that X (setup only, never inside a take).
 */
export async function dismissBulkBubble() {
  const done = [L('bulk.progress.operationComplete'), L('bulk.progress.operationCancelled'), L('bulk.progress.operationFailed')];
  const hit = await browser.execute((words) => {
    for (const el of document.querySelectorAll('.fixed.bottom-4.right-4')) {
      if (el.offsetHeight === 0 || !words.some((w) => (el.innerText || '').includes(w))) continue;
      const btn = el.querySelector('button');
      if (btn) { btn.click(); return (el.innerText || '').replace(/\s+/g, ' ').slice(0, 120); }
    }
    return '';
  }, done);
  if (hit) {
    console.log(`[footage] dismissed bulk bubble: ${hit}`);
    await browser.pause(700);
  }
  return hit;
}

/** Log the frame's overlays to <clip>.census.json and fail loudly on leftovers. */
export async function beforeTake(clip, { allow } = {}) {
  const left = await quiet({ timeout: 45000, allow });
  const all = await census();
  writeFileSync(join(OUT_DIR, `${clip}.census.json`), JSON.stringify({ left, all, probe: await probe() }, null, 2));
  if (left.length) console.warn(`[footage] ${clip}: starting with overlays on screen: ${JSON.stringify(left)}`);
  return left;
}

export { openSettings, closeSettings };
