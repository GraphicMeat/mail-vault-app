// ── syncStore — independent domain store for sync/loading flags ──
// Creates a real Zustand store scoped to sync fields.
// Components should import from here for sync state concerns; workflows use mailStore facade.

import { create } from 'zustand';
import { useMailStore } from './mailStore';

// ── Sync field set — defines ownership boundary ──
const SYNC_FIELDS = [
  'loading', 'loadingMore', 'restoring', '_loadMoreRetryDelay',
  '_loadMorePausedOffline', 'loadingProgress', 'suspectEmptyServerData',
];

const OWNED_KEYS = new Set(SYNC_FIELDS);

function pickSyncState(full) {
  const result = {};
  for (const key of OWNED_KEYS) {
    if (key in full) result[key] = full[key];
  }
  return result;
}

// Independent Zustand store — initialized from the facade, kept in sync
export const useSyncStore = create(() => pickSyncState(useMailStore.getState()));

// Sync: facade -> syncStore
useMailStore.subscribe((state) => {
  useSyncStore.setState(pickSyncState(state));
});

// Sync: syncStore -> facade
const _origSetState = useSyncStore.setState.bind(useSyncStore);
useSyncStore.setState = (update, replace) => {
  _origSetState(update, replace);
  if (typeof update === 'function') update = update(useSyncStore.getState());
  if (update) {
    const facadeUpdate = {};
    let hasAny = false;
    for (const key of SYNC_FIELDS) {
      if (key in update) { facadeUpdate[key] = update[key]; hasAny = true; }
    }
    if (hasAny) useMailStore.setState(facadeUpdate);
  }
};

// ── Published read contracts (for workflows and cross-store access) ──

export const getLoading = () => useSyncStore.getState().loading;
export const getLoadingMore = () => useSyncStore.getState().loadingMore;
export const getRestoring = () => useSyncStore.getState().restoring;
export const getLoadingProgress = () => useSyncStore.getState().loadingProgress;
