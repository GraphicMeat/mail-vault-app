import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';

const defaults = {
  invoke, listen, emitTo, uuid: () => crypto.randomUUID(),
  setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t),
};
// A window that never says ready (crashed, closed at once) must not leave the
// listener, and the html it holds, registered for the life of the app.
export const READY_TIMEOUT_MS = 10_000;

// Blitz mode's "Open in window": the app's own Original Message window (the
// shell already opens it; `original-*` is in the default capability) drawing
// the body through Blitz. No raw mail document ever loads in a webview.
export async function openBlitzWindow({ html, dark, title }, deps = defaults) {
  const token = deps.uuid();
  let stop = null;
  let timer = null;
  const done = () => { if (timer != null) deps.clearTimer(timer); timer = null; stop?.(); stop = null; };
  stop = await deps.listen('original-message-ready', async (event) => {
    if (event.payload?.token !== token) return;
    try { await deps.emitTo(event.payload.label, 'original-message-payload', { token, html, dark, title, surface: 'popout' }); } finally { done(); }
  });
  timer = deps.setTimer(done, READY_TIMEOUT_MS);
  try {
    return await deps.invoke('open_auxiliary_window', { kind: 'original', token });
  } catch (err) {
    done();
    throw err;
  }
}

// A destroyed webview runs no React cleanup, and a doc's close is an IPC write
// that must leave before the webview goes. So the close request is held
// (preventDefault), the registry closes every doc (live ones, and ones still
// opening for up to `waitMs`), and only then is the window destroyed. The wait
// is bounded by closeAll's own `waitMs`; a failing cleanup still closes the
// window. A doc that lands later stays in the worker until it restarts (the
// accepted residue of Review Focus 5).
export function installWindowDocCleanup(registry, { win, waitMs = 1000 }) {
  let closing = false;
  return win.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try { await registry.closeAll({ waitMs }); } catch { /* close the window regardless */ }
    try { await win.destroy(); } catch { closing = false; } // a later close request must still get through
  });
}
