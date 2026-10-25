import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the production store/dependency graph. Only native I/O is replaced.
const native = vi.hoisted(() => ({
  send: vi.fn(async command => {
    if (command === 'get_app_data_dir') return '/test/app-data';
    throw new Error(`Unexpected startup command: ${command}`);
  }),
  daemonCall: vi.fn(),
}));
vi.mock('../../services/transport', () => ({
  send: (...args) => native.send(...args),
  getDaemonHealth: () => ({ alive: true }),
}));
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => native.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));
vi.stubGlobal('window', { __TAURI__: {}, location: { origin: 'tauri://localhost' }, addEventListener() {}, removeEventListener() {} });
vi.stubGlobal('navigator', { onLine: true });

const { useMailStore } = await import('../mailStore');
const { applySeenLocally } = await import('../../services/workflows/messageMutations');
const { useSettingsStore } = await import('../settingsStore');
let views;
let warn;
let persisted;
let completeWrites;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn');
  persisted = new Set();
  completeWrites = [];
  native.send.mockReset().mockImplementation((command, params) => {
    if (command === 'vault_apply_flags') {
      return new Promise(resolve => completeWrites.push(() => {
        for (const change of params.changes) persisted.add(change.uid);
        resolve({ renamed: 1, index_patched: 1, sidecars_patched: 1 });
      }));
    }
    if (command === 'body.verdicts') return Promise.resolve({ rows: {} });
    throw new Error(`Unexpected native command: ${command}`);
  });
  native.daemonCall.mockReset().mockImplementation((method) => {
    if (method === 'views.counts') return Promise.resolve({ unread: 2 - persisted.size });
    if (method === 'views.list') return Promise.resolve([
      { id: 'unread', name: 'Unread', def: { unread: true } },
    ]);
    throw new Error(`Unexpected daemon method: ${method}`);
  });
  useSettingsStore.setState({ hideViewMail: false, hiddenAccounts: {} });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@mock.test' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    mailboxes: [{ path: 'INBOX', name: 'INBOX' }],
    emails: [1, 2].map(uid => ({ uid, flags: [], subject: `Message ${uid}` })),
    localEmails: [], sentEmails: [], sortedEmails: [], selectedEmail: null,
    savedEmailIds: new Set(), archivedEmailIds: new Set(), deleteTombstones: new Set(),
    totalEmails: 2,
  });
});

afterEach(async () => {
  await vi.dynamicImportSettled();
  views?.__resetViewCountsForTests();
  vi.useRealTimers();
  const warnings = warn.mock.calls;
  warn.mockRestore();
  expect(warnings).toEqual([]);
});

const countCalls = () => native.daemonCall.mock.calls.filter(([method]) => method === 'views.counts');

async function proveRecount({ cold }) {
  if (!cold) {
    views = await import('../viewStore');
    views.__resetViewCountsForTests();
    await views.useViewStore.getState().loadViews();
    views.useViewStore.setState({ counts: { unread: 2 } });
  }
  vi.useFakeTimers();
  for (const uid of [1, 2]) {
    applySeenLocally(useMailStore, { accountId: 'acct-1', mailbox: 'INBOX', uid, read: true });
  }
  expect(useMailStore.getState().emails.map(row => row.flags)).toEqual([['\\Seen'], ['\\Seen']]);
  expect(native.send.mock.calls.filter(([command]) => command === 'vault_apply_flags')).toEqual([
    ['vault_apply_flags', { accountId: 'acct-1', mailbox: 'INBOX', accountEmail: 'me@mock.test', changes: [{ uid: 1, flags: ['\\Seen'], on: true }] }],
    ['vault_apply_flags', { accountId: 'acct-1', mailbox: 'INBOX', accountEmail: 'me@mock.test', changes: [{ uid: 2, flags: ['\\Seen'], on: true }] }],
  ]);
  await vi.dynamicImportSettled();
  if (cold) {
    views = await import('../viewStore');
    await views.useViewStore.getState().loadViews();
    views.useViewStore.setState({ counts: { unread: 2 } });
  }
  await vi.advanceTimersByTimeAsync(599);
  expect(countCalls()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(countCalls()).toEqual([
    ['views.counts', { accounts: [{ accountId: 'acct-1', address: 'me@mock.test', knownMailboxes: ['INBOX'], specialUse: {} }] }],
  ]);
  expect(views.useViewStore.getState().counts).toEqual({ unread: 2 });

  // The first count saw the old index. Completing the native writes must
  // request a fresh count, and the two completions must share one timer.
  completeWrites.forEach(complete => complete());
  await vi.dynamicImportSettled();
  expect([...persisted]).toEqual([1, 2]);
  await vi.advanceTimersByTimeAsync(599);
  expect(countCalls()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(countCalls()).toHaveLength(2);
  expect(views.useViewStore.getState().counts).toEqual({ unread: 0 });
  await vi.advanceTimersByTimeAsync(600);
  expect(countCalls()).toHaveLength(2);
}

describe('saved-view initialization and persisted flag recount', () => {
  it('updates badges after cold lazy initialization and native persistence', () => proveRecount({ cold: true }));
  it('updates badges with the application store graph already initialized', () => proveRecount({ cold: false }));
});
