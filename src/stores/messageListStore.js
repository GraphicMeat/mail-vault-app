// ── messageListStore — domain hook and read contracts for message list state ──
// Thin re-export over useMailStore. No separate store, no state duplication.

import { useMailStore } from './mailStore';

// Hook for components — same Zustand selector pattern, delegates to facade
export function useMessageListStore(selector) {
  return useMailStore(selector);
}

// Published read contracts for imperative access from workflows
export const getEmails = () => useMailStore.getState().emails;
export const getSortedEmails = () => useMailStore.getState().sortedEmails;
export const getSentEmails = () => useMailStore.getState().sentEmails;
export const getLocalEmails = () => useMailStore.getState().localEmails;
export const getSavedEmailIds = () => useMailStore.getState().savedEmailIds;
export const getArchivedEmailIds = () => useMailStore.getState().archivedEmailIds;
export const getTotalEmails = () => useMailStore.getState().totalEmails;
export const getHasMoreEmails = () => useMailStore.getState().hasMoreEmails;
export const getServerUidSet = () => useMailStore.getState().serverUidSet;
