import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { safeStorage } from './safeStorage';
import { DEFAULT_DOCK, restoreKeep, withToggled, withoutSender, keepId } from '../shared/keep';

// "Keep in bubble" on the desktop: the emails kept for later and where their
// dock sits. The rules live in shared/keep; this store only holds the result
// and survives a restart. Per device, not synced.
export const useKeepStore = create(
  persist(
    (set) => ({
      items: [],
      dock: DEFAULT_DOCK,
      /** Keep the email, or un-keep it when already kept. */
      toggle: (entry) => set(s => ({ items: withToggled(s.items, entry, Date.now()) })),
      remove: (id) => set(s => ({ items: s.items.filter(item => keepId(item) !== id) })),
      removeSender: (key) => set(s => ({ items: withoutSender(s.items, key) })),
      // An invalid dock falls back to the default through the same validation as stored input.
      moveDock: (dock) => set({ dock: restoreKeep({ dock }).dock }),
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
