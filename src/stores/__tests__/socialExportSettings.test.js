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

  it('corners start at the macOS window radius, 12', () => {
    expect(DEFAULT_SOCIAL_EXPORT.radius).toBe(12);
    expect(useSettingsStore.getState().socialExport.radius).toBe(12);
  });

  it('keeps a saved radius as the user\'s choice (no migration of an old 26)', () => {
    const merged = _mergePersistedSettings({ socialExport: { radius: 26 } }, useSettingsStore.getState()).socialExport;
    expect(merged.radius).toBe(26);
  });

  it('width: the export column by default, clamped to the slider, anything not a number is the default', () => {
    expect(DEFAULT_SOCIAL_EXPORT.width).toBe(820);
    const merge = (width) => _mergePersistedSettings({ socialExport: { width } }, useSettingsStore.getState()).socialExport.width;
    expect(merge(1200)).toBe(1200);
    expect(merge(100)).toBe(480);
    expect(merge(5000)).toBe(1600);
    expect(merge('1200')).toBe(820);
    expect(merge(Number.NaN)).toBe(820);
    expect(merge(undefined)).toBe(820);
  });

  it('senderDetails and links: off by default, kept as booleans, anything else is off', () => {
    expect(DEFAULT_SOCIAL_EXPORT).toMatchObject({ senderDetails: false, links: false });
    const merge = (socialExport) => _mergePersistedSettings({ socialExport }, useSettingsStore.getState()).socialExport;
    expect(merge({ senderDetails: true, links: true })).toMatchObject({ senderDetails: true, links: true });
    expect(merge({ senderDetails: false, links: false })).toMatchObject({ senderDetails: false, links: false });
    for (const junk of ['true', 1, {}, null, undefined]) {
      expect(merge({ senderDetails: junk, links: junk })).toMatchObject({ senderDetails: false, links: false });
    }
    const { setSocialExport } = useSettingsStore.getState();
    setSocialExport({ links: true });
    expect(useSettingsStore.getState().socialExport.links).toBe(true);
    setSocialExport({ links: 'yes', senderDetails: true });
    expect(useSettingsStore.getState().socialExport).toMatchObject({ links: false, senderDetails: true });
  });
});
