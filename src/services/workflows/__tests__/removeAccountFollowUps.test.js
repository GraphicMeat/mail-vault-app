// A removed account's follow-up reminders end with it: nothing would ever
// check them again (the daemon has no credentials for a removed account), and
// a pin naming an account the sidebar no longer has would open nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn();
vi.mock('../../daemonClient', () => ({ daemonCall: (...a) => mockDaemonCall(...a) }));
vi.mock('../../db', () => ({ deleteAccount: vi.fn() }));
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
const db = await import('../../db');
const api = await import('../../api');
const { unwatchAccount } = await import('../../syncService');

const row = (id, accountId, state = 'due') => ({ id, accountId, state, sentMailbox: 'Sent', sentUid: 1, seen: false });

beforeEach(() => {
  vi.clearAllMocks();
  db.deleteAccount.mockResolvedValue({ outcome: 'complete', accountId: 'gone' });
  state.accounts = [{ id: 'gone', email: 'gone@x.co' }, { id: 'kept', email: 'kept@x.co' }];
  state.activeAccountId = 'kept';
  mockDaemonCall.mockReset();
  mockDaemonCall.mockImplementation(async (method, params) => {
    if (method === 'follow_up.list') return [row('a', 'gone'), row('b', 'gone', 'waiting'), row('c', 'kept')].filter(r => !params?.accountId || r.accountId === params.accountId);
    return {};
  });
  useFollowUpStore.setState({ rows: [row('a', 'gone'), row('b', 'gone', 'waiting'), row('c', 'kept')] });
});

describe('removing an account', () => {
  it('drops only the completed account reminders without a second daemon deletion path', async () => {
    await removeAccount('gone');
    expect(mockDaemonCall).not.toHaveBeenCalled();
    expect(useFollowUpStore.getState().rows.map(r => r.id)).toEqual(['c']);
  });

  it.each(['busy', 'incomplete'])('does not disconnect or present %s as removed', async (outcome) => {
    db.deleteAccount.mockResolvedValue({ outcome, accountId: 'gone',
      ...(outcome === 'busy' ? { effects: 'none' } : {
        stage: 'credentials', completion: 'unknown', retry: 'afterSettlement', residuals: ['accountTree'],
      }) });
    let rejected = false;
    try { await removeAccount('gone'); } catch { rejected = true; }
    const remaining = state.accounts.map(account => account.id);
    const pending = useFollowUpStore.getState().rows.map(entry => entry.id);
    const disconnected = api.disconnect.mock.calls.length;
    const unwatched = unwatchAccount.mock.calls.length;
    if (!rejected || remaining.length !== 2 || pending.length !== 3 || disconnected || unwatched) {
      throw new Error(`S24_WORKFLOW_REFUSAL_ACTUAL: outcome=${outcome}, rejected=${rejected}, remaining=${remaining}, pending=${pending}, disconnected=${disconnected}, unwatched=${unwatched}`);
    }
  });
});
