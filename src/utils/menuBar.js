// ── menuBar — Linux's File/Logs menu bar (Settings > Appearance > Layout) ──
//
// macOS has the global menu and Windows no menu bar, so the setting is shown
// and applied on Linux only. The shell reads the saved choice at launch and
// never attaches a hidden bar; this keeps every window in step afterwards.

export const IS_LINUX = typeof navigator !== 'undefined'
  && /Linux/.test(navigator.userAgent || '') && !/Android/.test(navigator.userAgent || '');

export async function applyMenuBarVisible(visible) {
  if (!window.__TAURI__ || !IS_LINUX) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_menu_bar_visible', { visible: visible !== false });
  } catch (error) {
    console.warn('[menuBar] toggle failed:', error);
  }
}

// Every window runs this once (main.jsx). Nothing is sent before hydration:
// the default is a shown bar, which is what the shell started with unless the
// saved choice says otherwise, and then the shell already left it out.
export function watchMenuBar(store) {
  let shown = null;
  const hydrated = () => store.persist?.hasHydrated?.() ?? true;
  const apply = ({ showMenuBar }) => {
    const next = showMenuBar !== false;
    if (next === shown) return;
    // The first value after launch only needs sending when it hides the bar
    // in a window the shell attached it to (a compose or settings window).
    if (shown === null && next) { shown = next; return; }
    shown = next;
    void applyMenuBarVisible(next);
  };
  if (hydrated()) apply(store.getState());
  store.persist?.onFinishHydration?.(state => apply(state));
  return store.subscribe(state => { if (hydrated()) apply(state); });
}

// Ctrl+Q, in every window. File > Quit carries it as a GTK accelerator, but a
// bar the shell never attached (off at launch) has none, so the key reaches
// the page. With the bar attached GTK takes the key first and this never runs.
export function watchQuitShortcut(target = window) {
  if (!window.__TAURI__ || !IS_LINUX) return () => {};
  const onKey = (e) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 'q') return;
    e.preventDefault();
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('quit_app'))
      .catch(error => console.warn('[menuBar] quit failed:', error));
  };
  target.addEventListener('keydown', onKey, true);
  return () => target.removeEventListener('keydown', onKey, true);
}
