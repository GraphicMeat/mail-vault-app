import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../safeStorage', () => ({ safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
const { useSettingsStore, _mergePersistedSettings } = await import('../settingsStore');

beforeEach(() => useSettingsStore.getState().resetSettings());

describe('Explorer preferences', () => {
  it('restores the chosen view and rejects invalid persisted options', () => {
    const store = useSettingsStore.getState();
    expect(typeof store.setEmailListView).toBe('function');
    store.setEmailListView('explorer');
    store.setExplorerGrouping('sender');
    store.setExplorerDateDepth('day');
    expect(useSettingsStore.getState()).toMatchObject({ emailListView: 'explorer', explorerGrouping: 'sender', explorerDateDepth: 'day' });
    const valid = _mergePersistedSettings({ emailListView: 'explorer', explorerGrouping: 'conversation', explorerDateDepth: 'day' }, store);
    expect(valid).toMatchObject({ emailListView: 'explorer', explorerGrouping: 'conversation', explorerDateDepth: 'day' });
    const invalid = _mergePersistedSettings({ emailListView: 'oops', explorerGrouping: 'oops', explorerDateDepth: 'oops' }, store);
    expect(invalid).toMatchObject({ emailListView: 'list', explorerGrouping: 'date', explorerDateDepth: 'month' });
  });

  it('remembers independent paths and copies callers arrays', () => {
    const store = useSettingsStore.getState();
    expect(typeof store.setExplorerPath).toBe('function');
    const path = ['2026', 'September'];
    store.setExplorerPath('account-a:INBOX:date', path);
    path.push('mutated');
    store.setExplorerPath('account-b:INBOX:date', ['2025']);
    expect(useSettingsStore.getState().explorerPaths).toEqual({ 'account-a:INBOX:date': ['2026', 'September'], 'account-b:INBOX:date': ['2025'] });
    const restored = _mergePersistedSettings({ explorerPaths: { good: ['a'], bad: 1, nested: [{}] } }, store);
    expect(restored.explorerPaths).toEqual({ good: ['a'] });
  });

  it('resets navigation and bounds remembered mailbox scopes', () => {
    const store = useSettingsStore.getState();
    expect(typeof store.setExplorerPath).toBe('function');
    for (let index = 0; index < 110; index++) store.setExplorerPath(`scope-${index}`, ['year']);
    expect(Object.keys(useSettingsStore.getState().explorerPaths)).toHaveLength(100);
    expect(useSettingsStore.getState().explorerPaths['scope-109']).toEqual(['year']);
    store.resetSettings();
    expect(useSettingsStore.getState()).toMatchObject({ emailListView: 'list', explorerGrouping: 'date', explorerDateDepth: 'month', explorerPaths: {} });
  });
});
