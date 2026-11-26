// Which account sections of the drawer are open, remembered between launches (localStorage; never
// fatal when it is missing).
import { readStorage, writeStorage } from '../store.js';

const KEY = 'mv.mobile.drawerOpen';

/** The ids of the open sections. */
export function readExpanded() {
  try {
    const ids = JSON.parse(readStorage(KEY) || '[]');
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeExpanded(ids) {
  writeStorage(KEY, ids.length ? JSON.stringify(ids) : null);
}
