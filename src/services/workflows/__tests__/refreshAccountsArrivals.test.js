import { describe, it, expect, vi, beforeEach } from 'vitest';

const A = { id: 'a', email: 'a@test' };
const B = { id: 'b', email: 'b@test' };
let state;
let nativeView;
const nativeRequest = vi.fn();
const observe = vi.fn(async () => {});
const invalidateProbe = vi.fn(async () => ({}));
const invalidateFolder = vi.fn(async () => {});
const forceMailbox = vi.fn();
const invalidateRestore = vi.fn();
const fetchMailboxes = vi.fn(async () => ['INBOX', 'Archive']);
const refreshStatus = vi.fn(async () => {});
const oldProviderPages = vi.fn();

vi.mock('../../../stores/mailStore', () => ({ useMailStore: {
  getState: () => state,
  setState: patch => { state = { ...state, ...patch }; },
} }));
vi.mock('../../../stores/unreadCounts', () => ({ unreadPresentation: vi.fn(async () => ({ total: 4 })) }));
vi.mock('../../nativeSyncContext.js', () => ({
  requestNativeRefresh: (...args) => nativeRequest(...args),
  observeNativeView: (...args) => observe(...args),
  currentNativeView: () => nativeView,
}));
vi.mock('../../cacheManager', () => ({ invalidateRestoreDescriptors: (...args) => invalidateRestore(...args) }));
vi.mock('../../syncProbe', () => ({ invalidate: (...args) => invalidateProbe(...args) }));
vi.mock('../helpers/mailboxRefetch', () => ({ forceMailboxRefetch: (...args) => forceMailbox(...args) }));
vi.mock('../folderStatus', () => ({
  invalidateFolderStatus: (...args) => invalidateFolder(...args),
  refreshFolderStatus: (...args) => refreshStatus(...args),
}));
vi.mock('../activateAccount', () => ({ fetchAccountMailboxes: (...args) => fetchMailboxes(...args) }));
vi.mock('../../db/accounts', () => ({ accountExpectedContext: account => ({ id: account.id, email: account.email }) }));
vi.mock('../../api', () => ({ fetchEmails: (...args) => oldProviderPages(...args) }));

const { refreshCurrentView, refreshAllAccounts } = await import('../refreshAccounts.js');
const loadEmails = vi.fn(async () => {});
const loadUnifiedInbox = vi.fn(async () => {});
const loadSubtree = vi.fn(async () => {});

beforeEach(() => {
  state = { accounts: [A, B], activeAccountId: 'a', activeMailbox: 'INBOX',
    unifiedInbox: false, unifiedFolder: 'INBOX', mailboxScope: null,
    loadEmails, loadUnifiedInbox, loadSubtree, connectionStatus: 'error' };
  nativeView = { accountId: 'a', mailbox: 'INBOX' };
  nativeRequest.mockReset().mockResolvedValue({ receipt: { status: 'complete' }, uncertain: false });
  observe.mockClear(); invalidateProbe.mockReset().mockResolvedValue({});
  invalidateFolder.mockReset().mockResolvedValue(undefined);
  forceMailbox.mockClear(); invalidateRestore.mockClear();
  fetchMailboxes.mockReset().mockResolvedValue(['INBOX', 'Archive']);
  refreshStatus.mockReset().mockResolvedValue(undefined);
  oldProviderPages.mockClear(); loadEmails.mockClear(); loadUnifiedInbox.mockClear(); loadSubtree.mockClear();
});

describe('S4 native refresh intent and current-view repaint', () => {
  it('invalidates the ordinary probe/folder before repaint and sends only a native intent', async () => {
    let release;
    invalidateProbe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = refreshCurrentView();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(loadEmails).not.toHaveBeenCalled();
    release({});
    await pending;
    expect(nativeRequest).toHaveBeenCalledWith({ accountId: 'a', mailbox: 'INBOX' });
    expect(invalidateProbe).toHaveBeenCalledWith('a', 'INBOX');
    expect(invalidateFolder).toHaveBeenCalledWith('a');
    expect(forceMailbox).toHaveBeenCalledWith('a');
    expect(loadEmails).toHaveBeenCalledWith({ rereadFlags: true });
    expect(oldProviderPages).not.toHaveBeenCalled();
  });

  it('keeps the mailbox omitted for a unified view and repaints its actual folder', async () => {
    state = { ...state, activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'Archive' };
    nativeView = { accountId: null, mailbox: 'UNIFIED', unifiedFolder: 'Archive' };
    await refreshCurrentView();
    expect(nativeRequest).toHaveBeenCalledWith({});
    expect(loadUnifiedInbox).toHaveBeenCalledWith(null, 'Archive');
    expect(fetchMailboxes).not.toHaveBeenCalled();
    expect(oldProviderPages).not.toHaveBeenCalled();
  });

  it('sends subtree context without projecting its root into the native mailbox intent', async () => {
    state = { ...state, activeMailbox: 'Projects', mailboxScope: {
      root: 'Projects', paths: ['Projects', 'Projects/A'],
    } };
    nativeView = { accountId: 'a', mailbox: 'Projects', scopePaths: ['Projects', 'Projects/A'] };
    await refreshCurrentView();
    expect(nativeRequest).toHaveBeenCalledWith({ accountId: 'a' });
    expect(loadSubtree).toHaveBeenCalledWith('a', 'Projects');
    expect(fetchMailboxes).not.toHaveBeenCalled();
  });

  it('repaints the view that is current when a held native receipt finishes', async () => {
    let finish;
    nativeRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = refreshCurrentView();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    state = { ...state, activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'Archive' };
    finish({ receipt: { status: 'complete' }, uncertain: false });
    await pending;
    expect(loadUnifiedInbox).toHaveBeenCalledWith(null, 'Archive');
    expect(loadEmails).not.toHaveBeenCalled();
  });

  it('targets only a requested account from All Inboxes and preserves connection error on uncertainty', async () => {
    state = { ...state, activeMailbox: 'UNIFIED', unifiedInbox: true };
    nativeView = { accountId: null, mailbox: 'UNIFIED', unifiedFolder: 'INBOX' };
    nativeRequest.mockResolvedValueOnce({ receipt: { status: 'pending' }, uncertain: true });
    await refreshAllAccounts({ accountId: 'b' });
    expect(nativeRequest).toHaveBeenCalledWith({ accountId: 'b' });
    expect(state.connectionStatus).toBe('error');
    expect(loadUnifiedInbox).toHaveBeenCalledTimes(1);
    expect(invalidateRestore).toHaveBeenCalledWith('a');
    expect(invalidateRestore).toHaveBeenCalledWith('b');
  });

  it('preserves a failed native result without a fabricated success time', async () => {
    nativeRequest.mockRejectedValueOnce(new Error('native failure'));
    await expect(refreshAllAccounts({ accountId: 'a' })).rejects.toThrow('native failure');
    expect(state.connectionStatus).toBe('error');
    expect(oldProviderPages).not.toHaveBeenCalled();
  });
});
