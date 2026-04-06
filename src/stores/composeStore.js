// ── composeStore — domain hook and read contracts for compose/undo-send state ──
// Thin wrapper over the unified mailStore facade.
// Components should import from here instead of mailStore for compose concerns.

import { useMailStore } from './mailStore';

/** Zustand-compatible hook — pass a selector just like useMailStore. */
export function useComposeStore(selector) {
  return useMailStore(selector);
}

// ── Published read contracts (for workflows and cross-store access) ──

export const getPendingSend = () => useMailStore.getState().pendingSend;
