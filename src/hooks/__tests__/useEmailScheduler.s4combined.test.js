// @vitest-environment jsdom
// Conditional S4 old-JS combined caller capture. Stage after accepted S3 only.
// Production scheduler, codeBubble, Focus and bubble stores run unchanged;
// provider, native policy, daemon feed, OS and local persistence are inputs.
import { it, expect, vi } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { create } from 'zustand';
import { writeFileSync } from 'node:fs';

const T0 = 1_700_000_000_000;
const memory = {};
vi.mock('../../stores/safeStorage', () => ({ safeStorage: {
  getItem: key => memory[key] ?? null,
  setItem: (key, value) => { memory[key] = value; },
  removeItem: key => { delete memory[key]; },
}, flushSafeStorage: vi.fn().mockResolvedValue(undefined) }));
const mockOS = vi.fn().mockResolvedValue(undefined);
const mockPolicy = vi.fn().mockResolvedValue({ deliver: true, reason: 'delivered-default' });
const mockCode = vi.fn().mockResolvedValue({ code: null, needsBody: false });
const mockLight = vi.fn().mockResolvedValue({ text: 'Your code is 775421' });
const mockGraph = vi.fn();
vi.mock('../../services/api', () => ({
  sendNotification: (...args) => mockOS(...args),
  notifyDecision: (...args) => mockPolicy(...args),
  messageCode: (...args) => mockCode(...args),
  fetchEmailLight: (...args) => mockLight(...args),
  graphGetMessage: (...args) => mockGraph(...args),
}));
const mockGetPartial = vi.fn().mockResolvedValue({ emails: [] });
const mockGetHeaders = vi.fn().mockResolvedValue({ emails: [] });
vi.mock('../../services/db', () => ({
  getEmailHeadersPartial: (...args) => mockGetPartial(...args),
  getEmailHeaders: (...args) => mockGetHeaders(...args),
}));
const mockDaemon = vi.fn(async method => method === 'snooze.list' ? [] : {});
vi.mock('../../services/daemonClient', () => ({ daemonCall: (...args) => mockDaemon(...args) }));
const mockInvalidateRestore = vi.fn();
vi.mock('../../services/cacheManager', () => ({
  invalidateRestoreDescriptors: (...args) => mockInvalidateRestore(...args),
  getGraphMessageId: () => null,
}));
vi.mock('../../services/db/accounts', () => ({ accountExpectedContext: account => ({
  id: account?.id, email: account?.email, imapHost: account?.imapHost,
}) }));
let eventReplies = [];
const parked = () => new Promise(() => {});
const mockWatch = vi.fn().mockResolvedValue(null);
const mockPoll = vi.fn(() => eventReplies.length ? Promise.resolve(eventReplies.shift()) : parked());
vi.mock('../../services/syncService', () => ({
  watchAccount: (...args) => mockWatch(...args),
  waitForSyncChanges: (...args) => mockPoll(...args),
}));
vi.mock('../../services/authUtils', () => ({ hasValidCredentials: () => false }));
vi.mock('../../services/searchIndex', () => ({ onDaemonReconnected: () => Promise.resolve(() => {}) }));
vi.mock('../../services/workflows/replayOps', () => ({
  replayOps: vi.fn().mockResolvedValue(undefined), wireReplayOnReconnect: vi.fn(),
}));
const mockViewRefresh = vi.fn();
vi.mock('../../stores/viewStore', () => ({ scheduleViewCountsRefresh: (...args) => mockViewRefresh(...args) }));
const mockNoteReload = vi.fn();
vi.mock('../../stores/notesStore', () => ({
  scheduleNotesReload: (...args) => mockNoteReload(...args),
  useNotesStore: { getState: () => ({ rereadCopyFlags: vi.fn() }) },
}));
const mockRecount = vi.fn().mockResolvedValue(true);
vi.mock('../../stores/unreadCounts', () => ({
  recountNativeInbox: (...args) => mockRecount(...args),
  unreadPresentation: () => Promise.resolve({ rows: [], total: 0 }),
}));
vi.mock('../../services/unreadCountsClient', () => ({ invalidateUnreadConnection: vi.fn() }));
const viewHideStore = create(() => ({ keys: null }));
vi.mock('../../stores/viewHideStore', () => ({ useViewHideStore: viewHideStore }));
const mockLoadEmails = vi.fn().mockResolvedValue(undefined);
const mockLoadUnified = vi.fn().mockResolvedValue(undefined);
const mailState = () => ({ accounts: [], activeAccountId: 'a1', activeMailbox: 'INBOX',
  unifiedInbox: false, unifiedFolder: 'INBOX', emails: [], totalEmails: 0,
  loadEmails: mockLoadEmails, loadUnifiedInbox: mockLoadUnified,
  refreshAllAccounts: vi.fn().mockResolvedValue({ perAccountResults: [] }),
});
const mailStore = create(() => mailState());
const mailFacade = Object.assign((selector) => mailStore(selector), {
  getState: () => mailStore.getState(), setState: (...args) => mailStore.setState(...args),
  subscribe: (...args) => mailStore.subscribe(...args),
});
vi.mock('../../stores/mailStore', () => ({ useMailStore: mailFacade }));
vi.mock('../../stores/accountStore', () => ({ useAccountStore: mailFacade }));
vi.mock('../../stores/messageListStore', () => ({ useMessageListStore: mailFacade }));
const settingsState = () => ({ refreshInterval: 0, refreshOnLaunch: false,
  setLastRefreshTime: vi.fn(), notificationSettings: { enabled: true, showPreview: true, sound: 'none', accounts: {} },
  badgeEnabled: false, badgeMode: 'unread', unreadPerAccount: {}, hiddenAccounts: {},
  displayNames: {}, accountOrder: [], sendAsAddresses: {}, aliases: {}, billingProfile: null,
});
const settingsStore = create(() => settingsState());
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign((selector) => settingsStore(selector), {
    getState: () => settingsStore.getState(), setState: (...args) => settingsStore.setState(...args),
    subscribe: (...args) => settingsStore.subscribe(...args),
  }),
  hasPremiumAccess: () => false,
  selectOwnAddresses: (state, account) => ownAddresses({ account,
    sendAsAddress: state?.sendAsAddresses?.[account?.id], aliases: state?.aliases?.[account?.id] }),
}));
let snoozeListener = null;
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name, callback) => {
  if (name === 'snooze') snoozeListener = callback;
  return () => { if (snoozeListener === callback) snoozeListener = null; };
} }));
const mockReload = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/workflows/messageMutations', () => ({
  reloadListInView: (...args) => mockReload(...args), applySeenLocally: vi.fn(),
}));
window.__TAURI__ = { core: { invoke: vi.fn().mockResolvedValue(undefined) } };
const { ownAddresses } = await import('../../utils/ownAddresses.js');
const { useEmailScheduler, notifyArrival } = await import('../useEmailScheduler.js');
const { useFocusStore, getNotificationDecisions, clearNotificationDecisions } = await import('../../stores/focusStore.js');
const { usePrivacyStore } = await import('../../stores/privacyStore.js');
const { useCodeBubbleStore } = await import('../../stores/codeBubbleStore.js');
const { useSnoozeStore, initSnooze } = await import('../../stores/snoozeStore.js');

const account = { id: 'a1', email: 'a@one.co', imapHost: 'imap.one.co', imapPort: 993 };
const outside = { uid: 42, subject: 'Sign in to Acme', from: { name: 'Sender', address: 'outside.test@example.org' } };
const encode = value => value === undefined ? { $undefined: true }
  : Array.isArray(value) ? value.map(encode)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
    : value;
const effects = () => encode({ at: Date.now() - T0, os: mockOS.mock.calls,
  policy: mockPolicy.mock.calls, decisions: getNotificationDecisions(),
  held: useFocusStore.getState().held, bubbles: useCodeBubbleStore.getState().bubbles,
  codeCalls: mockCode.mock.calls, bodyCalls: mockLight.mock.calls,
  headerCalls: mockGetPartial.mock.calls, pollCalls: mockPoll.mock.calls });
const micro = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const tick = async (ms = 1) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await micro(); };
const reset = async () => {
  cleanup();
  useFocusStore.getState().abandon();
  useFocusStore.setState({ held: [] });
  useCodeBubbleStore.getState().clear();
  usePrivacyStore.setState({ enabled: false });
  vi.clearAllTimers();
  vi.setSystemTime(T0);
  clearNotificationDecisions();
  mockOS.mockClear().mockResolvedValue(undefined);
  mockPolicy.mockReset().mockResolvedValue({ deliver: true, reason: 'delivered-default' });
  mockCode.mockReset().mockResolvedValue({ code: null, needsBody: false });
  mockLight.mockReset().mockResolvedValue({ text: 'Your code is 775421' });
  mockGetPartial.mockReset().mockResolvedValue({ emails: [outside], totalEmails: 1 });
  mockGetHeaders.mockReset().mockResolvedValue({ emails: [outside], totalEmails: 1 });
  mockPoll.mockClear(); mockWatch.mockClear(); mockRecount.mockClear();
  mockViewRefresh.mockClear(); mockNoteReload.mockClear();
  mockLoadEmails.mockClear(); mockLoadUnified.mockClear();
  eventReplies = [];
  mailStore.setState({ ...mailState(), accounts: [account] }, true);
  settingsStore.setState(settingsState(), true);
  await micro();
};
const feed = async (count, header = outside) => {
  mockGetPartial.mockResolvedValue({ emails: [header], totalEmails: count });
  eventReplies = [{ gen: 1, changes: [{ gen: 1, accountId: 'a1', mailbox: 'INBOX',
    newEmails: count, updatedFlags: 0, at: 1 }] }];
  renderHook(() => useEmailScheduler());
  await tick();
};

it.skipIf(!process.env.W4S4_ORACLE_COMBINED_OUT)('captures N15-N17 and C12-C16 through real old scheduler, Focus and code stores', async () => {
  const output = process.env.W4S4_ORACLE_COMBINED_OUT;
  if (!output) throw new Error('W4S4_ORACLE_COMBINED_OUT is required');
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const hydration = vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
  const cases = [];
  try {
    await reset();
    const n15 = [];
    for (const uids of [[42, 42, 43], [43, 44], [42]]) {
      notifyArrival('a1', 'INBOX', uids.length, outside, null, { uids });
      await micro();
      n15.push({ input: { uids }, output: effects() });
    }
    cases.push({ id: 'N15', samples: n15 });

    const n16 = [];
    for (const sample of [
      { mode: 'hidden-account', decision: { deliver: true, reason: 'delivered-default' } },
      { mode: 'account-muted', decision: { deliver: false, reason: 'account-muted' } },
      { mode: 'quiet-hours', decision: { deliver: false, reason: 'quiet-hours' } },
      { mode: 'allowlist', decision: { deliver: true, reason: 'priority-allowlist' } },
      { mode: 'master-off', decision: { deliver: false, reason: 'notifications-off' } },
    ]) {
      await reset();
      settingsStore.setState({ hiddenAccounts: sample.mode === 'hidden-account' ? { a1: true } : {},
        notificationSettings: { enabled: sample.mode !== 'master-off', showPreview: true, sound: 'none', accounts: {} } });
      mockPolicy.mockResolvedValue(sample.decision);
      notifyArrival('a1', 'INBOX', 1, outside, null, { uids: [42] });
      await micro();
      n16.push({ input: sample, output: effects() });
    }
    cases.push({ id: 'N16', samples: n16 });

    await reset();
    useFocusStore.getState().start(25);
    mockPolicy.mockResolvedValue({ deliver: false, reason: 'focus-hold' });
    notifyArrival('a1', 'INBOX', 1, outside, null, { uids: [42] });
    await micro();
    const held = effects();
    useFocusStore.getState().abandon();
    await micro();
    cases.push({ id: 'N17', input: { focus: true, code: null }, output: { held, flushed: effects() } });

    await reset();
    let releaseBody;
    mockCode.mockResolvedValueOnce({ code: null, needsBody: true })
      .mockResolvedValueOnce({ code: '775421', needsBody: false });
    mockLight.mockReturnValueOnce(new Promise(done => { releaseBody = done; }));
    await feed(1);
    for (let n = 0; n < 30 && !releaseBody; n++) await micro();
    expect(releaseBody).toBeTypeOf('function');
    const c12Before = effects();
    await tick(3_000);
    const c12Deadline = effects();
    expect(releaseBody).toBeTypeOf('function');
    releaseBody({ text: 'Your code is 775421' });
    await tick();
    cases.push({ id: 'C12', input: { count: 1, bodyReleaseAfterMs: 3000 },
      output: { beforeDeadline: c12Before, atDeadline: c12Deadline, afterBody: effects() } });

    await reset();
    mockCode.mockResolvedValueOnce({ code: null, needsBody: true })
      .mockResolvedValueOnce({ code: '775421', needsBody: false });
    mockLight.mockReturnValueOnce(new Promise(done => { releaseBody = done; }));
    await feed(2);
    for (let n = 0; n < 30 && !releaseBody; n++) await micro();
    expect(releaseBody).toBeTypeOf('function');
    const c13Immediate = effects();
    expect(releaseBody).toBeTypeOf('function');
    releaseBody({ text: 'Your code is 775421' });
    await tick();
    cases.push({ id: 'C13', input: { count: 2, heldBody: true },
      output: { beforeBody: c13Immediate, afterBody: effects() } });

    await reset();
    mockPolicy.mockResolvedValue({ deliver: false, reason: 'account-muted' });
    mockCode.mockResolvedValueOnce({ code: '775421', needsBody: false });
    await feed(1);
    cases.push({ id: 'C14', input: { policyReply: { deliver: false, reason: 'account-muted' } }, output: effects() });

    await reset();
    const own = { ...outside, from: { name: 'Me', address: 'a@one.co' } };
    mockCode.mockResolvedValueOnce({ code: '775421', needsBody: false });
    await feed(1, own);
    cases.push({ id: 'C15', input: { ownFrom: own.from.address }, output: effects() });

    await reset();
    settingsStore.setState({ notificationSettings: { enabled: true, showPreview: false, sound: 'none', accounts: {} } });
    mockCode.mockResolvedValueOnce({ code: '775421', needsBody: false });
    await feed(1);
    const previewOff = effects();
    await reset();
    initSnooze();
    await tick();
    for (let n = 0; n < 30 && !snoozeListener; n++) await micro();
    const wakeRow = { id: 'wake-1', accountId: 'a1', fromMailbox: 'INBOX',
      snoozedMailbox: '', messageId: '<wake@example.org>', state: 'snoozed', uidInSnoozed: 5 };
    useSnoozeStore.setState({ rows: [wakeRow] });
    mockGetHeaders.mockResolvedValue({ emails: [{ ...outside, uid: 7, messageId: 'wake@example.org' }] });
    const beforeWake = effects();
    expect(snoozeListener).toBeTypeOf('function');
    await act(async () => { await snoozeListener({ payload: { id: 'wake-1', state: 'woken', woke: true } }); });
    await micro();
    cases.push({ id: 'C16', input: { previewOff: true, localWake: true },
      output: { previewOff, beforeWake, afterWake: effects() } });
    expect(cases.map(c => c.id)).toEqual(['N15','N16','N17','C12','C13','C14','C15','C16']);
    writeFileSync(output, JSON.stringify({ kind: 's4-legacy-combined-arrival', cases: encode(cases) }, null, 2) + '\n');
  } finally {
    cleanup();
    useFocusStore.getState().abandon();
    useCodeBubbleStore.getState().clear();
    hydration.mockRestore();
    vi.useRealTimers();
  }
});
