// ── selectionStore — domain hook and read contracts for selection state ──
// Thin re-export over useMailStore. No separate store, no state duplication.

import { useMailStore } from './mailStore';

// Hook for components — same Zustand selector pattern, delegates to facade
export function useSelectionStore(selector) {
  return useMailStore(selector);
}

// Published read contracts for imperative access from workflows
export const getSelectedEmailId = () => useMailStore.getState().selectedEmailId;
export const getSelectedEmail = () => useMailStore.getState().selectedEmail;
export const getSelectedEmailIds = () => useMailStore.getState().selectedEmailIds;
export const getSelectedThread = () => useMailStore.getState().selectedThread;
