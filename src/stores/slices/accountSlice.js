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

// ── Manual-refresh throttle ──
// UI fires instantly on every click (brief spinner). Actual sync runs at most
// once per REFRESH_COOLDOWN_MS, and at most one at a time. Clicks during the
// cooldown or during an in-flight sync are coalesced into a single trailing
// run.
const REFRESH_COOLDOWN_MS = 15_000;
const REFRESH_SPINNER_MIN_MS = 600;
let _lastRefreshAt = 0;
let _refreshInFlight = false;
let _pendingRefresh = false;
let _pendingTimer = null;

function _flashSpinner(set) {
  set({ manualRefreshSpinning: true });
  setTimeout(() => set({ manualRefreshSpinning: false }), REFRESH_SPINNER_MIN_MS);
}

function _scheduleTrailingRefresh(set, delayMs) {
  if (_pendingTimer) return;
  _pendingTimer = setTimeout(() => {
    _pendingTimer = null;
    if (_pendingRefresh) {
      _pendingRefresh = false;
      _runRefresh(set);
    }
  }, Math.max(0, delayMs));
}

async function _runRefresh(set) {
  if (_refreshInFlight) {
    _pendingRefresh = true;
    return;
  }
  const now = Date.now();
  const elapsed = now - _lastRefreshAt;
  if (elapsed < REFRESH_COOLDOWN_MS) {
    _pendingRefresh = true;
    _scheduleTrailingRefresh(set, REFRESH_COOLDOWN_MS - elapsed);
    return;
  }
  _refreshInFlight = true;
  _lastRefreshAt = Date.now();
  try {
    await _refreshCurrentView();
  } catch (err) {
    console.warn('[accountSlice] refreshCurrentView failed:', err);
  } finally {
    _refreshInFlight = false;
    if (_pendingRefresh) {
      _pendingRefresh = false;
      const wait = Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - _lastRefreshAt));
      _scheduleTrailingRefresh(set, wait);
    }
  }
}

function _throttledRefreshCurrentView(set) {
  _flashSpinner(set);
  _runRefresh(set);
}

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
    // Cross-store read via the facade: emails belong to the messageList domain
    const { emails } = get();
    const unreadCount = emails.filter(e => !e.flags?.includes('\\Seen')).length;
    set({ totalUnreadCount: unreadCount });
    return unreadCount;
  },

  // Manual-refresh UI spinner — briefly spins on every click so the button
  // feels instant even when the underlying sync is throttled or already running.
  manualRefreshSpinning: false,

  refreshCurrentView: () => _throttledRefreshCurrentView(set),
  refreshAllAccounts: (options) => _refreshAllAccounts(options),
  retryKeychainAccess: () => _retryKeychainAccess(),
});
