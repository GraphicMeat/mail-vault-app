// ── syncStore — domain hook and read contracts for sync/loading flags ──
// Thin re-export over useMailStore. No separate store, no state duplication.

import { useMailStore } from './mailStore';

// Hook for components — same Zustand selector pattern, delegates to facade
export function useSyncStore(selector) {
  return useMailStore(selector);
}
