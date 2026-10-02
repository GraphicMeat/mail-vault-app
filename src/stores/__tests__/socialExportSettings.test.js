import { describe, expect, it, vi } from 'vitest';

vi.mock('../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useSettingsStore, _mergePersistedSettings, DEFAULT_SOCIAL_EXPORT } = await import('../settingsStore');

describe('social export style', () => {
  it('starts on the defaults', () => {
    expect(useSettingsStore.getState().socialExport).toEqual(DEFAULT_SOCIAL_EXPORT);
  });

  it('stores a patch, but never the redact choice or an own image', () => {
    const { setSocialExport } = useSettingsStore.getState();
    setSocialExport({ size: 'story', background: { type: 'solid', id: 'black' } });
    setSocialExport({ redact: false, background: { type: 'image', image: {} } });
    const s = useSettingsStore.getState().socialExport;
    expect(s).toMatchObject({ size: 'story', background: { type: 'solid', id: 'black' } });
    expect(s).not.toHaveProperty('redact');
  });

  it('a stored style survives a reload; missing keys and an image background fall back', () => {
    const current = useSettingsStore.getState();
    const merged = _mergePersistedSettings({ socialExport: { padding: 120, background: { type: 'image' } } }, current).socialExport;
    expect(merged).toEqual({ ...DEFAULT_SOCIAL_EXPORT, padding: 120 });
  });

  it('drops the old `theme` key: the choices are appTheme and mailTheme', () => {
    const merged = _mergePersistedSettings({ socialExport: { theme: 'dark' } }, useSettingsStore.getState()).socialExport;
    expect(merged).not.toHaveProperty('theme');
  });

  it('appTheme: follows the app by default, keeps light or dark, drops anything else', () => {
    expect(DEFAULT_SOCIAL_EXPORT.appTheme).toBeNull();
    const merge = (socialExport) => _mergePersistedSettings({ socialExport }, useSettingsStore.getState()).socialExport;
    expect(merge({ appTheme: 'light' }).appTheme).toBe('light');
    expect(merge({ appTheme: 'dark' }).appTheme).toBe('dark');
    for (const junk of ['sepia', 5, {}, undefined, null]) expect(merge({ appTheme: junk }).appTheme).toBeNull();
    const { setSocialExport } = useSettingsStore.getState();
    setSocialExport({ appTheme: 'light' });
    expect(useSettingsStore.getState().socialExport.appTheme).toBe('light');
    setSocialExport({ appTheme: 'blue' });
    expect(useSettingsStore.getState().socialExport.appTheme).toBeNull();
  });

  it('mailTheme: follows the Appearance by default, keeps light or dark, drops anything else', () => {
    expect(DEFAULT_SOCIAL_EXPORT.mailTheme).toBeNull();
    const merge = (socialExport) => _mergePersistedSettings({ socialExport }, useSettingsStore.getState()).socialExport;
    expect(merge({ mailTheme: 'light' }).mailTheme).toBe('light');
    expect(merge({ mailTheme: 'dark' }).mailTheme).toBe('dark');
    for (const junk of ['sepia', 5, {}, undefined, null]) expect(merge({ mailTheme: junk }).mailTheme).toBeNull();
    const { setSocialExport } = useSettingsStore.getState();
    setSocialExport({ mailTheme: 'dark' });
    expect(useSettingsStore.getState().socialExport.mailTheme).toBe('dark');
    setSocialExport({ mailTheme: 'blue' });
    expect(useSettingsStore.getState().socialExport.mailTheme).toBeNull();
  });
});
