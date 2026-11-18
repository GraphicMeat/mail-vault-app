import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map());
vi.mock('../safeStorage', () => ({ safeStorage: {
  getItem: key => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
} }));
const { useSettingsStore, _mergePersistedSettings } = await import('../settingsStore');

beforeEach(() => useSettingsStore.getState().resetSettings());

describe('account group settings', () => {
  it('rejects malformed collapsedAccountGroups value before it enters the persisted patch', async () => {
    expect(_mergePersistedSettings({ collapsedAccountGroups: 42 }, {}).collapsedAccountGroups).toEqual({});
    for (const value of [42, null, [], { Work: 'yes', '': true }, Object.fromEntries(Array.from({ length: 150 }, (_, n) => [`Group${n}`, true]))]) {
      storage.set('mailvault-settings', JSON.stringify({ state: { collapsedAccountGroups: value }, version: 0 }));
      await useSettingsStore.persist.rehydrate();
      const folded = useSettingsStore.getState().collapsedAccountGroups;
      expect(folded && typeof folded === 'object' && !Array.isArray(folded)).toBe(true);
      expect(Object.values(folded).every(item => item === true)).toBe(true);
      expect(Object.keys(folded).every(name => name.length > 0 && name.length <= 40)).toBe(true);
      expect(Object.keys(folded).length).toBeLessThanOrEqual(100);
      if (Object.keys(folded).length === 100) {
        expect(folded.Group0).toBeUndefined();
        expect(folded.Group50).toBe(true);
        expect(folded.Group149).toBe(true);
      }
    }
  });
  it('stores normalized names and reuses casing', () => {
    const store = useSettingsStore.getState();
    store.setAccountGroup('a', ' Work  Team ');
    store.setAccountGroup('b', 'work team');
    expect(useSettingsStore.getState().accountGroups).toEqual({ a: 'Work Team', b: 'Work Team' });
  });
  it('removes a group when cleared', () => {
    useSettingsStore.getState().setAccountGroup('a', 'Work');
    useSettingsStore.getState().setAccountGroup('a', ' ');
    expect(useSettingsStore.getState().accountGroups).toEqual({});
  });
  it('persists and rehydrates group names', async () => {
    useSettingsStore.getState().setAccountGroup('a', 'Personal');
    const persisted = JSON.parse(storage.get('mailvault-settings'));
    expect(persisted.state.accountGroups).toEqual({ a: 'Personal' });
    useSettingsStore.setState({ accountGroups: {} });
    storage.set('mailvault-settings', JSON.stringify(persisted));
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().accountGroups).toEqual({ a: 'Personal' });
  });
  it('resets groups', () => {
    useSettingsStore.getState().setAccountGroup('a', 'Work');
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().accountGroups).toEqual({});
  });
  it('folds, unfolds, persists, rehydrates, and resets groups', async () => {
    useSettingsStore.getState().toggleAccountGroupCollapsed('Work');
    expect(useSettingsStore.getState().collapsedAccountGroups).toEqual({ Work: true });
    const persisted = storage.get('mailvault-settings');
    useSettingsStore.getState().toggleAccountGroupCollapsed('Work');
    expect(useSettingsStore.getState().collapsedAccountGroups).toEqual({});
    storage.set('mailvault-settings', persisted);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().collapsedAccountGroups).toEqual({ Work: true });
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().collapsedAccountGroups).toEqual({});
  });
  it('toggles Object.prototype group names', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      useSettingsStore.getState().toggleAccountGroupCollapsed(name);
      expect(Object.hasOwn(useSettingsStore.getState().collapsedAccountGroups, name)).toBe(true);
      useSettingsStore.getState().toggleAccountGroupCollapsed(name);
      expect(useSettingsStore.getState().collapsedAccountGroups).toEqual({});
    }
  });
});
