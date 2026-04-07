// ── cacheStore — domain hook and read contracts for email body cache ──
// Thin re-export over useMailStore. No separate store, no state duplication.

import { useMailStore } from './mailStore';

// Hook for components — same Zustand selector pattern, delegates to facade
export function useCacheStore(selector) {
  return useMailStore(selector);
}

// Published read contracts for imperative access from workflows
export const getCacheCurrentSizeMB = () => useMailStore.getState().cacheCurrentSizeMB;
export const getEmailCache = () => useMailStore.getState().emailCache;
