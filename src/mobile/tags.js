// The phone's tags (desktop's MailVault tags, kept by the engine: `mobile.tags.*`, engine
// `tags.rs`). This is only the render cache, like desktop's tagStore: the tag list and the tags of
// the rows on screen, keyed `account|folder|uid`. The key an assignment is stored under is the
// engine's and never computed here.
//
// Rows ask for their tags in one batched `mobile.tags.forMessages` per tick (`requestRowTags`),
// and only once the phone has a tag at all: with none, no row asks. The list loads once at launch
// (`ensureTags`, also on opening the label sheet or Quick actions), and again after every change.
// A tag change shows at once and goes back if the engine refuses it.
import { useEffect } from 'react';
import { create } from 'zustand';
import { daemonCall } from './transport.js';

/** One row's place in the render cache. */
export function rowKey(accountId, folder, uid) {
  return `${accountId}|${folder}|${uid}`;
}

const EMPTY = Object.freeze([]);

function withTag(byRow, keys, tagId) {
  const next = { ...byRow };
  for (const key of keys) {
    const ids = next[key] || EMPTY;
    if (!ids.includes(tagId)) next[key] = [...ids, tagId];
  }
  return next;
}

function withoutTag(byRow, keys, tagId) {
  const next = { ...byRow };
  for (const key of keys) next[key] = (next[key] || EMPTY).filter((id) => id !== tagId);
  return next;
}

const item = (r) => ({ accountId: r.accountId, folder: r.folder, uid: r.uid });

export const useTagStore = create((set, get) => ({
  tags: [],
  /** rowKey -> tag ids, for the rows asked about. */
  byRow: {},

  setTags: (tags) => set({ tags: Array.isArray(tags) ? tags : [] }),

  loadTags: async () => {
    const reply = await daemonCall('mobile.tags.list', {});
    get().setTags(reply?.tags);
    return get().tags;
  },

  /** Make a tag (or find the one of that name): its id, or null when the engine refused. */
  createTag: async (name, color = '') => {
    try {
      const reply = await daemonCall('mobile.tags.create', { name, color });
      get().setTags(reply?.tags);
      return reply?.tag?.id || null;
    } catch {
      return null;
    }
  },

  deleteTag: async (id) => {
    const before = get();
    set({
      tags: before.tags.filter((tag) => tag.id !== id),
      byRow: Object.fromEntries(Object.entries(before.byRow).map(([k, ids]) => [k, ids.filter((x) => x !== id)])),
    });
    try {
      const reply = await daemonCall('mobile.tags.delete', { id });
      get().setTags(reply?.tags);
      return true;
    } catch {
      set({ tags: before.tags, byRow: before.byRow });
      return false;
    }
  },

  /** Tag (`on`) or untag the rows `[{ accountId, folder, uid }]`. */
  setOnRows: async (rows, tagId, on) => {
    const keys = rows.map((r) => rowKey(r.accountId, r.folder, r.uid));
    const before = get().byRow;
    set({ byRow: on ? withTag(before, keys, tagId) : withoutTag(before, keys, tagId) });
    try {
      if (on) await daemonCall('mobile.tags.assign', { tagId, items: rows.map(item) });
      else await daemonCall('mobile.tags.unassign', { tagId, items: rows.map(item) });
    } catch {
      set({ byRow: before });
      return false;
    }
    // The counts the manage list shows are the engine's.
    get().loadTags().catch(() => {});
    return true;
  },

  /** Fill the cache for these rows (one call). */
  loadRows: async (rows) => {
    if (!rows.length) return;
    const reply = await daemonCall('mobile.tags.forMessages', { items: rows.map(item) });
    const lists = Array.isArray(reply?.tags) ? reply.tags : [];
    set((state) => {
      const byRow = { ...state.byRow };
      // An untagged row is recorded as empty, so it is not asked about again.
      rows.forEach((r, i) => { byRow[rowKey(r.accountId, r.folder, r.uid)] = Array.isArray(lists[i]) ? lists[i] : EMPTY; });
      return { byRow };
    });
  },
}));

let loading = null;

/** Loads the tag list once (a failure leaves the phone without tags until the next change). */
export function ensureTags() {
  if (!loading) loading = useTagStore.getState().loadTags().catch(() => []);
  return loading;
}

/** After an import brought tags: the list again, and every row's chips asked for again. */
export function refreshTags() {
  useTagStore.setState({ byRow: {} });
  loading = useTagStore.getState().loadTags().catch(() => []);
  return loading;
}

let pending = new Map();
let timer = null;

async function flush() {
  timer = null;
  const rows = [...pending.values()];
  pending = new Map();
  try {
    await useTagStore.getState().loadRows(rows);
  } catch {
    // A page whose chips could not load renders without them.
  }
}

/** Ask for a row's tags, unless the cache holds them or the phone has no tag. */
export function requestRowTags(accountId, folder, uid) {
  if (!accountId || !folder || uid == null) return;
  const state = useTagStore.getState();
  const key = rowKey(accountId, folder, uid);
  if (!state.tags.length || state.byRow[key] || pending.has(key)) return;
  pending.set(key, { accountId, folder, uid });
  if (!timer) timer = setTimeout(flush, 0);
}

/**
 * The tags (`{ id, name, color }`) a row carries, in display order (empty for none). Asks for the
 * row's tags whenever the phone has tags and the cache does not hold the row's (the first render,
 * a tag list that just arrived, a cache emptied by an import). The list itself loads once, at
 * launch (App.jsx `ensureTags`).
 */
export function useRowTags(accountId, folder, uid) {
  const key = rowKey(accountId, folder, uid);
  const ids = useTagStore((s) => s.byRow[key] || EMPTY);
  const cached = useTagStore((s) => key in s.byRow);
  const tags = useTagStore((s) => s.tags);
  const hasTags = tags.length > 0;
  useEffect(() => {
    if (hasTags && !cached) requestRowTags(accountId, folder, uid);
  }, [hasTags, cached, accountId, folder, uid]);
  if (!ids.length || !hasTags) return EMPTY;
  return tags.filter((tag) => ids.includes(tag.id));
}

/** Tests: back to a phone that has asked for nothing. */
export function resetTagsForTests() {
  loading = null;
  pending = new Map();
  if (timer) clearTimeout(timer);
  timer = null;
  useTagStore.setState({ tags: [], byRow: {} });
}
