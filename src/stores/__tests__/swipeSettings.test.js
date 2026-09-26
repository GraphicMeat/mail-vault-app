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
    // v10 then appends Unsubscribe to the row list (see below).
    expect(defaults.row.entries.map(e => e.action)).toEqual(['archive', 'snooze', 'unsubscribe']);
    expect(defaults.selection.entries.map(e => e.action)).toEqual(['markRead', 'snooze']);
    expect(defaults.reader.entries.map(e => e.action)).toEqual(['reply']);
  });

  it('never adds it twice, and leaves a v9 list alone', () => {
    const once = migrateSettings(saved(), 8);
    const twice = migrateSettings(once, 8);
    expect(twice.quickActions.defaults.row.entries.filter(e => e.action === 'snooze')).toHaveLength(1);
    expect(migrateSettings(saved(), 9).quickActions.defaults.row.entries.map(e => e.action)).toEqual(['archive', 'unsubscribe']);
    expect(migrateSettings(saved(), 10).quickActions.defaults.row.entries.map(e => e.action)).toEqual(['archive']);
  });
});

describe('v9 -> v10: Unsubscribe joins the saved row list once', () => {
  const saved = (row = [{ id: 'archive', action: 'archive' }, { id: 'snooze', action: 'snooze' }]) => ({
    quickActions: {
      defaults: {
        row: { mode: 'radial', entries: row },
        selection: { entries: [{ id: 'markRead', action: 'markRead' }] },
        reader: { entries: [{ id: 'reply', action: 'reply' }] },
      },
    },
  });
  const actions = (state, surface) => state.quickActions.defaults[surface].entries.map(e => e.action);

  it('appends it to a v9 row list, last, and nowhere else', () => {
    const next = migrateSettings(saved(), 9);
    expect(actions(next, 'row')).toEqual(['archive', 'snooze', 'unsubscribe']);
    expect(next.quickActions.defaults.row.mode).toBe('radial');
    expect(actions(next, 'selection')).toEqual(['markRead']);
    expect(actions(next, 'reader')).toEqual(['reply']);
  });

  it('adds it once, even when a list already has it', () => {
    const twice = migrateSettings(migrateSettings(saved(), 9), 9);
    expect(actions(twice, 'row').filter(a => a === 'unsubscribe')).toHaveLength(1);
    const had = saved([{ id: 'unsubscribe', action: 'unsubscribe' }, { id: 'archive', action: 'archive' }]);
    expect(actions(migrateSettings(had, 9), 'row')).toEqual(['unsubscribe', 'archive']);
  });

  it('leaves a v10 list alone, so removing it after the upgrade sticks', () => {
    expect(actions(migrateSettings(saved(), 10), 'row')).toEqual(['archive', 'snooze']);
  });

  it('is in the row defaults of a new install', () => {
    expect(useSettingsStore.getState().quickActions.defaults.row.entries.some(e => e.action === 'unsubscribe')).toBe(true);
  });
});
