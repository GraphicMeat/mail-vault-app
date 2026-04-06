// ── cacheStore — domain hook and read contracts for email body cache ──
// Thin wrapper over the unified mailStore facade.
// Components should import from here instead of mailStore for cache concerns.

import { useMailStore } from './mailStore';

/** Zustand-compatible hook — pass a selector just like useMailStore. */
export function useCacheStore(selector) {
  return useMailStore(selector);
}

// ── Published read contracts (for workflows and cross-store access) ──

export const getCacheCurrentSizeMB = () => useMailStore.getState().cacheCurrentSizeMB;
export const getEmailCache = () => useMailStore.getState().emailCache;
