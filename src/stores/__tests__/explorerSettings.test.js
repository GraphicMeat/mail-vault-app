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

describe('a saved view\'s own layout', () => {
  it('drops a persisted override it cannot read, keeps the keys it can', () => {
    const merged = _mergePersistedSettings({ viewOverrides: {
      bad: 'x', noStamp: { listView: 'list' },
      v1: { stamp: 's', listView: 'grid', grouping: 'field:f1', timeline: 'yes' },
    } }, useSettingsStore.getState());
    expect(merged.viewOverrides).toEqual({ v1: { stamp: 's', grouping: 'field:f1' } });
    expect(_mergePersistedSettings({ viewOverrides: [1] }, useSettingsStore.getState()).viewOverrides).toEqual({});
  });

  it('merges changes against the same saved layout and starts over against a new one', () => {
    const { setViewOverride } = useSettingsStore.getState();
    setViewOverride('v1', 'a', { listView: 'list' });
    setViewOverride('v1', 'a', { timeline: true });
    expect(useSettingsStore.getState().viewOverrides.v1).toEqual({ stamp: 'a', listView: 'list', timeline: true });
    setViewOverride('v1', 'b', { grouping: 'date' });
    expect(useSettingsStore.getState().viewOverrides.v1).toEqual({ stamp: 'b', grouping: 'date' });
    useSettingsStore.getState().clearViewOverride('v1');
    expect(useSettingsStore.getState().viewOverrides.v1).toBeUndefined();
  });

});
