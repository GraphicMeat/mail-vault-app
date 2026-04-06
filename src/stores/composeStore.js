// ── composeStore — independent domain store for compose/undo-send state ──
// Creates a real Zustand store scoped to compose fields.
// Components should import from here for compose concerns; workflows use mailStore facade.

import { create } from 'zustand';
import { useMailStore } from './mailStore';

// ── Compose field set — defines ownership boundary ──
const COMPOSE_FIELDS = ['pendingSend'];
const COMPOSE_ACTIONS = ['queueSend', 'cancelPendingSend'];
const OWNED_KEYS = new Set([...COMPOSE_FIELDS, ...COMPOSE_ACTIONS]);

function pickComposeState(full) {
  const result = {};
  for (const key of OWNED_KEYS) {
    if (key in full) result[key] = full[key];
  }
  return result;
}

// Independent Zustand store — initialized from the facade, kept in sync
export const useComposeStore = create(() => pickComposeState(useMailStore.getState()));

// Sync: facade -> composeStore
useMailStore.subscribe((state) => {
  useComposeStore.setState(pickComposeState(state));
});

// Sync: composeStore -> facade
const _origSetState = useComposeStore.setState.bind(useComposeStore);
useComposeStore.setState = (update, replace) => {
  _origSetState(update, replace);
  if (typeof update === 'function') update = update(useComposeStore.getState());
  if (update) {
    const facadeUpdate = {};
    let hasAny = false;
    for (const key of COMPOSE_FIELDS) {
      if (key in update) { facadeUpdate[key] = update[key]; hasAny = true; }
    }
    if (hasAny) useMailStore.setState(facadeUpdate);
  }
};

// ── Published read contracts (for workflows and cross-store access) ──

export const getPendingSend = () => useComposeStore.getState().pendingSend;
