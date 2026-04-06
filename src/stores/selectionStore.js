// ── selectionStore — domain hook and read contracts for selection state ──
// Thin wrapper over the unified mailStore facade.
// Components should import from here instead of mailStore for selection concerns.

import { useMailStore } from './mailStore';

/** Zustand-compatible hook — pass a selector just like useMailStore. */
export function useSelectionStore(selector) {
  return useMailStore(selector);
}

// ── Published read contracts (for workflows and cross-store access) ──

export const getSelectedEmailId = () => useMailStore.getState().selectedEmailId;
export const getSelectedEmail = () => useMailStore.getState().selectedEmail;
export const getSelectedEmailIds = () => useMailStore.getState().selectedEmailIds;
export const getSelectedThread = () => useMailStore.getState().selectedThread;
