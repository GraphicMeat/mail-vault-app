import { create } from 'zustand';
import { readStorage, writeStorage } from './store';
import { restoreKeep, keepActions } from '../shared/keep';

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
  ...keepActions(set, () => Date.now()),
}));

useKeepStore.subscribe(({ items, dock }) => writeStorage(STORAGE_KEY, JSON.stringify({ items, dock })));
