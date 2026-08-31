/**
 * Size the window and pin it above whatever else is on that desktop. An
 * occluded WKWebView stops painting and the capture then silently repeats the
 * last good frame — this is the only defence against a whole run of wrong shots.
 * Needs the permissions scripts/screenshots/prepare-build.sh grants.
 */
export async function raiseWindow(width = 1440, height = 900) {
  return browser.executeAsync((w, h, done) => {
    const api = window.__TAURI__;
    const win = api?.window?.getCurrentWindow?.();
    const Size = api?.dpi?.LogicalSize || api?.window?.LogicalSize;
    if (!win || !Size) { done('no tauri window api'); return; }
    Promise.resolve()
      .then(() => win.setSize(new Size(w, h)))
      .then(() => win.center())
      .then(() => win.setAlwaysOnTop(true))
      .then(() => win.setFocus())
      .then(() => done('ok'))
      .catch((e) => done(`failed: ${e}`));
  }, width, height);
}
