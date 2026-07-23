// ── accountStore — domain hook and read contracts for account state ──
// Thin re-export over useMailStore. No separate store, no state duplication.

import { useMailStore } from './mailStore';

// Hook for components — same Zustand selector pattern, delegates to facade
export function useAccountStore(selector) {
  return useMailStore(selector);
}

// Published read contracts for imperative access from workflows
export const getAccounts = () => useMailStore.getState().accounts;
export const getMailboxes = () => useMailStore.getState().mailboxes;
