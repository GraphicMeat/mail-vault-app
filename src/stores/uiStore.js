// ── uiStore — domain hook and read contracts for UI state ──
// Thin wrapper over the unified mailStore facade.
// Components should import from here instead of mailStore for UI concerns.

import { useMailStore } from './mailStore';

/** Zustand-compatible hook — pass a selector just like useMailStore. */
export function useUiStore(selector) {
  return useMailStore(selector);
}

// ── Published read contracts (for workflows and cross-store access) ──

export const getViewMode = () => useMailStore.getState().viewMode;
export const getError = () => useMailStore.getState().error;
export const getBulkSaveProgress = () => useMailStore.getState().bulkSaveProgress;
export const getExportProgress = () => useMailStore.getState().exportProgress;
