// @vitest-environment jsdom
// themeStore's onRehydrateStorage touches document.documentElement during
// rehydration, and this directory isn't covered by vitest.config's
// src/components/** jsdom glob.
import { describe, it, expect, vi } from 'vitest';

// Mock safeStorage (localStorage substitute) — same pattern as settingsStore.test.js.
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

const { useThemeStore } = await import('../themeStore');
const { useSettingsStore } = await import('../settingsStore');
const { DEFAULT_QUICK_ACTIONS, normalizeQuickActions } = await import('../../utils/quickActions');

describe('onboarding defaults a brand-new user sees', () => {
  it('themeStore defaults to the graphite palette', () => {
    expect(useThemeStore.getState().palette).toBe('graphite');
  });

  it('settingsStore defaults to expandable thread mode', () => {
    expect(useSettingsStore.getState().threadMode).toBe('expandable');
  });

  it('resetSettings restores expandable thread mode', () => {
    useSettingsStore.getState().setThreadMode('grouped');
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().threadMode).toBe('expandable');
  });

  it('DEFAULT_QUICK_ACTIONS gives message rows a colored radial menu', () => {
    expect(DEFAULT_QUICK_ACTIONS.defaults.row).toMatchObject({ mode: 'radial', palette: 'semantic' });
  });

  it('DEFAULT_QUICK_ACTIONS keeps the selection bar and reader inline and colored', () => {
    expect(DEFAULT_QUICK_ACTIONS.defaults.selection).toMatchObject({ mode: 'inline', palette: 'semantic' });
    expect(DEFAULT_QUICK_ACTIONS.defaults.reader).toMatchObject({ mode: 'inline', palette: 'semantic' });
  });

  it('normalization keeps the row radial default intact', () => {
    const normalized = normalizeQuickActions(DEFAULT_QUICK_ACTIONS);
    expect(normalized.defaults.row.mode).toBe('radial');
  });
});
