// A test that mocks stores/mailStore gives the binder something that is not
// the zustand hook. Binding must skip the store (not throw at import) and
// still bind the ports other stores use.
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => {
  const fns = new Proxy({}, { get: (target, key) => (target[key] ??= vi.fn()) });
  return { fns, fwd: (name) => (...args) => h.fns[name](...args) };
});

vi.mock('../../../stores/mailStore', () => ({ useMailStore: vi.fn() }));
vi.mock('../activateAccount', () => ({ activateAccount: h.fwd('activateAccount'), init: h.fwd('init'), setActiveAccount: h.fwd('setActiveAccount') }));
vi.mock('../loadSubtree', () => ({ loadSubtree: h.fwd('loadSubtree') }));
vi.mock('../prefetch', () => ({ _prefetchAllMailboxes: h.fwd('_prefetchAllMailboxes'), _prewarmAccountCaches: h.fwd('_prewarmAccountCaches') }));
vi.mock('../addAccount', () => ({ addAccount: h.fwd('addAccount') }));
vi.mock('../updateAccount', () => ({ updateAccount: h.fwd('updateAccount') }));
vi.mock('../changeServer', () => ({ changeServer: h.fwd('changeServer') }));
vi.mock('../removeAccount', () => ({ removeAccount: h.fwd('removeAccount') }));
vi.mock('../refreshAccounts', () => ({ refreshCurrentView: h.fwd('refreshCurrentView'), refreshAllAccounts: h.fwd('refreshAllAccounts') }));
vi.mock('../retryKeychainAccess', () => ({ retryKeychainAccess: h.fwd('retryKeychainAccess') }));
vi.mock('../folderOps', () => ({
  createFolder: h.fwd('createFolder'), renameFolder: h.fwd('renameFolder'),
  deleteFolder: h.fwd('deleteFolder'), deleteLocalFolder: h.fwd('deleteLocalFolder'),
}));
vi.mock('../loadUnifiedInbox', () => ({
  setUnifiedInbox: h.fwd('setUnifiedInbox'), switchUnifiedFolder: h.fwd('switchUnifiedFolder'), loadUnifiedInbox: h.fwd('loadUnifiedInbox'),
}));
vi.mock('../messageMutations', () => Object.fromEntries([
  'saveEmailLocally', 'saveEmailsLocally', 'saveSelectedLocally', 'removeLocalEmail', 'removeLocalEmails',
  'deleteEmailFromServer', 'markEmailReadStatus', 'exportEmail', 'markSelectedAsRead', 'markSelectedAsUnread',
  'setSelectedFlagged', 'toggleFlagged', 'deleteSelectedFromServer', 'moveEmails', 'purgeEverywhereReporting',
  'applyFlagToTargets', 'setDeleteUndo', 'reloadListInView', 'applySeenLocally',
].map(name => [name, h.fwd(name)])));
vi.mock('../selectEmail', () => ({
  selectEmail: h.fwd('selectEmail'), _prefetchAdjacentEmails: h.fwd('_prefetchAdjacentEmails'),
  cancelSelection: h.fwd('cancelSelection'), cancelInsightsSelection: h.fwd('cancelInsightsSelection'),
}));
vi.mock('../loadEmails', () => ({
  loadEmails: h.fwd('loadEmails'), _loadEmailsViaGraph: h.fwd('_loadEmailsViaGraph'),
  loadSentHeaders: h.fwd('loadSentHeaders'), extendSentWindows: h.fwd('extendSentWindows'),
}));
vi.mock('../loadMoreEmails', () => ({ loadMoreEmails: h.fwd('loadMoreEmails') }));

describe('bindStoreActions with a mocked mail store', () => {
  // Red before the guard: loading the module ran useMailStore.setState(...) on a
  // vi.fn() with no setState and threw "setState is not a function".
  it('loads without throwing and still binds the workflow ports', async () => {
    await expect(import('../bindStoreActions')).resolves.toBeDefined();
    const { workflowPort } = await import('../../../stores/workflowPorts');
    workflowPort('reloadListInView')();
    expect(h.fns.reloadListInView).toHaveBeenCalledTimes(1);
  });

  // Red before the guard: the explicit call threw as well.
  it('bindStoreActions() stays a no-op on a store without setState', async () => {
    const { bindStoreActions } = await import('../bindStoreActions');
    expect(() => bindStoreActions()).not.toThrow();
  });
});
