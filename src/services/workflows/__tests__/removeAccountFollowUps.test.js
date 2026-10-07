// A removed account's follow-up reminders end with it: nothing would ever
// check them again (the daemon has no credentials for a removed account), and
// a pin naming an account the sidebar no longer has would open nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn();
vi.mock('../../daemonClient', () => ({ daemonCall: (...a) => mockDaemonCall(...a) }));
vi.mock('../../db', () => ({ deleteAccount: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../api', () => ({ disconnect: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../syncService', () => ({ unwatchAccount: vi.fn() }));
vi.mock('../../cacheManager', () => ({ invalidateRestoreDescriptors: vi.fn(), clearGraphIdMap: vi.fn() }));
vi.mock('../../../stores/unreadCounts', () => ({ forgetAccount: vi.fn() }));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ hiddenAccounts: {}, getLastMailbox: () => 'INBOX', notificationSettings: {} }) },
}));

const state = {
  accounts: [{ id: 'gone', email: 'gone@x.co' }, { id: 'kept', email: 'kept@x.co' }],
  activeAccountId: 'kept',
  activateAccount: vi.fn(),
};
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: { getState: () => state, setState: (p) => Object.assign(state, typeof p === 'function' ? p(state) : p) },
}));

const { removeAccount } = await import('../removeAccount');
const { useFollowUpStore } = await import('../../../stores/followUpStore');

const row = (id, accountId, state = 'due') => ({ id, accountId, state, sentMailbox: 'Sent', sentUid: 1, seen: false });

beforeEach(() => {
  mockDaemonCall.mockReset();
  mockDaemonCall.mockImplementation(async (method, params) => {
    if (method === 'follow_up.list') return [row('a', 'gone'), row('b', 'gone', 'waiting'), row('c', 'kept')].filter(r => !params?.accountId || r.accountId === params.accountId);
    return {};
  });
  useFollowUpStore.setState({ rows: [row('a', 'gone'), row('b', 'gone', 'waiting'), row('c', 'kept')] });
});

describe('removing an account', () => {
  it('dismisses every reminder of that account, waiting or due, and no other', async () => {
    await removeAccount('gone');
    await vi.waitFor(() => expect(mockDaemonCall.mock.calls.filter(([m]) => m === 'follow_up.dismiss')).toHaveLength(2));
    const ended = mockDaemonCall.mock.calls.filter(([m]) => m === 'follow_up.dismiss').map(([, p]) => p.id).sort();
    expect(ended).toEqual(['a', 'b']);
    expect(useFollowUpStore.getState().rows.map(r => r.id)).toEqual(['c']);
  });
});
