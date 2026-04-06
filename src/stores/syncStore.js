// ── syncStore — domain hook and read contracts for sync/loading flags ──
// Thin wrapper over the unified mailStore facade.
// Components should import from here instead of mailStore for sync state concerns.

import { useMailStore } from './mailStore';

/** Zustand-compatible hook — pass a selector just like useMailStore. */
export function useSyncStore(selector) {
  return useMailStore(selector);
}

// ── Published read contracts (for workflows and cross-store access) ──

export const getLoading = () => useMailStore.getState().loading;
export const getLoadingMore = () => useMailStore.getState().loadingMore;
export const getRestoring = () => useMailStore.getState().restoring;
export const getLoadingProgress = () => useMailStore.getState().loadingProgress;
