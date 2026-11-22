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

  it('mail the views hold stays in the mailbox lists until asked', async () => {
    const { useSettingsStore } = await loadOn('Win32');
    const state = () => useSettingsStore.getState();
    expect(state().hideViewMail).toBe(false);
    state().setHideViewMail(1);
    expect(state().hideViewMail).toBe(true);
    state().setHideViewMail(undefined);
    expect(state().hideViewMail).toBe(false);
    const { GLOBAL_SETTINGS_ALLOWLIST } = await import('../../services/transfer/settingsTransfer');
    expect(GLOBAL_SETTINGS_ALLOWLIST).toContain('hideViewMail');
    expect(GLOBAL_SETTINGS_ALLOWLIST).toContain('hideViewMailViews');
  });

  it('the views whose mail is hidden start unpicked and keep only view ids', async () => {
    const { useSettingsStore } = await loadOn('Win32');
    const state = () => useSettingsStore.getState();
    expect(state().hideViewMailViews).toBeNull();
    state().setHideViewMailViews(['v1', 'v1', 3, '', 'v2']);
    expect(state().hideViewMailViews).toEqual(['v1', 'v2']);
    state().setHideViewMailViews([]);
    expect(state().hideViewMailViews).toEqual([]);
    state().setHideViewMailViews('v1');
    expect(state().hideViewMailViews).toEqual([]);
  });

  // A folder can keep its own pick. Absent follows the all-folders pick, an
  // empty list hides nothing there, and null drops the folder's own pick.
  it('a folder keeps its own pick of views to hide, and can go back to the default', async () => {
    const { useSettingsStore } = await loadOn('Win32');
    const { GLOBAL_SETTINGS_ALLOWLIST, PER_ACCOUNT_MAPS } = await import('../../services/transfer/settingsTransfer');
    const state = () => useSettingsStore.getState();
    expect(state().hideViewMailByMailbox).toEqual({});
    expect(PER_ACCOUNT_MAPS).toContain('hideViewMailByMailbox');
    expect(GLOBAL_SETTINGS_ALLOWLIST).not.toContain('hideViewMailByMailbox');
    state().setHideViewMailForMailbox('a1', 'INBOX', ['v1', 'v1', 3, '']);
    state().setHideViewMailForMailbox('a1', 'Work|Bills', []);
    state().setHideViewMailForMailbox('a2', 'INBOX', ['v2']);
    expect(state().hideViewMailByMailbox).toEqual({ a1: { INBOX: ['v1'], 'Work|Bills': [] }, a2: { INBOX: ['v2'] } });
    state().setHideViewMailForMailbox('a1', 'INBOX', null);
    state().setHideViewMailForMailbox('a2', 'INBOX', null);
    expect(state().hideViewMailByMailbox).toEqual({ a1: { 'Work|Bills': [] } });
    state().setHideViewMailForMailbox('', 'INBOX', ['v1']);
    state().setHideViewMailForMailbox('a1', '', ['v1']);
    expect(state().hideViewMailByMailbox).toEqual({ a1: { 'Work|Bills': [] } });
  });

  // An account can keep its own pick too: it replaces the all-accounts pick
  // in each of that account's folders, under any folder's own pick.
  it('an account keeps its own pick of views to hide, and can go back to the default', async () => {
    const { useSettingsStore } = await loadOn('Win32');
    const { GLOBAL_SETTINGS_ALLOWLIST, PER_ACCOUNT_MAPS } = await import('../../services/transfer/settingsTransfer');
    const state = () => useSettingsStore.getState();
    expect(state().hideViewMailByAccount).toEqual({});
    expect(PER_ACCOUNT_MAPS).toContain('hideViewMailByAccount');
    expect(GLOBAL_SETTINGS_ALLOWLIST).not.toContain('hideViewMailByAccount');
    state().setHideViewMailForAccount('a1', ['v1', 'v1', 3, '']);
    state().setHideViewMailForAccount('a2', []);
    expect(state().hideViewMailByAccount).toEqual({ a1: ['v1'], a2: [] });
    state().setHideViewMailForAccount('a1', null);
    state().setHideViewMailForAccount('', ['v1']);
    expect(state().hideViewMailByAccount).toEqual({ a2: [] });
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
