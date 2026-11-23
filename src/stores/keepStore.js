import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeStorage } from './safeStorage';
import { DEFAULT_DOCK, restoreKeep, keepActions } from '../shared/keep';

// "Keep in bubble" on the desktop: the emails kept for later and where their
// dock sits. The rules live in shared/keep; this store only holds the result
// and survives a restart. Per device, not synced.
export const useKeepStore = create(
  persist(
    (set) => ({
      items: [],
      dock: DEFAULT_DOCK,
      ...keepActions(set, () => Date.now()),
    }),
    {
      name: 'mailvault-keep',
      version: 0,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ items: s.items, dock: s.dock }),
      // The settings file is untrusted input: only the well-formed part reaches state.
      merge: (persisted, current) => ({ ...current, ...restoreKeep(persisted) }),
    },
  ),
);
