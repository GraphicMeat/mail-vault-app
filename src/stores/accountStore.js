// ── accountStore — independent domain store for account state ──
// Creates a real Zustand store scoped to account fields.
// Components should import from here for account concerns; workflows use mailStore facade.

import { create } from 'zustand';
import { useMailStore } from './mailStore';

// ── Account field set — defines ownership boundary ──
const ACCOUNT_FIELDS = [
  'accounts', 'activeAccountId', 'activeMailbox', 'mailboxes', 'mailboxesFetchedAt',
  'unifiedInbox', 'unifiedFolder', 'connectionStatus', 'connectionError',
  'connectionErrorType', 'totalUnreadCount',
];

const ACCOUNT_ACTIONS = [
  'init', '_prefetchAllMailboxes', '_prewarmAccountCaches',
  'addAccount', 'removeAccount', 'setActiveAccount', 'activateAccount',
  'setUnifiedInbox', 'switchUnifiedFolder', 'loadUnifiedInbox',
  'saveEmailLocally', 'saveEmailsLocally', 'cancelArchive',
  'saveSelectedLocally', 'removeLocalEmail', 'deleteEmailFromServer',
  'markEmailReadStatus', 'exportEmail', 'setTotalUnreadCount',
  'calculateUnreadCount', 'refreshCurrentView', 'refreshAllAccounts',
  'retryKeychainAccess',
];

const OWNED_KEYS = new Set([...ACCOUNT_FIELDS, ...ACCOUNT_ACTIONS]);

function pickAccountState(full) {
  const result = {};
  for (const key of OWNED_KEYS) {
    if (key in full) result[key] = full[key];
  }
  return result;
}

// Independent Zustand store — initialized from the facade, kept in sync
export const useAccountStore = create(() => pickAccountState(useMailStore.getState()));

// Sync: facade -> accountStore (for state set via useMailStore.setState)
useMailStore.subscribe((state) => {
  useAccountStore.setState(pickAccountState(state));
});

// Sync: accountStore -> facade (for state set directly on accountStore)
const _origSetState = useAccountStore.setState.bind(useAccountStore);
useAccountStore.setState = (update, replace) => {
  _origSetState(update, replace);
  // Forward state-only fields to the facade
  if (typeof update === 'function') update = update(useAccountStore.getState());
  if (update) {
    const facadeUpdate = {};
    let hasAny = false;
    for (const key of ACCOUNT_FIELDS) {
      if (key in update) { facadeUpdate[key] = update[key]; hasAny = true; }
    }
    if (hasAny) useMailStore.setState(facadeUpdate);
  }
};

// ── Published read contracts (for workflows and cross-store access) ──

export const getActiveAccountId = () => useAccountStore.getState().activeAccountId;
export const getActiveMailbox = () => useAccountStore.getState().activeMailbox;
export const getAccounts = () => useAccountStore.getState().accounts;
export const getActiveAccount = () => {
  const s = useAccountStore.getState();
  return s.accounts.find(a => a.id === s.activeAccountId);
};
export const getMailboxes = () => useAccountStore.getState().mailboxes;
export const getConnectionStatus = () => useAccountStore.getState().connectionStatus;
export const getUnifiedInbox = () => useAccountStore.getState().unifiedInbox;
export const getUnifiedFolder = () => useAccountStore.getState().unifiedFolder;
export const getTotalUnreadCount = () => useAccountStore.getState().totalUnreadCount;
