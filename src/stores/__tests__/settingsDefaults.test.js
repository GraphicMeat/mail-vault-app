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
});
