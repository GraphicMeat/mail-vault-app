// ── uiStore — domain hook and read contracts for UI state ──
// Thin re-export over useMailStore. No separate store, no state duplication.

import { useMailStore } from './mailStore';

// Hook for components — same Zustand selector pattern, delegates to facade
export function useUiStore(selector) {
  return useMailStore(selector);
}
