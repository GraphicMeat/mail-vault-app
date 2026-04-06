// ── accountStore — domain hook and read contracts for account state ──
// Thin wrapper over the unified mailStore facade.
// Components should import from here instead of mailStore for account concerns.

import { useMailStore } from './mailStore';

/** Zustand-compatible hook — pass a selector just like useMailStore. */
export function useAccountStore(selector) {
  return useMailStore(selector);
}

// ── Published read contracts (for workflows and cross-store access) ──

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
