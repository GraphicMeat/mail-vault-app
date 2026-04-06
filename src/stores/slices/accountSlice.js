// ── accountSlice — accounts, activation, unified inbox, and workflow actions ──
// Large async orchestration functions are extracted to src/services/workflows/.
// This slice contains only state declarations and passthrough wrappers.

import {
  activateAccount as _activateAccount,
  init as _init,
  _prefetchAllMailboxes,
  _prewarmAccountCaches,
  addAccount as _addAccount,
  removeAccount as _removeAccount,
  setActiveAccount as _setActiveAccount,
  refreshCurrentView as _refreshCurrentView,
  refreshAllAccounts as _refreshAllAccounts,
  retryKeychainAccess as _retryKeychainAccess,
} from '../../services/workflows/activateAccount';
import {
  setUnifiedInbox as _setUnifiedInbox,
  switchUnifiedFolder as _switchUnifiedFolder,
  loadUnifiedInbox as _loadUnifiedInbox,
} from '../../services/workflows/loadUnifiedInbox';
import {
  saveEmailLocally as _saveEmailLocally,
  saveEmailsLocally as _saveEmailsLocally,
  saveSelectedLocally as _saveSelectedLocally,
  removeLocalEmail as _removeLocalEmail,
  deleteEmailFromServer as _deleteEmailFromServer,
  markEmailReadStatus as _markEmailReadStatus,
  exportEmail as _exportEmail,
} from '../../services/workflows/messageMutations';

export const createAccountSlice = (set, get) => ({
  // Accounts
  accounts: [],
  activeAccountId: null,

  // Mailboxes
  mailboxes: [],
  mailboxesFetchedAt: null,
  activeMailbox: 'INBOX',

  // Connection status: 'connected' | 'disconnected' | 'error'
  connectionStatus: 'disconnected',
  connectionError: null,
  connectionErrorType: null,

  // Unified inbox mode
  unifiedInbox: false,
  unifiedFolder: 'INBOX',

  // Unread counts across all accounts
  totalUnreadCount: 0,

  // ── Passthrough wrappers to workflow functions ──

  init: () => _init(),
  _prefetchAllMailboxes: (opts) => _prefetchAllMailboxes(opts),
  _prewarmAccountCaches: () => _prewarmAccountCaches(),
  addAccount: (accountData) => _addAccount(accountData),
  removeAccount: (accountId) => _removeAccount(accountId),
  setActiveAccount: (accountId) => _setActiveAccount(accountId),
  activateAccount: (accountId, mailbox, opts) => _activateAccount(accountId, mailbox, opts),
  setUnifiedInbox: (enabled) => _setUnifiedInbox(enabled),
  switchUnifiedFolder: (mailbox) => _switchUnifiedFolder(mailbox),
  loadUnifiedInbox: (preUnifiedSnapshot, mailbox) => _loadUnifiedInbox(preUnifiedSnapshot, mailbox),
  saveEmailLocally: (uid) => _saveEmailLocally(uid),
  saveEmailsLocally: (uids) => _saveEmailsLocally(uids),

  cancelArchive: () => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) invoke('cancel_archive').catch(() => {});
    set({ bulkSaveProgress: null });
  },

  saveSelectedLocally: () => _saveSelectedLocally(),
  removeLocalEmail: (uid) => _removeLocalEmail(uid),
  deleteEmailFromServer: (uid, opts) => _deleteEmailFromServer(uid, opts),
  markEmailReadStatus: (uid, read) => _markEmailReadStatus(uid, read),
  exportEmail: (uid) => _exportEmail(uid),

  setTotalUnreadCount: (count) => set({ totalUnreadCount: count }),

  calculateUnreadCount: () => {
    const { emails } = get();
    const unreadCount = emails.filter(e => !e.flags?.includes('\\Seen')).length;
    set({ totalUnreadCount: unreadCount });
    return unreadCount;
  },

  refreshCurrentView: () => _refreshCurrentView(),
  refreshAllAccounts: (options) => _refreshAllAccounts(options),
  retryKeychainAccess: () => _retryKeychainAccess(),
});
