import { describe, expect, it, vi } from 'vitest';

vi.mock('../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const { useSettingsStore, _mergePersistedSettings, migrateSettings } = await import('../settingsStore');

describe('trackpad swipe settings', () => {
  it('are on by default: left archives, right toggles read', () => {
    const s = useSettingsStore.getState();
    expect(s.trackpadSwipeEnabled).toBe(true);
    expect(s.swipeLeftAction).toBe('archive');
    expect(s.swipeRightAction).toBe('toggleRead');
  });

  it('a stored action this build does not know falls back to the default; none is a choice', () => {
    const current = useSettingsStore.getState();
    const merged = _mergePersistedSettings({ swipeLeftAction: 'launchRockets', swipeRightAction: 'none' }, current);
    expect(merged.swipeLeftAction).toBe('archive');
    expect(merged.swipeRightAction).toBe('none');
    expect(_mergePersistedSettings({ swipeLeftAction: 'snooze' }, current).swipeLeftAction).toBe('snooze');
  });

  it('the setters store a known action and ignore anything else', () => {
    useSettingsStore.getState().setSwipeAction('left', 'snooze');
    useSettingsStore.getState().setSwipeAction('right', 'bogus');
    useSettingsStore.getState().setTrackpadSwipeEnabled(false);
    const s = useSettingsStore.getState();
    expect(s.swipeLeftAction).toBe('snooze');
    expect(s.swipeRightAction).toBe('toggleRead');
    expect(s.trackpadSwipeEnabled).toBe(false);
  });
});

describe('v8 -> v9: Snooze joins saved quick action lists once', () => {
  const saved = () => ({
    quickActions: {
      defaults: {
        row: { entries: [{ id: 'archive', action: 'archive' }] },
        selection: { entries: [{ id: 'markRead', action: 'markRead' }] },
        reader: { entries: [{ id: 'reply', action: 'reply' }] },
      },
    },
  });

  it('appends snooze to the row and selection lists, not the reader', () => {
    const { defaults } = migrateSettings(saved(), 8).quickActions;
    expect(defaults.row.entries.map(e => e.action)).toEqual(['archive', 'snooze']);
    expect(defaults.selection.entries.map(e => e.action)).toEqual(['markRead', 'snooze']);
    expect(defaults.reader.entries.map(e => e.action)).toEqual(['reply']);
  });

  it('never adds it twice, and leaves a v9 list alone', () => {
    const once = migrateSettings(saved(), 8);
    const twice = migrateSettings(once, 8);
    expect(twice.quickActions.defaults.row.entries.filter(e => e.action === 'snooze')).toHaveLength(1);
    expect(migrateSettings(saved(), 9).quickActions.defaults.row.entries.map(e => e.action)).toEqual(['archive']);
  });
});
