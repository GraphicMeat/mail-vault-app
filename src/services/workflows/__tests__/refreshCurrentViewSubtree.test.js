// Refresh keeps the visible branch while the native worker chooses mailbox targets.
import { describe, it, expect, beforeEach, vi } from 'vitest';

let state;
let view;
const request = vi.fn(async () => ({ receipt: { status: 'complete' } }));
const observe = vi.fn(async () => {});
const invalidateProbe = vi.fn(async () => ({}));
const invalidateFolder = vi.fn(async () => ({}));
const forceRefetch = vi.fn();
const refreshStatus = vi.fn(async () => {});

vi.mock('../../../stores/mailStore', () => ({ useMailStore: {
  getState: () => state, setState: patch => { state = { ...state, ...patch }; },
} }));
vi.mock('../../../stores/unreadCounts', () => ({ unreadPresentation: vi.fn(async () => ({ total: 0 })) }));
vi.mock('../../nativeSyncContext.js', () => ({
  currentNativeView: () => view, observeNativeView: (...args) => observe(...args),
  requestNativeRefresh: (...args) => request(...args),
}));
vi.mock('../../db/accounts', () => ({ accountExpectedContext: account => ({ id: account.id }) }));
vi.mock('../../cacheManager', () => ({ invalidateRestoreDescriptors: vi.fn() }));
vi.mock('../../syncProbe', () => ({ invalidate: (...args) => invalidateProbe(...args) }));
vi.mock('../helpers/mailboxRefetch', () => ({ forceMailboxRefetch: (...args) => forceRefetch(...args) }));
vi.mock('../folderStatus', () => ({
  invalidateFolderStatus: (...args) => invalidateFolder(...args),
  refreshFolderStatus: (...args) => refreshStatus(...args),
}));
vi.mock('../activateAccount', () => ({ fetchAccountMailboxes: vi.fn(async () => ['Kunden']) }));

const { refreshCurrentView } = await import('../refreshAccounts.js');
beforeEach(() => {
  request.mockClear(); observe.mockClear(); invalidateProbe.mockReset().mockResolvedValue({});
  invalidateFolder.mockReset().mockResolvedValue({}); forceRefetch.mockClear(); refreshStatus.mockClear();
  state = { accounts: [{ id: 'acct-1' }], activeAccountId: 'acct-1', activeMailbox: 'Kunden',
    unifiedInbox: false, mailboxScope: null, loadEmails: vi.fn(async () => {}),
    loadSubtree: vi.fn(async () => {}), activateAccount: vi.fn(async () => {}) };
  view = { accountId: 'acct-1', mailbox: 'Kunden' };
});

describe('refreshCurrentView branch preservation', () => {
  it('re-lists the branch without collapsing scope or passing its root as a provider target', async () => {
    state.mailboxScope = { root: 'Kunden', paths: ['Kunden', 'Kunden.Company XY'] };
    view = { accountId: 'acct-1', mailbox: 'Kunden', scopePaths: state.mailboxScope.paths };
    await refreshCurrentView();
    expect(request).toHaveBeenCalledWith({ accountId: 'acct-1' });
    expect(state.loadSubtree).toHaveBeenCalledWith('acct-1', 'Kunden');
    expect(state.activateAccount).not.toHaveBeenCalled();
    expect(state.mailboxScope).not.toBe(null);
  });

  it('refreshes an ordinary folder through native intent and current list repaint', async () => {
    await refreshCurrentView();
    expect(request).toHaveBeenCalledWith({ accountId: 'acct-1', mailbox: 'Kunden' });
    expect(state.loadEmails).toHaveBeenCalledWith({ rereadFlags: true });
    expect(state.activateAccount).not.toHaveBeenCalled();
  });

  it('waits for both observation invalidations before ordinary repaint', async () => {
    let releaseProbe, releaseFolder;
    invalidateProbe.mockImplementationOnce(() => new Promise(resolve => { releaseProbe = resolve; }));
    invalidateFolder.mockImplementationOnce(() => new Promise(resolve => { releaseFolder = resolve; }));
    const pending = refreshCurrentView();
    await vi.waitFor(() => expect(releaseProbe && releaseFolder).toBeTruthy());
    expect(state.loadEmails).not.toHaveBeenCalled();
    releaseProbe({});
    await Promise.resolve();
    expect(state.loadEmails).not.toHaveBeenCalled();
    releaseFolder({});
    await pending;
    expect(state.loadEmails).toHaveBeenCalledTimes(1);
  });

  it('forces current folder metadata and invalidates the closed-folder sweep once', async () => {
    await refreshCurrentView();
    expect(forceRefetch).toHaveBeenCalledWith('acct-1');
    expect(invalidateFolder).toHaveBeenCalledTimes(1);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
  });
});
