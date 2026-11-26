// The multi-select's state: whether the list is selecting, and the rows ticked, each with where it
// lives (`place`, store.placeOf) so a selection can span accounts in All Inboxes. A row is a
// conversation's row as the list shows it; its messages are `rowUids(row)`. Toggling and Select
// all tick the haptics (selection); the rest of the module reads this store.
import { create } from 'zustand';
import { haptic } from '../haptics.js';
import { rowUids } from '../prefs.js';

const NUL = '\u0000';
/** A row's key: its account, folder and uid. */
export const selectionKey = (place, uid) => `${place.accountId}${NUL}${place.folder}${NUL}${uid}`;

export const useSelection = create((set, get) => ({
  active: false,
  /** key -> { row, place } */
  items: new Map(),

  /** Starts selecting, with `entries` (`[{ row, place }]`) ticked. */
  begin(entries = []) {
    set({ active: true, items: new Map(entries.map((e) => [selectionKey(e.place, e.row.uid), e])) });
    if (entries.length) haptic.selection();
  },

  /** Leaves selecting and forgets every tick. */
  end() {
    if (!get().active && !get().items.size) return;
    set({ active: false, items: new Map() });
  },

  /** Ticks or unticks one row. */
  toggle(entry) {
    const items = new Map(get().items);
    const key = selectionKey(entry.place, entry.row.uid);
    if (items.has(key)) items.delete(key);
    else items.set(key, entry);
    set({ items });
    haptic.selection();
  },

  /** Ticks (`on`) or unticks `entries`: a sweep over rows. One tick of feedback when anything changed. */
  setMany(entries, on) {
    const items = new Map(get().items);
    let changed = false;
    for (const entry of entries) {
      const key = selectionKey(entry.place, entry.row.uid);
      if (on && !items.has(key)) { items.set(key, entry); changed = true; }
      if (!on && items.delete(key)) changed = true;
    }
    if (!changed) return;
    set({ items });
    haptic.selection();
  },

  /** Ticks every one of `entries` (the rows the list has loaded). */
  selectAll(entries) {
    get().setMany(entries, true);
  },

  /** Changes the ticked rows' own flags after an action that changed them, so the bar reads true. */
  patch(change) {
    const items = new Map();
    for (const [key, entry] of get().items) items.set(key, { ...entry, row: change(entry.row) });
    set({ items });
  },
}));

/** Whether `row` (at `place`) is ticked. */
export const useTicked = (place, row) => useSelection((s) => s.items.has(selectionKey(place, row.uid)));

/** The messages the ticked rows stand for, grouped by where they live: `[{ accountId, folder, uids }]`. */
export function bulkGroups(items, keepRow = () => true) {
  const groups = new Map();
  for (const { row, place } of items.values()) {
    if (!keepRow(row)) continue;
    const key = `${place.accountId}${NUL}${place.folder}`;
    const g = groups.get(key) || { accountId: place.accountId, folder: place.folder, uids: [] };
    for (const uid of rowUids(row)) if (!g.uids.includes(uid)) g.uids.push(uid);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** How many messages the groups hold. */
export const bulkCount = (groups) => groups.reduce((n, g) => n + g.uids.length, 0);
