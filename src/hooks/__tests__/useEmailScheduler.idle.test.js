// @vitest-environment jsdom
//
// The app half of IDLE parity: the scheduler registers a watcher per IMAP
// account and then follows the daemon's change feed, repainting only the
// folder that is on screen and telling the user about the rest.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { create } from 'zustand';

// The scheduler reads `window.__TAURI__.core.invoke` at module load — set it
// before the import or notifications and the badge are dead for every test.
const mockInvoke = vi.fn().mockResolvedValue(undefined);
window.__TAURI__ = { core: { invoke: (...a) => mockInvoke(...a) } };

// ── daemon double ───────────────────────────────────────────────────────────
// `sync.events` answers from a scripted queue; once the queue is empty the
// call parks for ever, which is what a real long poll with nothing to say
// does — and what keeps the loop from spinning through the test.
const calls = [];
let eventReplies = [];
const reply = (v) => () => Promise.resolve(v);
const fails = (code) => () => Promise.reject(Object.assign(new Error(code), { code }));
const parked = () => new Promise(() => {});

const mockDaemonCall = vi.fn((method, params) => {
  calls.push([method, params]);
  if (method === 'sync.events') {
    const next = eventReplies.shift();
    return next ? next() : parked();
  }
  return Promise.resolve({});
});
vi.mock('../../services/daemonClient.js', () => ({
  daemonCall: (...a) => mockDaemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));

const mockGetHeaders = vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 });
vi.mock('../../services/db', () => ({
  getEmailHeadersPartial: (...a) => mockGetHeaders(...a),
}));

const mockNotify = vi.fn();
vi.mock('../../stores/focusStore', () => ({ notify: (...a) => mockNotify(...a) }));

vi.mock('../../services/workflows/replayOps', () => ({
  replayOps: vi.fn().mockResolvedValue(undefined),
  wireReplayOnReconnect: vi.fn(),
}));

// ── stores ──────────────────────────────────────────────────────────────────
// One store behind all three facades, exactly as the app composes them.
const mockLoadEmails = vi.fn();
const mailState = () => ({
  accounts: [],
  activeAccountId: null,
  activeMailbox: 'INBOX',
  unifiedInbox: false,
  unifiedFolder: 'INBOX',
  totalUnreadCount: 0,
  emails: [],
  loadEmails: mockLoadEmails,
  refreshAllAccounts: vi.fn().mockResolvedValue({ perAccountResults: [] }),
});
const mailStore = create(() => mailState());
const facade = { useMailStore: Object.assign((s) => mailStore(s), { getState: () => mailStore.getState(), setState: (p) => mailStore.setState(p) }) };
vi.mock('../../stores/mailStore', () => ({ useMailStore: facade.useMailStore }));
vi.mock('../../stores/accountStore', () => ({ useAccountStore: facade.useMailStore }));
vi.mock('../../stores/messageListStore', () => ({ useMessageListStore: facade.useMailStore }));

const settingsState = () => ({
  refreshInterval: 0,
  refreshOnLaunch: false,
  setLastRefreshTime: vi.fn(),
  notificationSettings: { enabled: true, showPreview: true, accounts: {} },
  shouldNotify: () => true,
  badgeEnabled: false,
  badgeMode: 'unread',
  unreadPerAccount: {},
  hiddenAccounts: {},
  billingProfile: null,
});
const settingsStore = create(() => settingsState());
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign((s) => settingsStore(s), { getState: () => settingsStore.getState() }),
  hasPremiumAccess: () => false,
}));

const { useEmailScheduler } = await import('../useEmailScheduler');

const IMAP_A = { id: 'a1', email: 'a@one.co', password: 'pw', imapHost: 'imap.one.co', imapPort: 993 };
const IMAP_B = { id: 'a2', email: 'b@two.co', authType: 'oauth2', oauth2AccessToken: 'tok' };
const GRAPH = { id: 'g1', email: 'g@ms.com', authType: 'oauth2', oauth2AccessToken: 'tok', oauth2Transport: 'graph' };
const NO_CREDS = { id: 'n1', email: 'n@none.co' };

const methods = (name) => calls.filter(c => c[0] === name);
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };

describe('useEmailScheduler — IDLE watchers and the change feed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    eventReplies = [];
    mockDaemonCall.mockClear();
    mockNotify.mockClear();
    mockLoadEmails.mockClear();
    mockGetHeaders.mockReset().mockResolvedValue({ emails: [], totalEmails: 0 });
    mailStore.setState(mailState());
    settingsStore.setState(settingsState());
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('watches every IMAP account that has credentials, and nothing else', async () => {
    mailStore.setState({ accounts: [IMAP_A, IMAP_B, GRAPH, NO_CREDS] });

    renderHook(() => useEmailScheduler());
    await flush();

    expect(methods('sync.watch').map(c => c[1].account.id)).toEqual(['a1', 'a2']);
    // and the daemon gets the sync shape, not the store row
    expect(Object.keys(methods('sync.watch')[0][1].account).sort()).toEqual(['email', 'id', 'imapConfig']);
  });

  it('long-polls from 0, then from the generation it was handed', async () => {
    mailStore.setState({ accounts: [IMAP_A] });
    eventReplies = [reply({ gen: 5, changes: [] })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(methods('sync.events').map(c => c[1].since)).toEqual([0, 5]);
    expect(methods('sync.events')[0][1].timeoutMs).toBe(25000);
  });

  // The daemon's counter restarts at 0 when the daemon does, and it answers a
  // cursor from the future at once with where it actually is. Clamping with
  // Math.max would park the app on a generation that will never come back.
  it('adopts a generation lower than the cursor it sent', async () => {
    mailStore.setState({ accounts: [IMAP_A] });
    eventReplies = [reply({ gen: 900, changes: [] }), reply({ gen: 3, changes: [] })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(methods('sync.events').map(c => c[1].since)).toEqual([0, 900, 3]);
  });

  it('repaints the open folder and tells the user about the new mail', async () => {
    mailStore.setState({ accounts: [IMAP_A], activeAccountId: 'a1', activeMailbox: 'INBOX' });
    mockGetHeaders.mockResolvedValue({ emails: [{ from: { name: 'Ada' }, subject: 'Difference engine' }] });
    eventReplies = [reply({ gen: 1, changes: [{ gen: 1, accountId: 'a1', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 }] })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(mockLoadEmails).toHaveBeenCalledTimes(1);
    expect(mockGetHeaders).toHaveBeenCalledWith('a1', 'INBOX', 1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith('Ada', 'Difference engine');
  });

  it('notifies for an account that is not on screen without repainting the list', async () => {
    mailStore.setState({ accounts: [IMAP_A, IMAP_B], activeAccountId: 'a1', activeMailbox: 'INBOX' });
    mockGetHeaders.mockResolvedValue({ emails: [{ from: { address: 'b@two.co' }, subject: 'Elsewhere' }] });
    eventReplies = [reply({ gen: 1, changes: [{ gen: 1, accountId: 'a2', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 }] })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(mockLoadEmails).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith('b@two.co', 'Elsewhere');
  });

  it('attaches the selected sound to incoming mail', async () => {
    settingsStore.setState({ notificationSettings: { ...settingsState().notificationSettings, sound: 'Ping' } });
    mailStore.setState({ accounts: [IMAP_A] });
    mockGetHeaders.mockResolvedValue({ emails: [{ from: { name: 'Ada' }, subject: 'Hello' }] });
    eventReplies = [reply({ gen: 1, changes: [{ gen: 1, accountId: 'a1', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 }] })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(mockNotify).toHaveBeenCalledWith('Ada', 'Hello', 'Ping');
  });

  it('does not send a sound or banner for a muted folder', async () => {
    settingsStore.setState({
      notificationSettings: { ...settingsState().notificationSettings, sound: 'Ping' },
      shouldNotify: () => false,
    });
    mailStore.setState({ accounts: [IMAP_A] });
    eventReplies = [reply({ gen: 1, changes: [{ gen: 1, accountId: 'a1', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 }] })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  // Flag-only changes on a folder nobody is looking at are silent.
  it('says nothing when a change carries no new mail', async () => {
    mailStore.setState({ accounts: [IMAP_A], activeAccountId: 'a1', activeMailbox: 'INBOX' });
    eventReplies = [reply({ gen: 1, changes: [{ gen: 1, accountId: 'a1', mailbox: 'Archive', newEmails: 0, updatedFlags: 4, at: 1 }] })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockLoadEmails).not.toHaveBeenCalled();
    // and the change was actually consumed — otherwise this asserts nothing
    expect(methods('sync.events').map(c => c[1].since)).toEqual([0, 1]);
  });

  it('pauses 30s when the daemon is offline, then polls again', async () => {
    mailStore.setState({ accounts: [IMAP_A] });
    eventReplies = [fails('DAEMON_OFFLINE')];

    renderHook(() => useEmailScheduler());
    await flush();
    expect(methods('sync.events')).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(29000); });
    expect(methods('sync.events')).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(methods('sync.events')).toHaveLength(2);
  });

  // The web build has no daemon and never will within a session: a retry loop
  // there is a spin, not a recovery.
  it('stops for good when there is no Tauri to reach a daemon through', async () => {
    mailStore.setState({ accounts: [IMAP_A] });
    eventReplies = [fails('NO_TAURI')];

    renderHook(() => useEmailScheduler());
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });

    expect(methods('sync.events')).toHaveLength(1);
  });

  it('stops on unmount, even when the parked poll answers afterwards', async () => {
    mailStore.setState({ accounts: [IMAP_A], activeAccountId: 'a1', activeMailbox: 'INBOX' });
    let land;
    eventReplies = [() => new Promise(r => { land = r; })];

    const { unmount } = renderHook(() => useEmailScheduler());
    await flush();
    expect(methods('sync.events')).toHaveLength(1);

    unmount();
    land({ gen: 1, changes: [{ gen: 1, accountId: 'a1', mailbox: 'INBOX', newEmails: 2, updatedFlags: 0, at: 1 }] });
    await flush();

    expect(methods('sync.events')).toHaveLength(1);
    expect(mockLoadEmails).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  // A token that was just refreshed has to reach the daemon, or the watcher
  // it holds keeps failing to authenticate until the next mount.
  it('re-registers the watchers on a manual refresh', async () => {
    mailStore.setState({ accounts: [IMAP_A] });

    const { result } = renderHook(() => useEmailScheduler());
    await flush();
    expect(methods('sync.watch')).toHaveLength(1);

    await act(async () => { await result.current.doRefresh(); });

    expect(methods('sync.watch')).toHaveLength(2);
  });

  // A folder-subtree view (mailboxScope) lists every folder under its root;
  // spansMailboxes(state) already treats a mailboxScope the same as UNIFIED,
  // but the change-feed predicate did not, so a change to a folder under the
  // open branch (not the root itself) drew no repaint.
  it('repaints a subtree view for a change under the scope root', async () => {
    mailStore.setState({
      accounts: [IMAP_A],
      activeAccountId: 'a1',
      activeMailbox: 'Projects',
      mailboxScope: { root: 'Projects', paths: ['Projects', 'Projects/Alpha'] },
    });
    eventReplies = [reply({ gen: 1, changes: [{ gen: 1, accountId: 'a1', mailbox: 'Projects/Alpha', newEmails: 0, updatedFlags: 3, at: 1 }] })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(mockLoadEmails).toHaveBeenCalledTimes(1);
  });

  it('does not repaint a subtree view for a folder outside the scope', async () => {
    mailStore.setState({
      accounts: [IMAP_A],
      activeAccountId: 'a1',
      activeMailbox: 'Projects',
      mailboxScope: { root: 'Projects', paths: ['Projects', 'Projects/Alpha'] },
    });
    eventReplies = [reply({ gen: 1, changes: [{ gen: 1, accountId: 'a1', mailbox: 'Archive', newEmails: 0, updatedFlags: 3, at: 1 }] })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(mockLoadEmails).not.toHaveBeenCalled();
  });

  // `stopped` was checked before the for-of loop over a reply's changes, but
  // not between iterations — each iteration awaits db.getEmailHeadersPartial,
  // so an unmount between change 1 and change 2 still let change 2 fire.
  it('stops between changes in the same reply on unmount', async () => {
    mailStore.setState({ accounts: [IMAP_A], activeAccountId: 'a1', activeMailbox: 'INBOX' });
    let land;
    mockGetHeaders.mockImplementation(() => new Promise(r => { land = r; }));
    eventReplies = [reply({
      gen: 1,
      changes: [
        { gen: 1, accountId: 'a1', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 },
        { gen: 1, accountId: 'a1', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 },
      ],
    })];

    const { unmount } = renderHook(() => useEmailScheduler());
    await flush();

    // The first change's onSyncChange is parked awaiting getEmailHeadersPartial.
    unmount();
    land({ emails: [{ from: { name: 'Ada' }, subject: 'One' }] });
    await flush();

    expect(mockNotify.mock.calls.length).toBeLessThanOrEqual(1);
    expect(mockLoadEmails.mock.calls.length).toBeLessThanOrEqual(1);
  });

  // `loadEmails()` takes no arguments and always reloads the view that is
  // open, so a reply naming two on-screen folders is still one list to
  // repaint. Deduping by (account, mailbox) deduped the keys and not the work.
  it('reloads once for a reply that names two on-screen folders', async () => {
    mailStore.setState({
      accounts: [IMAP_A, IMAP_B],
      activeAccountId: 'a1',
      activeMailbox: 'INBOX',
      unifiedInbox: true,
      unifiedFolder: 'INBOX',
    });
    mockGetHeaders.mockResolvedValue({ emails: [{ from: { name: 'Ada' }, subject: 'Two folders' }] });
    eventReplies = [reply({
      gen: 1,
      changes: [
        { gen: 1, accountId: 'a1', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 },
        { gen: 1, accountId: 'a2', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 },
      ],
    })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(mockLoadEmails).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });

  // One reload per reply, even when the reply names one folder twice —
  // notifications still fire once per change.
  it('reloads once per distinct on-screen folder even when a reply names it twice', async () => {
    mailStore.setState({ accounts: [IMAP_A], activeAccountId: 'a1', activeMailbox: 'INBOX' });
    mockGetHeaders.mockResolvedValue({ emails: [{ from: { name: 'Ada' }, subject: 'Difference engine' }] });
    eventReplies = [reply({
      gen: 1,
      changes: [
        { gen: 1, accountId: 'a1', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 },
        { gen: 1, accountId: 'a1', mailbox: 'INBOX', newEmails: 1, updatedFlags: 0, at: 1 },
      ],
    })];

    renderHook(() => useEmailScheduler());
    await flush();

    expect(mockLoadEmails).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });
});
