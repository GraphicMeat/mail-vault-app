// ── accountSlice — accounts, activation, unified inbox, and workflow actions ──
// Large async orchestration functions live in src/services/workflows/. This
// slice holds state and the inline actions; every action a workflow
// implements is declared as an unbound stub, replaced by
// services/workflows/bindStoreActions.js (stores never import workflows).

import { send } from '../../services/transport.js';
import { unboundAction } from './unboundAction';

export const createAccountSlice = (set) => ({
  // Accounts
  accounts: [],
  activeAccountId: null,

  // Mailboxes
  mailboxes: [],
  mailboxesFetchedAt: null,
  // Vault-only folders (MBOX import mode 3), per account, as `list_local_folders`
  // answers: { [accountId]: [{ name, dir, kind, created, source }] }. Kept apart
  // from `mailboxes`, the server's list, and merged only where the sidebar
  // draws (withLocalFolders), so no server-list write or reader ever sees one.
  localFolders: {},
  // Per-account STATUS counts for folders that are not open:
  // { [accountId]: { [path]: { path, messages, unseen, uidNext, uidValidity } } }
  folderStatus: {},
  activeMailbox: 'INBOX',
  // Set while the list shows a whole branch: { root, paths }. activeMailbox
  // stays the branch root — a real, SELECT-able path — so nothing that treats
  // it as a mailbox has to learn a second magic value the way 'UNIFIED' made
  // twenty call sites do.
  mailboxScope: null,
  // { done, total } while a branch is still fanning out, else null.
  subtreeProgress: null,

  // Connection status: 'connected' | 'disconnected' | 'error'
  connectionStatus: 'disconnected',
  connectionError: null,
  connectionErrorType: null,
  // The daemon's errorCode for a 'serverError' (what the failed sync ran
  // into: dns, refused, blocked_or_timeout, tls, auth, throttled, ...). Read
  // only alongside connectionErrorType 'serverError', and every writer of
  // that type writes this too, null when there is no code.
  connectionErrorCode: null,

  // Unified inbox mode
  unifiedInbox: false,
  unifiedFolder: 'INBOX',

  // ── Actions implemented by workflows (bound in bindStoreActions) ──

  init: unboundAction('init'),
  _prefetchAllMailboxes: unboundAction('_prefetchAllMailboxes'),
  _prewarmAccountCaches: unboundAction('_prewarmAccountCaches'),
  addAccount: unboundAction('addAccount'),
  updateAccount: unboundAction('updateAccount'),
  changeServer: unboundAction('changeServer'),
  removeAccount: unboundAction('removeAccount'),
  setActiveAccount: unboundAction('setActiveAccount'),
  activateAccount: unboundAction('activateAccount'),
  loadSubtree: unboundAction('loadSubtree'),
  setUnifiedInbox: unboundAction('setUnifiedInbox'),
  switchUnifiedFolder: unboundAction('switchUnifiedFolder'),
  loadUnifiedInbox: unboundAction('loadUnifiedInbox'),
  saveEmailLocally: unboundAction('saveEmailLocally'),
  saveEmailsLocally: unboundAction('saveEmailsLocally'),

  cancelArchive: () => {
    if (window.__TAURI__?.core?.invoke) send('cancel_archive').catch(() => {});
    set({ bulkSaveProgress: null });
  },

  saveSelectedLocally: unboundAction('saveSelectedLocally'),
  removeLocalEmail: unboundAction('removeLocalEmail'),
  removeLocalEmails: unboundAction('removeLocalEmails'),
  deleteEmailFromServer: unboundAction('deleteEmailFromServer'),
  markEmailReadStatus: unboundAction('markEmailReadStatus'),
  exportEmail: unboundAction('exportEmail'),

  // Manual-refresh UI spinner — briefly spins on every click so the button
  // feels instant even when the underlying sync is throttled or already running.
  manualRefreshSpinning: false,

  // Folder management, the manual-refresh throttle and the rest: bound in
  // bindStoreActions. The folder actions imply the active account, as every
  // other sidebar action does; failures reach the caller, which owns the toast.
  createFolder: unboundAction('createFolder'),
  renameFolder: unboundAction('renameFolder'),
  deleteFolder: unboundAction('deleteFolder'),
  deleteLocalFolder: unboundAction('deleteLocalFolder'),
  refreshCurrentView: unboundAction('refreshCurrentView'),
  refreshAllAccounts: unboundAction('refreshAllAccounts'),
  retryKeychainAccess: unboundAction('retryKeychainAccess'),
});
