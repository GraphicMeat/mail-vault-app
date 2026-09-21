import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';

// The durable key an assignment is stored under lives in the daemon
// (`app_db::identity::msg_key`) and is deliberately not mirrored here. This is
// only the render cache: what the rows currently on screen carry. It is
// refetched per page, so an unstable key costs nothing.
export function tagRowKey(accountId, mailbox, uid) {
  return `${accountId}|${mailbox}|${uid}`;
}

function rowKeyOf(email, location) {
  if (!email || email.uid == null) return null;
  if (!location?.accountId || !location?.mailbox || location.mailbox === 'UNIFIED') return null;
  return tagRowKey(location.accountId, location.mailbox, email.uid);
}

function itemOf(email, location) {
  const item = { accountId: location.accountId, mailbox: location.mailbox, uid: email.uid };
  if (email.messageId) item.messageId = email.messageId;
  return item;
}

/// Rows the caller handed over that can actually be keyed, with their items.
function resolve(rows) {
  return rows
    .map(({ email, location }) => ({ key: rowKeyOf(email, location), email, location }))
    .filter(row => row.key)
    .map(row => ({ ...row, item: itemOf(row.email, row.location) }));
}

function withTag(byRow, keys, tagId) {
  const next = { ...byRow };
  for (const key of keys) {
    const ids = next[key] || [];
    if (!ids.includes(tagId)) next[key] = [...ids, tagId];
  }
  return next;
}

function withoutTag(byRow, keys, tagId) {
  const next = { ...byRow };
  for (const key of keys) {
    const ids = (next[key] || []).filter(id => id !== tagId);
    if (ids.length) next[key] = ids;
    else delete next[key];
  }
  return next;
}

export const useTagStore = create((set, get) => ({
  tags: [],
  /// rowKey -> tag ids, for the rows currently rendered.
  byRow: {},

  tagIdsFor: (email, location) => {
    const key = rowKeyOf(email, location);
    return (key && get().byRow[key]) || [];
  },

  tagsFor: (email, location) => {
    const ids = get().tagIdsFor(email, location);
    return get().tags.filter(tag => ids.includes(tag.id));
  },

  loadTags: async () => {
    const tags = await daemonCall('tags.list', {});
    set({ tags: Array.isArray(tags) ? tags : [] });
    return get().tags;
  },

  createTag: async (name, color = '') => {
    const tag = await daemonCall('tags.ensure', { name, color });
    set(state => ({ tags: [...state.tags.filter(t => t.id !== tag.id), tag] }));
    return tag;
  },

  renameTag: async (id, name) => {
    await daemonCall('tags.rename', { id, name });
    set(state => ({ tags: state.tags.map(tag => (tag.id === id ? { ...tag, name } : tag)) }));
  },

  setTagColor: async (id, color) => {
    await daemonCall('tags.set_color', { id, color });
    set(state => ({ tags: state.tags.map(tag => (tag.id === id ? { ...tag, color } : tag)) }));
  },

  deleteTag: async (id) => {
    await daemonCall('tags.delete', { id });
    set(state => ({
      tags: state.tags.filter(tag => tag.id !== id),
      byRow: withoutTag(state.byRow, Object.keys(state.byRow), id),
    }));
  },

  /// Fill the render cache for one page of rows. The daemon answers one entry
  /// per requested row, in request order, so nothing here re-derives a key.
  loadRowTags: async (rows) => {
    const resolved = resolve(rows);
    if (!resolved.length) return;
    const reply = await daemonCall('tags.for_messages', { items: resolved.map(row => row.item) });
    const lists = Array.isArray(reply?.tags) ? reply.tags : [];
    set(state => {
      const byRow = { ...state.byRow };
      resolved.forEach((row, index) => {
        const ids = lists[index] || [];
        if (ids.length) byRow[row.key] = ids;
        else delete byRow[row.key];
      });
      return { byRow };
    });
  },

  applyTag: (email, location, tagId) => get().applyTagToRows([{ email, location }], tagId),

  removeTag: async (email, location, tagId) => {
    const resolved = resolve([{ email, location }]);
    if (!resolved.length) return false;
    const keys = resolved.map(row => row.key);
    const before = get().byRow;
    set(state => ({ byRow: withoutTag(state.byRow, keys, tagId) }));
    try {
      await daemonCall('tags.unassign', { tagId, items: resolved.map(row => row.item) });
      await get().refreshCounts();
      return true;
    } catch {
      set({ byRow: before });
      return false;
    }
  },

  /// Tag a whole selection in one call. The chips appear immediately and go
  /// back if the daemon refuses.
  applyTagToRows: async (rows, tagId) => {
    const resolved = resolve(rows);
    if (!resolved.length) return false;
    const keys = resolved.map(row => row.key);
    const before = get().byRow;
    set(state => ({ byRow: withTag(state.byRow, keys, tagId) }));
    try {
      await daemonCall('tags.assign', { tagId, items: resolved.map(row => row.item) });
      await get().refreshCounts();
      return true;
    } catch {
      set({ byRow: before });
      return false;
    }
  },

  removeTagFromRows: async (rows, tagId) => {
    const resolved = resolve(rows);
    if (!resolved.length) return false;
    const keys = resolved.map(row => row.key);
    const before = get().byRow;
    set(state => ({ byRow: withoutTag(state.byRow, keys, tagId) }));
    try {
      await daemonCall('tags.unassign', { tagId, items: resolved.map(row => row.item) });
      await get().refreshCounts();
      return true;
    } catch {
      set({ byRow: before });
      return false;
    }
  },

  /// The per-tag counts the manager shows are the daemon's, never derived from
  /// the render cache: that cache only holds the rows on screen.
  refreshCounts: async () => {
    try {
      await get().loadTags();
    } catch {
      // A count that failed to refresh is not worth failing the tagging over.
    }
  },
}));

// One request per row would mean one daemon call per chip: the chips render in
// eight places (list rows, thread rows, the reader, the full-view modal, ...)
// and no single one of them owns "the page". Collect what this tick asked for
// and make one call.
let pendingRows = new Map();
let pendingTimer = null;

async function flushRowTags() {
  pendingTimer = null;
  const rows = [...pendingRows.values()];
  pendingRows = new Map();
  if (!rows.length) return;
  try {
    await useTagStore.getState().loadRowTags(rows);
  } catch {
    // A page whose chips could not load renders without them.
  }
}

/// Ask for a row's tags, unless the render cache already holds it.
export function requestRowTags(email, location) {
  const key = rowKeyOf(email, location);
  if (!key || useTagStore.getState().byRow[key] || pendingRows.has(key)) return;
  pendingRows.set(key, { email, location });
  if (!pendingTimer) pendingTimer = setTimeout(flushRowTags, 0);
}
