import { describe, it, expect, vi } from 'vitest';

// Mock safeStorage (localStorage substitute)
vi.mock('../safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

const { useSettingsStore } = await import('../settingsStore');

describe('settingsStore defaults', () => {
  it('has cacheLimitMB default of 128', () => {
    const state = useSettingsStore.getState();
    expect(state.cacheLimitMB).toBe(128);
  });

  it('setCacheLimitMB updates the value', () => {
    const store = useSettingsStore.getState();
    store.setCacheLimitMB(256);
    expect(useSettingsStore.getState().cacheLimitMB).toBe(256);

    // Reset for other tests
    store.setCacheLimitMB(128);
  });

  it('resetSettings restores cacheLimitMB to 128', () => {
    const store = useSettingsStore.getState();
    store.setCacheLimitMB(999);
    store.resetSettings();
    expect(useSettingsStore.getState().cacheLimitMB).toBe(128);
  });
});
