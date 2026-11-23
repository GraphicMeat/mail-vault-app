import { create } from 'zustand';
import { readStorage, writeStorage } from './store';
import { DEFAULT_DOCK, restoreKeep, withToggled, withoutSender, keepId } from '../shared/keep';

// "Keep in bubble" on the phone: same rules as the desktop (shared/keep), kept
// in localStorage like the recent searches. Per device, not synced.
const STORAGE_KEY = 'mailvault-keep';

function readKept() {
  try {
    return restoreKeep(JSON.parse(readStorage(STORAGE_KEY)));
  } catch {
    return restoreKeep(null);
  }
}

export const useKeepStore = create((set) => ({
  ...readKept(),
  toggle: (entry) => set(s => ({ items: withToggled(s.items, entry, Date.now()) })),
  remove: (id) => set(s => ({ items: s.items.filter(item => keepId(item) !== id) })),
  removeSender: (key) => set(s => ({ items: withoutSender(s.items, key) })),
  moveDock: (dock) => set({ dock: restoreKeep({ dock }).dock }),
}));

useKeepStore.subscribe(({ items, dock }) => writeStorage(STORAGE_KEY, JSON.stringify({ items, dock })));
export { DEFAULT_DOCK };
