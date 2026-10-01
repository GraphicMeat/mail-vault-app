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
