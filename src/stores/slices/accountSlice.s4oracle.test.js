// Conditional S4 old-JS capture. Stage beside accountSlice.js only after S3 is accepted.
// Captures the real manual gesture throttle, spinner, and trailing call boundary.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';

const mockRefreshCurrentView = vi.fn();
vi.mock('../../services/workflows/activateAccount', () => ({ activateAccount: vi.fn(), init: vi.fn(), setActiveAccount: vi.fn() }));
vi.mock('../../services/workflows/loadSubtree', () => ({ loadSubtree: vi.fn() }));
vi.mock('../../services/transport.js', () => ({ send: vi.fn() }));
vi.mock('../../services/workflows/prefetch', () => ({ _prefetchAllMailboxes: vi.fn(), _prewarmAccountCaches: vi.fn() }));
vi.mock('../../services/workflows/addAccount', () => ({ addAccount: vi.fn() }));
vi.mock('../../services/workflows/updateAccount', () => ({ updateAccount: vi.fn() }));
vi.mock('../../services/workflows/changeServer', () => ({ changeServer: vi.fn() }));
vi.mock('../../services/workflows/removeAccount', () => ({ removeAccount: vi.fn() }));
vi.mock('../../services/workflows/refreshAccounts', () => ({ refreshCurrentView: (...args) => mockRefreshCurrentView(...args), refreshAllAccounts: vi.fn() }));
vi.mock('../../services/workflows/retryKeychainAccess', () => ({ retryKeychainAccess: vi.fn() }));
vi.mock('../../services/workflows/folderOps', () => ({ createFolder: vi.fn(), renameFolder: vi.fn(), deleteFolder: vi.fn(), deleteLocalFolder: vi.fn() }));
vi.mock('../../services/workflows/loadUnifiedInbox', () => ({ setUnifiedInbox: vi.fn(), switchUnifiedFolder: vi.fn(), loadUnifiedInbox: vi.fn() }));
vi.mock('../../services/workflows/messageMutations', () => ({
  saveEmailLocally: vi.fn(), saveEmailsLocally: vi.fn(), saveSelectedLocally: vi.fn(),
  removeLocalEmail: vi.fn(), removeLocalEmails: vi.fn(), deleteEmailFromServer: vi.fn(),
  markEmailReadStatus: vi.fn(), exportEmail: vi.fn(),
}));

const BASE_MS = 1_000_000;
const captured = [];
let state;
let actions;
let invocations;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const snapshot = (label) => ({ label, elapsedMs: Date.now() - BASE_MS,
  spinner: state.manualRefreshSpinning, currentMailbox: state.activeMailbox,
  calls: invocations.map(x => ({ ...x })) });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_MS);
  vi.resetModules();
  invocations = [];
  mockRefreshCurrentView.mockReset().mockImplementation(() => {
    invocations.push({ elapsedMs: Date.now() - BASE_MS, mailbox: state.activeMailbox });
    return Promise.resolve();
  });
  const { createAccountSlice } = await import('./accountSlice');
  const set = patch => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const get = () => state;
  state = { ...createAccountSlice(set, get), activeAccountId: 'acct-1', activeMailbox: 'INBOX' };
  actions = state;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
afterAll(() => {
  if (process.env.W4S4_ORACLE_T_OUT) {
    writeFileSync(process.env.W4S4_ORACLE_T_OUT, JSON.stringify({ cases: captured }, null, 2));
  }
});

describe('conditional S4 old manual refresh input oracle', () => {
  it.skipIf(!process.env.W4S4_ORACLE_T_OUT)('T01 rapid current-view clicks while idle', async () => {
    const samples = [];
    actions.refreshCurrentView();
    actions.refreshCurrentView();
    actions.refreshCurrentView();
    samples.push(snapshot('three-clicks'));
    await flush();
    samples.push(snapshot('first-complete'));
    await vi.advanceTimersByTimeAsync(600);
    samples.push(snapshot('spinner-deadline'));
    await vi.advanceTimersByTimeAsync(14_400);
    samples.push(snapshot('trailing-deadline'));
    expect(invocations.length).toBe(1);
    captured.push({ id: 'T01', samples });
  });

  it.skipIf(!process.env.W4S4_ORACLE_T_OUT)('T02 in-flight clicks lose queued refresh at cooldown timer', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    mockRefreshCurrentView.mockImplementationOnce(() => {
      invocations.push({ elapsedMs: Date.now() - BASE_MS, mailbox: state.activeMailbox });
      return held;
    });
    const samples = [];
    actions.refreshCurrentView();
    actions.refreshCurrentView();
    await vi.advanceTimersByTimeAsync(5_000);
    actions.refreshCurrentView();
    samples.push(snapshot('held-after-clicks'));
    release();
    await flush();
    samples.push(snapshot('released'));
    await vi.advanceTimersByTimeAsync(9_999);
    samples.push(snapshot('before-trailing'));
    await vi.advanceTimersByTimeAsync(1);
    samples.push(snapshot('trailing'));
    expect(invocations.length).toBe(1);
    captured.push({ id: 'T02', samples });
  });

  it.skipIf(!process.env.W4S4_ORACLE_T_OUT)('T03 spinner timing and latest view at trailing execution', async () => {
    const samples = [];
    actions.refreshCurrentView();
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    actions.refreshCurrentView();
    samples.push(snapshot('second-click'));
    state.activeMailbox = 'Archive';
    await vi.advanceTimersByTimeAsync(100);
    samples.push(snapshot('first-spinner-deadline'));
    await vi.advanceTimersByTimeAsync(500);
    samples.push(snapshot('second-spinner-deadline'));
    await vi.advanceTimersByTimeAsync(13_900);
    samples.push(snapshot('trailing-new-view'));
    expect(invocations.map(x => x.mailbox)).toEqual(['INBOX', 'Archive']);
    captured.push({ id: 'T03', samples });
  });
});

// Expected-new S4-T regression, kept separate from the immutable old-JS
// T01/T02 capture above. The legacy in-flight completion drops this intent.
it('W4S4 manual in-flight click runs one trailing refresh on the latest view', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  mockRefreshCurrentView.mockImplementationOnce(() => {
    invocations.push({ elapsedMs: Date.now() - BASE_MS, mailbox: state.activeMailbox });
    return held;
  });
  actions.refreshCurrentView();
  actions.refreshCurrentView();
  state.activeMailbox = 'Archive';
  release();
  await flush();
  await vi.advanceTimersByTimeAsync(14_999);
  expect(invocations.map(call => call.mailbox)).toEqual(['INBOX']);
  await vi.advanceTimersByTimeAsync(1);
  expect(invocations.map(call => call.mailbox),
    'W4S4_T_TRAILING_RED: in-flight gesture must survive cooldown and use the latest view')
    .toEqual(['INBOX', 'Archive']);
});
