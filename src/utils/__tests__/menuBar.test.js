// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(() => Promise.resolve());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

let watchMenuBar, watchQuitShortcut;
beforeEach(async () => {
  vi.resetModules();
  Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15', configurable: true });
  window.__TAURI__ = {};
  ({ watchMenuBar, watchQuitShortcut } = await import('../menuBar'));
});
afterEach(() => { delete window.__TAURI__; invoke.mockClear(); });

const fakeStore = (state) => {
  const subs = [];
  return {
    getState: () => state,
    setState: (patch) => { state = { ...state, ...patch }; subs.forEach(fn => fn(state)); },
    subscribe: (fn) => { subs.push(fn); return () => {}; },
  };
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('menu bar', () => {
  it('sends nothing at launch for a shown bar, then follows the setting', async () => {
    const store = fakeStore({ showMenuBar: true });
    watchMenuBar(store);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    store.setState({ showMenuBar: false });
    await flush();
    expect(invoke).toHaveBeenLastCalledWith('set_menu_bar_visible', { visible: false });
    store.setState({ showMenuBar: true });
    await flush();
    expect(invoke).toHaveBeenLastCalledWith('set_menu_bar_visible', { visible: true });
  });

  it('hides it at once in a window opened while it is off', async () => {
    watchMenuBar(fakeStore({ showMenuBar: false }));
    await flush();
    expect(invoke).toHaveBeenCalledWith('set_menu_bar_visible', { visible: false });
  });

  it('quits on Ctrl+Q, and only on Ctrl+Q', async () => {
    const stop = watchQuitShortcut();
    const press = (init) => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', ...init }));
    press({ ctrlKey: true, shiftKey: true });
    press({});
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    press({ ctrlKey: true });
    await flush();
    expect(invoke).toHaveBeenCalledWith('quit_app');
    stop();
  });
});
