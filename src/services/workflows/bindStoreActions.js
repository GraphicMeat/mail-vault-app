// ── bindStoreActions — plugs the workflows into the stores ──
//
// Layering: stores sit below workflows. A workflow imports the stores; no
// file under src/stores/ imports a workflow (tests/unit/importLayers.test.js).
// The slices declare every action a workflow implements as an unbound stub
// (stores/slices/unboundAction.js); this module, which sees both layers,
// replaces each stub once with the real workflow call. Action names and
// argument shapes are exactly what the slices exposed when they imported the
// workflows themselves.
//
// Import this module before anything can call a store action (main.jsx does,
// and tests that drive the real mail store do). Importing it binds; calling
// `bindStoreActions()` again is a no-op.

import { useMailStore } from '../../stores/mailStore';
import { bindWorkflowPorts } from '../../stores/workflowPorts';
import { createManualRefreshThrottle } from '../../utils/manualRefreshThrottle';
import {
  activateAccount as _activateAccount,
  init as _init,
  setActiveAccount as _setActiveAccount,
} from './activateAccount';
import { loadSubtree as _loadSubtree } from './loadSubtree';
import { _prefetchAllMailboxes, _prewarmAccountCaches } from './prefetch';
import { addAccount as _addAccount } from './addAccount';
import { updateAccount as _updateAccount } from './updateAccount';
import { changeServer as _changeServer } from './changeServer';
import { removeAccount as _removeAccount } from './removeAccount';
import { refreshCurrentView as _refreshCurrentView, refreshAllAccounts as _refreshAllAccounts } from './refreshAccounts';
import { retryKeychainAccess as _retryKeychainAccess } from './retryKeychainAccess';
import {
  createFolder as _createFolder,
  renameFolder as _renameFolder,
  deleteFolder as _deleteFolder,
  deleteLocalFolder as _deleteLocalFolder,
} from './folderOps';
import {
  setUnifiedInbox as _setUnifiedInbox,
  switchUnifiedFolder as _switchUnifiedFolder,
  loadUnifiedInbox as _loadUnifiedInbox,
} from './loadUnifiedInbox';
import {
  saveEmailLocally as _saveEmailLocally,
  saveEmailsLocally as _saveEmailsLocally,
  saveSelectedLocally as _saveSelectedLocally,
  removeLocalEmail as _removeLocalEmail,
  removeLocalEmails as _removeLocalEmails,
  deleteEmailFromServer as _deleteEmailFromServer,
  markEmailReadStatus as _markEmailReadStatus,
  exportEmail as _exportEmail,
  markSelectedAsRead as _markSelectedAsRead,
  markSelectedAsUnread as _markSelectedAsUnread,
  setSelectedFlagged as _setSelectedFlagged,
  toggleFlagged as _toggleFlagged,
  deleteSelectedFromServer as _deleteSelectedFromServer,
  moveEmails as _moveEmails,
  purgeEverywhereReporting as _purgeEverywhere,
  applyFlagToTargets as _applyFlagToTargets,
  setDeleteUndo as _setDeleteUndo,
  reloadListInView as _reloadListInView,
  applySeenLocally as _applySeenLocally,
} from './messageMutations';
import {
  selectEmail as _selectEmail,
  _prefetchAdjacentEmails,
  cancelSelection as _cancelSelection,
  cancelInsightsSelection as _cancelInsightsSelection,
} from './selectEmail';
import {
  loadEmails as _loadEmails,
  _loadEmailsViaGraph,
  loadSentHeaders as _loadSentHeaders,
  extendSentWindows as _extendSentWindows,
} from './loadEmails';
import { loadMoreEmails as _loadMoreEmails } from './loadMoreEmails';

const currentAccountId = () => useMailStore.getState().activeAccountId;

/** Every mail-store action a workflow implements, keyed as the slices declare them. */
export function storeActions() {
  return {
    // account
    init: () => _init(),
    _prefetchAllMailboxes: (opts) => _prefetchAllMailboxes(opts),
    _prewarmAccountCaches: () => _prewarmAccountCaches(),
    addAccount: (accountData) => _addAccount(accountData),
    updateAccount: (accountId, patch) => _updateAccount(accountId, patch),
    changeServer: (accountId, patch) => _changeServer(accountId, patch),
    removeAccount: (accountId) => _removeAccount(accountId),
    setActiveAccount: (accountId) => _setActiveAccount(accountId),
    activateAccount: (accountId, mailbox, opts) => _activateAccount(accountId, mailbox, opts),
    loadSubtree: (accountId, rootPath, opts) => _loadSubtree(accountId, rootPath, opts),
    setUnifiedInbox: (enabled) => _setUnifiedInbox(enabled),
    switchUnifiedFolder: (mailbox) => _switchUnifiedFolder(mailbox),
    loadUnifiedInbox: (preUnifiedSnapshot, mailbox) => _loadUnifiedInbox(preUnifiedSnapshot, mailbox),
    saveEmailLocally: (uid) => _saveEmailLocally(uid),
    saveEmailsLocally: (rows) => _saveEmailsLocally(rows),
    saveSelectedLocally: () => _saveSelectedLocally(),
    removeLocalEmail: (uid, location) => _removeLocalEmail(uid, location),
    removeLocalEmails: (targets) => _removeLocalEmails(targets),
    deleteEmailFromServer: (uid, opts) => _deleteEmailFromServer(uid, opts),
    markEmailReadStatus: (uid, read) => _markEmailReadStatus(uid, read),
    exportEmail: (uid, subject) => _exportEmail(uid, subject),
    // The active account is implied, as for every other sidebar action.
    createFolder: (parentPath, name) => _createFolder(currentAccountId(), parentPath, name),
    renameFolder: (path, name) => _renameFolder(currentAccountId(), path, name),
    deleteFolder: (path) => _deleteFolder(currentAccountId(), path),
    deleteLocalFolder: (name) => _deleteLocalFolder(currentAccountId(), name),
    // The spinner state stays in the account slice; the throttle lives here.
    refreshCurrentView: createManualRefreshThrottle(
      () => _refreshCurrentView(),
      (spinning) => useMailStore.setState({ manualRefreshSpinning: spinning }),
    ),
    refreshAllAccounts: (options) => _refreshAllAccounts(options),
    retryKeychainAccess: () => _retryKeychainAccess(),
    // selection
    _prefetchAdjacentEmails: (currentUid) => _prefetchAdjacentEmails(currentUid),
    selectEmail: (uid, source, mailboxOverride, locationOverride, clickedRow) => _selectEmail(uid, source, mailboxOverride, locationOverride, clickedRow),
    // Called from inside selectThread and closeEmail (through get()).
    _cancelSelection: (...args) => _cancelSelection(...args),
    markSelectedAsRead: () => _markSelectedAsRead(),
    markSelectedAsUnread: () => _markSelectedAsUnread(),
    setSelectedFlagged: (on) => _setSelectedFlagged(on),
    toggleFlagged: (key) => _toggleFlagged(key),
    deleteSelectedFromServer: () => _deleteSelectedFromServer(),
    moveEmails: (uids, targetMailbox) => _moveEmails(uids, targetMailbox),
    purgeSelectedEverywhere: (opts) => _purgeEverywhere([...useMailStore.getState().selectedEmailIds], opts),
    // message list
    loadEmails: (opts) => _loadEmails(opts),
    _loadEmailsViaGraph: (account, activeAccountId, activeMailbox, generation) => _loadEmailsViaGraph(account, activeAccountId, activeMailbox, generation),
    loadMoreEmails: () => _loadMoreEmails(),
    loadSentHeaders: (accountId, opts) => _loadSentHeaders(accountId, opts),
  };
}

// The Sent mirror is a window onto the folder, as far back as the INBOX list
// reaches: the list loading older mail adds the Sent rows it now spans. Once a
// burst of loads is over, not on every row written.
let _sentWindowTimer = null;
function watchSentWindows() {
  if (!hasRealStore()) return;
  useMailStore.subscribe((state, prev) => {
    if (state.emails === prev.emails) return;
    clearTimeout(_sentWindowTimer);
    _sentWindowTimer = setTimeout(() => {
      _extendSentWindows()
        .catch((e) => console.warn('[mailStore] Sent window not extended:', e));
    }, 150);
  });
}

let _bound = false;

// A test that mocks stores/mailStore hands back something that is not the
// zustand hook; there is nothing to attach the actions to then.
function hasRealStore() {
  return typeof useMailStore === 'function'
    && typeof useMailStore.setState === 'function'
    && typeof useMailStore.getState === 'function'
    && typeof useMailStore.subscribe === 'function';
}

export function bindStoreActions() {
  if (_bound) return;
  _bound = true;
  if (hasRealStore()) useMailStore.setState(storeActions());
  // Workflows the other stores start (stores/workflowPorts.js).
  bindWorkflowPorts({
    retryKeychainAccess: () => _retryKeychainAccess(),
    cancelInsightsSelection: (...args) => _cancelInsightsSelection(...args),
    applyFlagToTargets: (...args) => _applyFlagToTargets(...args),
    setDeleteUndo: (...args) => _setDeleteUndo(...args),
    deleteEmailFromServer: (uid, opts) => _deleteEmailFromServer(uid, opts),
    reloadListInView: () => _reloadListInView(),
    applySeenLocally: (...args) => _applySeenLocally(...args),
  });
  watchSentWindows();
}

bindStoreActions();
