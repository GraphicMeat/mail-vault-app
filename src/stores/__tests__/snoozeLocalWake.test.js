// @vitest-environment jsdom
//
// A local snooze's wake (no Snoozed folder on the server) only clears \Seen
// where the message already is: the sync that follows sees no arrival, so no
// new-mail banner would ever say it is back. The app raises it off the
// daemon's `snooze` event instead, for THAT message, not the folder's newest.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { create } from 'zustand';

// The scheduler reads `window.__TAURI__.core.invoke` at module load; without
// it every banner is dropped before notify() is reached.
window.__TAURI__ = { core: { invoke: vi.fn().mockResolvedValue(undefined) } };

const listeners = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name, cb) => { listeners[name] = cb; return Promise.resolve(() => {}); },
}));

const LOCAL = { id: 'local', accountId: 'a1', fromMailbox: 'INBOX', snoozedMailbox: '', uidInSnoozed: 5, messageId: '<held@x>', wakeAt: 1, state: 'snoozed' };
const SERVER = { ...LOCAL, id: 'server', snoozedMailbox: 'Snoozed', messageId: '<moved@x>' };

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...a) => mockDaemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));

// The folder's newest message is someone else's: the banner must not show it.
const mockGetEmailHeaders = vi.fn().mockResolvedValue({
  totalEmails: 2,
  emails: [
    { uid: 9, messageId: '<newest@x>', from: { name: 'Newest', address: 'n@x.co' }, subject: 'Not this one' },
    { uid: 5, messageId: 'held@x', from: { name: 'Ada', address: 'ada@one.co' }, subject: 'Back again' },
  ],
});
vi.mock('../../services/db', () => ({
  getEmailHeaders: (...a) => mockGetEmailHeaders(...a),
  getEmailHeadersPartial: vi.fn().mockResolvedValue(null),
}));

const mockNotify = vi.fn();
vi.mock('../focusStore', () => ({ notify: (...a) => mockNotify(...a) }));

const mockReload = vi.fn().mockResolvedValue(undefined);
// The row coming back unread is snoozeWakeUnread.test.js's subject.
vi.mock('../../services/workflows/messageMutations', () => ({ reloadListInView: (...a) => mockReload(...a), applySeenLocally: vi.fn() }));

vi.mock('../../services/searchIndex', () => ({ onDaemonReconnected: () => Promise.resolve(() => {}) }));

const mailStore = create(() => ({ accounts: [{ id: 'a1', email: 'me@one.co' }], emails: [] }));
const facade = Object.assign((s) => mailStore(s), { getState: () => mailStore.getState(), setState: (p) => mailStore.setState(p) });
vi.mock('../mailStore', () => ({ useMailStore: facade }));
vi.mock('../accountStore', () => ({ useAccountStore: facade }));
vi.mock('../messageListStore', () => ({ useMessageListStore: facade }));

const settingsStore = create(() => ({ notificationSettings: { enabled: true, showPreview: true, accounts: {} } }));
vi.mock('../settingsStore', () => ({
  useSettingsStore: Object.assign((s) => settingsStore(s), { getState: () => settingsStore.getState() }),
  hasPremiumAccess: () => false,
  selectOwnAddresses: (_state, account) => [account?.email].filter(Boolean),
}));

const { initSnooze, useSnoozeStore } = await import('../snoozeStore');

// What Tauri hands the callback: the event, its payload inside.
const fire = (payload) => listeners.snooze({ payload });

describe('the wake of a local snooze', () => {
  beforeAll(async () => {
    mockDaemonCall.mockResolvedValue([LOCAL, SERVER]);
    initSnooze();
    await vi.waitFor(() => expect(listeners.snooze).toBeTypeOf('function'));
  });

  beforeEach(() => {
    mockNotify.mockClear();
    mockReload.mockClear();
    mockGetEmailHeaders.mockClear();
    useSnoozeStore.setState({ rows: [LOCAL, SERVER] });
  });

  it('announces the message that came back, by its own header', async () => {
    await fire({ id: 'local', state: 'woken', woke: true });

    expect(mockGetEmailHeaders).toHaveBeenCalledWith('a1', 'INBOX');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith('Ada', 'Back again', undefined, { accountId: 'a1', mailbox: 'INBOX', uid: 5 },
      { accountId: 'a1', folder: 'INBOX', from: 'ada@one.co', domain: 'one.co', viewIds: [] });
    // The row is history, so the list shows the message again.
    expect(useSnoozeStore.getState().rows.map(r => r.id)).toEqual(['server']);
    expect(mockReload).toHaveBeenCalled();
  });

  it('says nothing for an undo, which is no wake', async () => {
    await fire({ id: 'local', state: 'woken', woke: false });

    expect(mockNotify).not.toHaveBeenCalled();
    expect(useSnoozeStore.getState().rows.map(r => r.id)).toEqual(['server']);
  });

  // A server snooze's wake is a real arrival, which the sync already announces.
  it('leaves a server snooze to the sync that reports its arrival', async () => {
    await fire({ id: 'server', state: 'woken', woke: true });

    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockGetEmailHeaders).not.toHaveBeenCalled();
    // The event did land: the row is gone.
    expect(useSnoozeStore.getState().rows.map(r => r.id)).toEqual(['local']);
  });
});
