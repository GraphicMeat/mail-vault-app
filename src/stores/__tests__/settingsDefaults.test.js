import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// The provider default is read from the platform once, at module load.
async function loadOn(platform) {
  vi.stubGlobal('navigator', { platform, userAgent: platform, language: 'en-US', languages: ['en-US'] });
  vi.resetModules();
  return import('../settingsStore');
}

describe('settings defaults', () => {
  it('a Mac starts on Apple Intelligence, everything else on the local model', async () => {
    expect((await loadOn('MacIntel')).DEFAULT_AI_SETTINGS.provider).toBe('appleFm');
    expect((await loadOn('Win32')).DEFAULT_AI_SETTINGS.provider).toBe('localGguf');
  });

  it('moves a Mac that never turned AI on to Apple Intelligence, and nothing else', async () => {
    const off = { aiSettings: { enabled: false, provider: 'localGguf', endpointUrl: '' } };
    const on = { aiSettings: { enabled: true, provider: 'localGguf', endpointUrl: '' } };
    const mac = await loadOn('MacIntel');
    expect(mac.migrateSettings(off, 7).aiSettings.provider).toBe('appleFm');
    expect(mac.migrateSettings(on, 7).aiSettings.provider).toBe('localGguf');
    expect(mac.migrateSettings(off, 8).aiSettings.provider).toBe('localGguf');
    expect((await loadOn('Win32')).migrateSettings(off, 7).aiSettings.provider).toBe('localGguf');
  });

  it('a fresh install plays Glass; an older blob without a sound stays silent', async () => {
    const { useSettingsStore, _mergePersistedSettings } = await loadOn('MacIntel');
    const current = useSettingsStore.getState();
    expect(current.notificationSettings.sound).toBe('Glass');
    expect(_mergePersistedSettings({ notificationSettings: { enabled: true } }, current).notificationSettings.sound).toBe('none');
    expect(_mergePersistedSettings({}, current).notificationSettings.sound).toBe('Glass');
  });

  it('compose opens in the app unless set to a window', async () => {
    const { useSettingsStore } = await loadOn('Win32');
    expect(useSettingsStore.getState().composeOpenMode).toBe('app');
    useSettingsStore.getState().setComposeOpenMode('window');
    expect(useSettingsStore.getState().composeOpenMode).toBe('window');
    useSettingsStore.getState().setComposeOpenMode('bogus');
    expect(useSettingsStore.getState().composeOpenMode).toBe('app');
  });

  it('text starts in Instrument Sans at 100%, keeps only known choices, and travels in a transfer', async () => {
    const { useSettingsStore } = await loadOn('Win32');
    const { GLOBAL_SETTINGS_ALLOWLIST } = await import('../../services/transfer/settingsTransfer');
    const state = () => useSettingsStore.getState();
    expect(state()).toMatchObject({ appFont: 'instrument-sans', textScale: 1 });
    state().setAppFont('fira-code');
    state().setTextScale('1.25');
    expect(state()).toMatchObject({ appFont: 'fira-code', textScale: 1.25 });
    state().setAppFont('comic-sans');
    state().setTextScale(3);
    expect(state()).toMatchObject({ appFont: 'instrument-sans', textScale: 1 });
    expect(GLOBAL_SETTINGS_ALLOWLIST).toEqual(expect.arrayContaining(['appFont', 'textScale']));
  });
});
