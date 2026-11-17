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
});
