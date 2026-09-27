// Download modes (H5): Hoarder's background download runs only once the
// settings file says `fetchModePremium: true`. On the first launch after the
// update (no saved flag yet) a Premium profile flips it while the store
// hydrates, before the store's change listener may wake anything; the daemon
// is told once hydration ends. An ordinary launch wakes nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ saved: null, calls: [] }));
vi.mock('../safeStorage', () => ({
  // Async like the real one (Tauri file read), so hydration ends after the
  // module has registered its listeners.
  safeStorage: {
    getItem: async () => h.saved,
    setItem: () => {},
    removeItem: () => {},
  },
  flushSafeStorage: async () => { h.calls.push('flush'); },
  safeStorageWritable: () => true,
}));
vi.mock('../../services/daemonClient', () => ({
  daemonCall: async (method) => { h.calls.push(method); return { ok: true }; },
}));

const PREMIUM = { hasSubscription: true, status: 'active', premiumAccess: true };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function launch(state, version = 12) {
  vi.resetModules();
  h.calls.length = 0;
  h.saved = JSON.stringify({ state, version });
  const { useSettingsStore } = await import('../settingsStore');
  await vi.waitFor(() => expect(useSettingsStore.persist.hasHydrated()).toBe(true));
  await settle();
  return useSettingsStore;
}

afterEach(() => { h.saved = null; });

describe('fetchModePremium on launch', () => {
  it('first launch after the update: Premium flips the flag and wakes the daemon once, after a flush', async () => {
    const store = await launch({ billingProfile: PREMIUM, localCacheDurationMonths: 0 }, 11);
    expect(store.getState().fetchModePremium).toBe(true);
    expect(store.getState().fetchMode).toBe('hoarder');
    expect(h.calls).toEqual(['flush', 'storage.fetch_mode_changed']);
  });

  it('an ordinary launch, flag already saved, wakes nothing', async () => {
    const store = await launch({ billingProfile: PREMIUM, fetchMode: 'hoarder', fetchModePremium: true });
    expect(store.getState().fetchModePremium).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it('a lapse found at launch clears the flag without a wake', async () => {
    const store = await launch({ billingProfile: { hasSubscription: false }, fetchMode: 'hoarder', fetchModePremium: true });
    expect(store.getState().fetchModePremium).toBe(false);
    expect(store.getState().fetchMode).toBe('hoarder');
    expect(h.calls).toEqual([]);
  });
});
