// ── messageListStore — domain hook and read contracts for message list state ──
// Thin wrapper over the unified mailStore facade.
// Components should import from here instead of mailStore for email list concerns.

import { useMailStore } from './mailStore';

/** Zustand-compatible hook — pass a selector just like useMailStore. */
export function useMessageListStore(selector) {
  return useMailStore(selector);
}

// ── Published read contracts (for workflows and cross-store access) ──

export const getEmails = () => useMailStore.getState().emails;
export const getSortedEmails = () => useMailStore.getState().sortedEmails;
export const getSentEmails = () => useMailStore.getState().sentEmails;
export const getLocalEmails = () => useMailStore.getState().localEmails;
export const getSavedEmailIds = () => useMailStore.getState().savedEmailIds;
export const getArchivedEmailIds = () => useMailStore.getState().archivedEmailIds;
export const getTotalEmails = () => useMailStore.getState().totalEmails;
export const getHasMoreEmails = () => useMailStore.getState().hasMoreEmails;
export const getServerUidSet = () => useMailStore.getState().serverUidSet;
