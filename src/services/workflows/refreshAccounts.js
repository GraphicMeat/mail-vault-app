// Manual refresh is a native intent. The worker owns account selection,
// provider pages, interval and launch work; this module repaints the view.
import { useMailStore } from '../../stores/mailStore';
import { unreadPresentation } from '../../stores/unreadCounts';
import { requestNativeRefresh, observeNativeView, currentNativeView } from '../nativeSyncContext.js';
import { invalidateRestoreDescriptors } from '../cacheManager';
import { invalidate as invalidateProbe } from '../syncProbe';
import { forceMailboxRefetch } from './helpers/mailboxRefetch';
import { invalidateFolderStatus, refreshFolderStatus } from './folderStatus';
import { accountExpectedContext } from '../db/accounts';

async function repaintCurrentView() {
  const get = () => useMailStore.getState();
  const state = get();
  if (state.unifiedInbox || state.activeMailbox === 'UNIFIED') {
    return state.loadUnifiedInbox?.(null, state.unifiedFolder || 'INBOX');
  }
  if (state.mailboxScope?.root === state.activeMailbox) {
    return state.loadSubtree?.(state.activeAccountId, state.mailboxScope.root);
  }
  if (state.activeAccountId && state.activeMailbox) {
    return state.loadEmails?.({ rereadFlags: true });
  }
}

async function folderMetadata(accountId, mailbox) {
  const get = () => useMailStore.getState();
  const account = get().accounts.find(row => row.id === accountId);
  if (!account) return;
  const original = JSON.stringify(accountExpectedContext(account, 'all'));
  forceMailboxRefetch(accountId);
  await Promise.all([invalidateProbe(accountId, mailbox), invalidateFolderStatus(accountId)]);
  try {
    const { fetchAccountMailboxes } = await import('./activateAccount');
    const mailboxes = await fetchAccountMailboxes(account);
    const now = get();
    const current = now.accounts.find(row => row.id === accountId);
    if (now.activeAccountId !== accountId || !current
      || JSON.stringify(accountExpectedContext(current, 'all')) !== original) return;
    useMailStore.setState({ mailboxes });
    void refreshFolderStatus(account, mailboxes, now.activeMailbox).catch(() => {});
  } catch (error) { console.warn('[refresh] Folder listing remains unavailable:', error); }
}

/** The unthrottled workflow path also serves confirmed operation repaint. */
export async function refreshCurrentView() {
  const state = useMailStore.getState();
  const view = currentNativeView();
  await observeNativeView(view);
  if (!view) return { newEmails: 0, totalUnread: (await unreadPresentation())?.total ?? 0 };
  const ordinary = view.accountId && !view.scopePaths;
  const pendingMetadata = ordinary ? folderMetadata(view.accountId, view.mailbox) : null;
  const result = await requestNativeRefresh(view.accountId
    ? { accountId: view.accountId, ...(ordinary ? { mailbox: view.mailbox } : {}) }
    : {});
  if (pendingMetadata) await pendingMetadata;
  await repaintCurrentView();
  return { ...result, newEmails: 0, totalUnread: (await unreadPresentation())?.total ?? 0 };
}

/** Sidebar retry keeps its account target; an omitted mailbox remains omitted
 * until the native worker admits per-account targets from captured context. */
export async function refreshAllAccounts(options = {}) {
  const state = useMailStore.getState();
  if (!state.accounts.length) return { newEmails: 0, totalUnread: 0 };
  await observeNativeView(currentNativeView());
  for (const account of state.accounts) invalidateRestoreDescriptors(account.id);
  const result = await requestNativeRefresh({
    ...(options.accountId ? { accountId: options.accountId } : {}),
    ...(options.mailbox ? { mailbox: options.mailbox } : {}),
  });
  await repaintCurrentView();
  if (options.accountId && options.accountId === useMailStore.getState().activeAccountId && !result.uncertain) {
    useMailStore.setState({ connectionStatus: 'connected', connectionError: null, connectionErrorType: null });
  }
  return { ...result, newEmails: 0, totalUnread: (await unreadPresentation())?.total ?? 0 };
}
