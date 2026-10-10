// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyAppIcon, watchAppIcon, normalizeAppIcon, APP_ICONS } from '../appIcon';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); document.head.innerHTML = ''; delete window.__TAURI__; });
describe('app icon selection', () => {
  it('falls back to purple for unknown saved choices', () => {
    expect(normalizeAppIcon('old')).toBe('purple');
    expect(normalizeAppIcon('teal')).toBe('teal');
  });
  it('updates the browser icon and native icon without accepting paths', async () => {
    window.__TAURI__ = {};
    await applyAppIcon('teal');
    expect(invoke).toHaveBeenCalledWith('set_app_icon', { icon: 'teal' });
    expect(document.querySelector('link[rel="icon"]').getAttribute('href')).toBe(APP_ICONS.teal);
  });
  it('waits for hydration before restoring a saved teal selection', async () => {
    let hydrated = false, finish, changed;
    const store = { getState: () => ({ appIcon: 'purple' }),
      subscribe: fn => { changed = fn; return vi.fn(); },
      persist: { hasHydrated: () => hydrated, onFinishHydration: fn => { finish = fn; return vi.fn(); } } };
    watchAppIcon(store);
    expect(document.querySelector('link')).toBeNull();
    hydrated = true; finish({ appIcon: 'teal' });
    expect(document.querySelector('link').getAttribute('href')).toBe(APP_ICONS.teal);
    changed({ appIcon: 'purple' });
    expect(document.querySelector('link').getAttribute('href')).toBe(APP_ICONS.purple);
  });
  it('propagates a native failure instead of reporting success', async () => {
    window.__TAURI__ = {}; invoke.mockRejectedValue(new Error('failed'));
    await expect(applyAppIcon('teal')).rejects.toThrow('failed');
    expect(document.querySelector('link')).toBeNull();
  });
});
