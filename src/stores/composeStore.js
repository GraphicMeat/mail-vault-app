// ── composeStore — domain hook and read contracts for compose/undo-send state ──
// Thin re-export over useMailStore. No separate store, no state duplication.

import { useMailStore } from './mailStore';

// Hook for components — same Zustand selector pattern, delegates to facade
export function useComposeStore(selector) {
  return useMailStore(selector);
}

// Published read contracts for imperative access from workflows
export const getPendingSend = () => useMailStore.getState().pendingSend;
