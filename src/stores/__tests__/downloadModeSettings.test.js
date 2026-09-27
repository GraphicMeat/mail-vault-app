// Download modes (Track H, H5): the settings the daemon reads from
// frontend-settings.json (`fetchMode`, `fetchModes`, `localCacheDurationMonths`,
// `fetchModePremium`), the one-time migration off the old "All emails" window,
// and the flush-then-wake the daemon needs to see a change at once.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = [];
vi.mock('../safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
    flushSafeStorage: vi.fn(async () => { calls.push('flush'); }),
  };
});
const daemonCall = vi.fn(async (method) => { calls.push(method); return { ok: true }; });
vi.mock('../../services/daemonClient', () => ({ daemonCall: (...a) => daemonCall(...a) }));

const { useSettingsStore, migrateSettings } = await import('../settingsStore');

const PREMIUM = { hasSubscription: true, status: 'active', premiumAccess: true };
const FREE = { hasSubscription: false };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(async () => {
  useSettingsStore.setState({
    billingProfile: FREE, shareGrant: null,
    fetchMode: 'keepRecent', fetchModes: {}, localCacheDurationMonths: 3,
  });
  await settle();
  calls.length = 0;
  daemonCall.mockClear();
});

describe('download mode migration (v12)', () => {
  it('turns the old "All emails" window into Hoarder with a 12 month window', () => {
    const next = migrateSettings({ localCacheDurationMonths: 0 }, 11);
    expect(next.fetchMode).toBe('hoarder');
    expect(next.localCacheDurationMonths).toBe(12);
  });

  it('keeps any other window as Keep Recent with that window', () => {
    const next = migrateSettings({ localCacheDurationMonths: 6 }, 11);
    expect(next.fetchMode).toBe('keepRecent');
    expect(next.localCacheDurationMonths).toBe(6);
    expect(migrateSettings({}, 11).fetchMode).toBe('keepRecent');
  });

  it('runs once: a saved mode is never rewritten, even Keep Recent with window 0', () => {
    const once = migrateSettings({ localCacheDurationMonths: 0 }, 11);
    expect(migrateSettings(once, 11)).toEqual(once);
    expect(migrateSettings({ fetchMode: 'keepRecent', localCacheDurationMonths: 0 }, 12))
      .toEqual({ fetchMode: 'keepRecent', localCacheDurationMonths: 0 });
    expect(migrateSettings({ fetchMode: 'onDemand', localCacheDurationMonths: 0 }, 11).fetchMode).toBe('onDemand');
  });

  it('a new install starts on Keep Recent, 3 months, no overrides', () => {
    useSettingsStore.getState().resetSettings();
    const s = useSettingsStore.getState();
    expect(s.fetchMode).toBe('keepRecent');
    expect(s.fetchModes).toEqual({});
    expect(s.localCacheDurationMonths).toBe(3);
  });
});

describe('fetchModePremium follows hasPremiumAccess', () => {
  it('turns on with a Premium billing profile and off when it lapses or clears', async () => {
    useSettingsStore.getState().setBillingProfile(PREMIUM);
    expect(useSettingsStore.getState().fetchModePremium).toBe(true);

    useSettingsStore.getState().setBillingProfile({ ...PREMIUM, premiumAccess: false });
    expect(useSettingsStore.getState().fetchModePremium).toBe(false);

    useSettingsStore.getState().setBillingProfile(PREMIUM);
    useSettingsStore.getState().clearBillingProfile();
    expect(useSettingsStore.getState().fetchModePremium).toBe(false);
  });

  it('wakes the daemon after the flip is flushed to disk', async () => {
    useSettingsStore.getState().setBillingProfile(PREMIUM);
    await settle();
    expect(calls).toEqual(['flush', 'storage.fetch_mode_changed']);
  });

  it('a lapse never changes the saved mode', () => {
    useSettingsStore.setState({ billingProfile: PREMIUM, fetchMode: 'hoarder' });
    useSettingsStore.getState().setBillingProfile(FREE);
    expect(useSettingsStore.getState().fetchMode).toBe('hoarder');
  });
});

describe('changing the mode or window', () => {
  it('flushes settings, then calls storage.fetch_mode_changed', async () => {
    useSettingsStore.getState().setFetchMode('onDemand');
    await settle();
    expect(useSettingsStore.getState().fetchMode).toBe('onDemand');
    expect(calls).toEqual(['flush', 'storage.fetch_mode_changed']);

    calls.length = 0;
    useSettingsStore.getState().setLocalCacheDurationMonths(12);
    await settle();
    expect(useSettingsStore.getState().localCacheDurationMonths).toBe(12);
    expect(calls).toEqual(['flush', 'storage.fetch_mode_changed']);

    calls.length = 0;
    useSettingsStore.getState().setAccountFetchMode('acct1', 'indexOnly');
    await settle();
    expect(calls).toEqual(['flush', 'storage.fetch_mode_changed']);
  });

  it('does not wake the daemon for a value that did not change', async () => {
    useSettingsStore.getState().setFetchMode('keepRecent');
    useSettingsStore.getState().setLocalCacheDurationMonths(3);
    await settle();
    expect(daemonCall).not.toHaveBeenCalled();
  });

  it('refuses Hoarder without Premium, and honours it with', () => {
    useSettingsStore.getState().setFetchMode('hoarder');
    useSettingsStore.getState().setAccountFetchMode('acct1', 'hoarder');
    expect(useSettingsStore.getState().fetchMode).toBe('keepRecent');
    expect(useSettingsStore.getState().fetchModes).toEqual({});

    useSettingsStore.getState().setBillingProfile(PREMIUM);
    useSettingsStore.getState().setFetchMode('hoarder');
    expect(useSettingsStore.getState().fetchMode).toBe('hoarder');
  });

  it('ignores a mode it does not know', () => {
    useSettingsStore.getState().setFetchMode('everything');
    expect(useSettingsStore.getState().fetchMode).toBe('keepRecent');
  });

  it('stores a per-account override and clears it back to the default', () => {
    useSettingsStore.getState().setAccountFetchMode('acct1', 'onDemand');
    expect(useSettingsStore.getState().fetchModes).toEqual({ acct1: 'onDemand' });
    useSettingsStore.getState().setAccountFetchMode('acct1', null);
    expect(useSettingsStore.getState().fetchModes).toEqual({});
  });

  it('factory reset puts the mode and overrides back', () => {
    useSettingsStore.setState({ fetchMode: 'onDemand', fetchModes: { acct1: 'indexOnly' }, localCacheDurationMonths: 12 });
    useSettingsStore.getState().resetSettings();
    const s = useSettingsStore.getState();
    expect([s.fetchMode, s.fetchModes, s.localCacheDurationMonths]).toEqual(['keepRecent', {}, 3]);
  });
});

describe('settings transfer', () => {
  it('carries the mode and per-account overrides, never the Premium flag', async () => {
    const { GLOBAL_SETTINGS_ALLOWLIST, PER_ACCOUNT_MAPS } = await import('../../services/transfer/settingsTransfer');
    expect(GLOBAL_SETTINGS_ALLOWLIST).toContain('fetchMode');
    expect(PER_ACCOUNT_MAPS).toContain('fetchModes');
    expect(GLOBAL_SETTINGS_ALLOWLIST).not.toContain('fetchModePremium');
  });
});
