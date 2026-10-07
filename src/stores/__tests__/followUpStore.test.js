// @vitest-environment jsdom
//
// Follow-up reminders: the rows come from the daemon, the `follow-up` event
// keeps them current, and a row that went due is announced once ever, through
// the notify chokepoint, on the event and on launch alike.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { create } from 'zustand';

const listeners = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name, cb) => { listeners[name] = cb; return Promise.resolve(() => {}); },
}));

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...a) => mockDaemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));

const mockNotify = vi.fn().mockResolvedValue(undefined);
vi.mock('../focusStore', () => ({ notify: (...a) => mockNotify(...a) }));

const settingsStore = create(() => ({ notificationSettings: { enabled: true, sound: 'none' } }));
vi.mock('../settingsStore', () => ({
  useSettingsStore: Object.assign((s) => settingsStore(s), { getState: () => settingsStore.getState() }),
}));

const { useFollowUpStore, initFollowUp, announceDue, dueFollowUps, followUpsInView, _resetFollowUpForTest } =
  await import('../followUpStore');

const WAITING = { id: 'w', accountId: 'a1', messageId: '<w@me>', subject: 'Later', recipients: 'ana@x.co', sentAt: 1000, remindAt: 9e12, state: 'waiting', sentMailbox: 'Sent', sentUid: null, seen: false, announced: false };
const DUE = { ...WAITING, id: 'd', messageId: '<d@me>', subject: 'Quote', remindAt: Date.UTC(2026, 9, 5), state: 'due', sentUid: 42 };

const fire = (payload) => listeners['follow-up']({ payload });

beforeEach(() => {
  mockDaemonCall.mockReset();
  mockNotify.mockClear();
  _resetFollowUpForTest();
  useFollowUpStore.setState({ rows: [] });
});

describe('follow-up rows', () => {
  it('announces a row that went due while the app was closed, once, on launch', async () => {
    mockDaemonCall.mockImplementation(async (method) => (method === 'follow_up.list' ? [WAITING, DUE] : {}));
    initFollowUp();
    await vi.waitFor(() => expect(mockNotify).toHaveBeenCalledTimes(1));
    const [title, body, , target] = mockNotify.mock.calls[0];
    expect(title).toBeTruthy();
    expect(body).toContain('Quote');
    expect(target).toEqual({ accountId: 'a1', mailbox: 'INBOX' });
    await vi.waitFor(() => expect(mockDaemonCall).toHaveBeenCalledWith('follow_up.mark_announced', { id: 'd' }));

    await announceDue();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('never announces a row the daemon says was announced', async () => {
    useFollowUpStore.setState({ rows: [{ ...DUE, announced: true }] });
    await announceDue();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('reads the rows again when one goes due, then announces it', async () => {
    mockDaemonCall.mockImplementation(async (method) => (method === 'follow_up.list' ? [WAITING] : {}));
    initFollowUp();
    await vi.waitFor(() => expect(listeners['follow-up']).toBeTypeOf('function'));
    await vi.waitFor(() => expect(useFollowUpStore.getState().rows).toHaveLength(1));

    mockDaemonCall.mockImplementation(async (method) => (method === 'follow_up.list' ? [{ ...WAITING, ...DUE, id: 'w' }] : {}));
    await fire({ id: 'w', state: 'due' });
    expect(dueFollowUps(useFollowUpStore.getState().rows).map(r => r.sentUid)).toEqual([42]);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('drops a row that ended', async () => {
    mockDaemonCall.mockResolvedValue([WAITING, DUE]);
    initFollowUp();
    await vi.waitFor(() => expect(useFollowUpStore.getState().rows).toHaveLength(2));
    await fire({ id: 'w', state: 'replied' });
    await fire({ id: 'd', state: 'dismissed' });
    expect(useFollowUpStore.getState().rows).toEqual([]);
  });

  it('opening keeps the row and remembers it was read; dismiss ends it', async () => {
    mockDaemonCall.mockResolvedValue({});
    useFollowUpStore.setState({ rows: [DUE] });
    await useFollowUpStore.getState().setSeen('d', true);
    expect(useFollowUpStore.getState().rows[0].seen).toBe(true);
    expect(mockDaemonCall).toHaveBeenCalledWith('follow_up.mark_seen', { id: 'd', seen: true });
    await useFollowUpStore.getState().dismiss('d');
    expect(useFollowUpStore.getState().rows).toEqual([]);
    expect(mockDaemonCall).toHaveBeenCalledWith('follow_up.dismiss', { id: 'd' });
  });
});

describe('the reminders a list pins above its rows', () => {
  it('a waiting row, or one with no Sent copy found, is not shown', () => {
    expect(dueFollowUps([WAITING, { ...DUE, sentUid: null }, DUE]).map(r => r.id)).toEqual(['d']);
  });

  it('an inbox pins its own account\'s, All inboxes every visible account\'s, newest first', () => {
    const other = { ...DUE, id: 'o', accountId: 'a2', remindAt: DUE.remindAt + 1000 };
    const rows = [DUE, other, WAITING];
    expect(followUpsInView({ activeMailbox: 'INBOX', activeAccountId: 'a1' }, rows).map(r => r.id)).toEqual(['d']);
    expect(followUpsInView({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX' }, rows).map(r => r.id)).toEqual(['o', 'd']);
    expect(followUpsInView({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX' }, rows, { a2: true }).map(r => r.id)).toEqual(['d']);
  });

  it('no other folder pins them', () => {
    expect(followUpsInView({ activeMailbox: 'Sent', activeAccountId: 'a1' }, [DUE])).toEqual([]);
    expect(followUpsInView({ activeMailbox: 'UNIFIED', unifiedFolder: 'Sent' }, [DUE])).toEqual([]);
    expect(followUpsInView({ activeMailbox: 'INBOX', activeAccountId: 'a1', mailboxScope: 'INBOX' }, [DUE])).toEqual([]);
  });
});
