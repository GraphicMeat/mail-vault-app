import { describe, expect, it, vi } from 'vitest';

vi.mock('../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useSettingsStore, _mergePersistedSettings, normalizeListPreviewLines } = await import('../settingsStore');

describe('list preview lines', () => {
  it('are off by default, so the list looks as it always did', () => {
    expect(useSettingsStore.getState().listPreviewLines).toBe(0);
  });

  it('take 0 to 3 and read anything else as off', () => {
    expect([0, 1, 2, 3].map(normalizeListPreviewLines)).toEqual([0, 1, 2, 3]);
    expect([4, -1, '2', null, undefined, 1.5].map(normalizeListPreviewLines)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('the setter stores a choice and turns a bad one off', () => {
    useSettingsStore.getState().setListPreviewLines(2);
    expect(useSettingsStore.getState().listPreviewLines).toBe(2);
    useSettingsStore.getState().setListPreviewLines(9);
    expect(useSettingsStore.getState().listPreviewLines).toBe(0);
  });

  it('a stored value survives a reload, and a broken one reads as off', () => {
    const current = useSettingsStore.getState();
    expect(_mergePersistedSettings({ listPreviewLines: 3 }, current).listPreviewLines).toBe(3);
    expect(_mergePersistedSettings({ listPreviewLines: 'lots' }, current).listPreviewLines).toBe(0);
    expect(_mergePersistedSettings({}, { ...current, listPreviewLines: 0 }).listPreviewLines).toBe(0);
  });
});
