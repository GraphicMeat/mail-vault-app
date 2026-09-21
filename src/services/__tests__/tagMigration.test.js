// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn();
vi.mock('../daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { useSettingsStore } = await import('../../stores/settingsStore');
const { useTagStore } = await import('../../stores/tagStore');
const { migrateLocalMailLabels } = await import('../tagMigration');

const LABELS = [{ id: 'L1', name: 'Receipts' }, { id: 'L2', name: 'Clients' }];
const ASSIGNMENTS = {
  [JSON.stringify(['a', 'INBOX', 7])]: ['L1'],
  [JSON.stringify(['a', 'Archive', 9])]: ['L1', 'L2'],
};

beforeEach(() => {
  mockDaemonCall.mockReset();
  useTagStore.setState({ tags: [], byRow: {} });
  useSettingsStore.setState({
    localMailLabels: LABELS,
    localMailLabelAssignments: ASSIGNMENTS,
    quickActions: {
      defaults: { row: { entries: [{ id: 'tag:L2', action: 'tag', params: { labelId: 'L2' } }] } },
      overrides: { 'account:a': { reader: { entries: [{ id: 'tag:L1', action: 'tag', params: { labelId: 'L1' } }] } } },
    },
  });
});

describe('migrating the settings-file labels into the tag store', () => {
  it('flattens every assignment into one call', async () => {
    mockDaemonCall.mockResolvedValueOnce({ migrated: 3, dropped: 0, tagOfLabel: { L1: 't1', L2: 't2' } });
    mockDaemonCall.mockResolvedValueOnce([]);
    await migrateLocalMailLabels();
    const [method, params] = mockDaemonCall.mock.calls[0];
    expect(method).toBe('tags.migrate_legacy');
    expect(params.labels).toEqual(LABELS);
    expect(params.assignments).toEqual([
      { labelId: 'L1', accountId: 'a', mailbox: 'INBOX', uid: 7 },
      { labelId: 'L1', accountId: 'a', mailbox: 'Archive', uid: 9 },
      { labelId: 'L2', accountId: 'a', mailbox: 'Archive', uid: 9 },
    ]);
  });

  it('clears the old keys once the daemon has them', async () => {
    mockDaemonCall.mockResolvedValueOnce({ migrated: 3, dropped: 0, tagOfLabel: { L1: 't1', L2: 't2' } });
    mockDaemonCall.mockResolvedValueOnce([]);
    await migrateLocalMailLabels();
    expect(useSettingsStore.getState().localMailLabels).toEqual([]);
    expect(useSettingsStore.getState().localMailLabelAssignments).toEqual({});
  });

  it('repoints a configured tag quick action at the tag the label became', async () => {
    mockDaemonCall.mockResolvedValueOnce({ migrated: 3, dropped: 0, tagOfLabel: { L1: 't1', L2: 't2' } });
    mockDaemonCall.mockResolvedValueOnce([]);
    await migrateLocalMailLabels();
    const { quickActions } = useSettingsStore.getState();
    expect(quickActions.defaults.row.entries[0].params).toEqual({ tagId: 't2' });
    expect(quickActions.overrides['account:a'].reader.entries[0].params).toEqual({ tagId: 't1' });
  });

  it('keeps everything when the index cannot answer yet', async () => {
    mockDaemonCall.mockRejectedValueOnce(new Error('search index is not ready: no rows for account a yet'));
    const done = await migrateLocalMailLabels();
    expect(done).toBe(false);
    expect(useSettingsStore.getState().localMailLabels).toEqual(LABELS);
    expect(useSettingsStore.getState().localMailLabelAssignments).toEqual(ASSIGNMENTS);
  });

  it('does nothing at all when there is nothing left to migrate', async () => {
    useSettingsStore.setState({ localMailLabels: [], localMailLabelAssignments: {} });
    await migrateLocalMailLabels();
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });
});
