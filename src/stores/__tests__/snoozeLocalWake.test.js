// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const listeners = {};
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name, cb) => {
  listeners[name] = cb;
  return () => { delete listeners[name]; };
} }));

const LOCAL = { id: 'local', accountId: 'a1', fromMailbox: 'INBOX',
  snoozedMailbox: '', messageId: '<held@x>', state: 'snoozed' };
const REMOTE = { ...LOCAL, id: 'remote', snoozedMailbox: 'Snoozed' };
const proof = { instanceId: 'native-1', gen: 4 };
const notification = { id: 'notice-1', instanceId: 'native-1', accountId: 'a1', mailbox: 'INBOX' };
const mockDaemonCall = vi.fn();
const mockDeliver = vi.fn(async () => {});
const mockReload = vi.fn(async () => {});
const mockApplySeen = vi.fn();
const mail = { accounts: [{ id: 'a1', email: 'a@test' }], emails: [], activeAccountId: 'a1', activeMailbox: 'INBOX' };

vi.mock('../../services/daemonClient.js', () => ({ daemonCall: (...args) => mockDaemonCall(...args) }));
vi.mock('../../services/nativeArrival.js', () => ({ deliverPreparedNotice: (...args) => mockDeliver(...args) }));
vi.mock('../../services/nativeSyncContext.js', () => ({ nativeInstanceId: () => 'native-1' }));
vi.mock('../../services/db/accounts.js', () => ({ accountExpectedContext: account => ({
  id: account.id, email: account.email,
}) }));
vi.mock('../mailStore.js', () => ({ useMailStore: { getState: () => mail } }));
vi.mock('../../services/cacheManager.js', () => ({ invalidateRestoreDescriptors: vi.fn() }));
vi.mock('../../services/workflows/messageMutations.js', () => ({
  reloadListInView: (...args) => mockReload(...args),
  applySeenLocally: (...args) => mockApplySeen(...args),
}));

const { initSnooze, useSnoozeStore } = await import('../snoozeStore.js');
const fire = payload => listeners.snooze({ payload });

describe('one-use native local wake', () => {
  beforeAll(async () => {
    mockDaemonCall.mockResolvedValue([LOCAL, REMOTE]);
    initSnooze();
    await vi.waitFor(() => expect(listeners.snooze).toBeTypeOf('function'));
  });

  beforeEach(() => {
    mail.accounts = [{ id: 'a1', email: 'a@test' }];
    mail.emails = [];
    useSnoozeStore.setState({ rows: [LOCAL, REMOTE] });
    mockDaemonCall.mockReset().mockResolvedValue({ status: 'prepared', notification });
    mockDeliver.mockClear();
    mockReload.mockClear();
    mockApplySeen.mockClear();
  });

  it('uses only the timed native proof and delivers the prepared decision', async () => {
    await fire({ id: 'local', state: 'woken', woke: true,
      arrival: { kind: 'local-wake', wakeRef: proof } });
    expect(mockDaemonCall).toHaveBeenCalledWith('notify.arrival', {
      snoozeId: 'local', wakeRef: proof, rearm: true,
    });
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    expect(mockDeliver).toHaveBeenCalledWith(notification);
    expect(mockReload).toHaveBeenCalledTimes(1);
    expect(useSnoozeStore.getState().rows.map(row => row.id)).toEqual(['remote']);
  });

  it('does not derive authority from a saved local row or old UID', async () => {
    await fire({ id: 'local', state: 'woken', woke: true });
    expect(mockDaemonCall).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('does not prepare undo or remote wake', async () => {
    await fire({ id: 'local', state: 'woken', woke: false,
      arrival: { kind: 'local-wake', wakeRef: proof } });
    await fire({ id: 'remote', state: 'woken', woke: true });
    expect(mockDaemonCall).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('does not display an unavailable or stale-source response', async () => {
    mockDaemonCall.mockResolvedValueOnce({ status: 'unavailable', reason: 'consumed-proof' });
    await fire({ id: 'local', state: 'woken', woke: true,
      arrival: { kind: 'local-wake', wakeRef: proof } });
    expect(mockDeliver).not.toHaveBeenCalled();
    useSnoozeStore.setState({ rows: [LOCAL] });
    let finish;
    mockDaemonCall.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = fire({ id: 'local', state: 'woken', woke: true,
      arrival: { kind: 'local-wake', wakeRef: proof } });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    mail.accounts = [{ id: 'a1', email: 'replacement@test' }];
    finish({ status: 'prepared', notification });
    await pending;
    expect(mockDeliver).not.toHaveBeenCalled();
  });
});
