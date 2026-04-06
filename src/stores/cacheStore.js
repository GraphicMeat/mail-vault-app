// ── cacheStore — independent domain store for email body cache ──
// Creates a real Zustand store scoped to cache fields.
// Components should import from here for cache concerns; workflows use mailStore facade.

import { create } from 'zustand';
import { useMailStore } from './mailStore';

// ── Cache field set — defines ownership boundary ──
const CACHE_FIELDS = ['emailCache', 'cacheCurrentSizeMB'];

const CACHE_ACTIONS = [
  'clearEmailCache', 'evictPrefetchEntries',
  'estimateEmailSizeMB', 'addToCache', 'getFromCache',
];

const OWNED_KEYS = new Set([...CACHE_FIELDS, ...CACHE_ACTIONS]);

function pickCacheState(full) {
  const result = {};
  for (const key of OWNED_KEYS) {
    if (key in full) result[key] = full[key];
  }
  return result;
}

// Independent Zustand store — initialized from the facade, kept in sync
export const useCacheStore = create(() => pickCacheState(useMailStore.getState()));

// Sync: facade -> cacheStore
useMailStore.subscribe((state) => {
  useCacheStore.setState(pickCacheState(state));
});

// Sync: cacheStore -> facade
const _origSetState = useCacheStore.setState.bind(useCacheStore);
useCacheStore.setState = (update, replace) => {
  _origSetState(update, replace);
  if (typeof update === 'function') update = update(useCacheStore.getState());
  if (update) {
    const facadeUpdate = {};
    let hasAny = false;
    for (const key of CACHE_FIELDS) {
      if (key in update) { facadeUpdate[key] = update[key]; hasAny = true; }
    }
    if (hasAny) useMailStore.setState(facadeUpdate);
  }
};

// ── Published read contracts (for workflows and cross-store access) ──

export const getCacheCurrentSizeMB = () => useCacheStore.getState().cacheCurrentSizeMB;
export const getEmailCache = () => useCacheStore.getState().emailCache;
