// ── accountStore — domain hook and read contracts for account state ──
// Thin re-export over useMailStore. No separate store, no state duplication.

import { useMailStore } from './mailStore';

// Hook for components — same Zustand selector pattern, delegates to facade
export function useAccountStore(selector) {
  return useMailStore(selector);
}

// Published read contracts for imperative access from workflows
export const getActiveAccountId = () => useMailStore.getState().activeAccountId;
export const getActiveMailbox = () => useMailStore.getState().activeMailbox;
export const getAccounts = () => useMailStore.getState().accounts;
export const getActiveAccount = () => {
  const s = useMailStore.getState();
  return s.accounts.find(a => a.id === s.activeAccountId);
};
export const getMailboxes = () => useMailStore.getState().mailboxes;
export const getConnectionStatus = () => useMailStore.getState().connectionStatus;
export const getUnifiedInbox = () => useMailStore.getState().unifiedInbox;
export const getUnifiedFolder = () => useMailStore.getState().unifiedFolder;
export const getTotalUnreadCount = () => useMailStore.getState().totalUnreadCount;
