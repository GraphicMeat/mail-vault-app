// ── The one registry of every place a message row lives ──
//
// One message can sit in `emails`, `localEmails`, `sentEmails`, the open
// reader and its thread, the body cache, a search's rows and a Notes card. A
// writer that changes a row (a flag, the star, a verdict) and patches the
// containers it happens to remember leaves the rest showing the old value,
// and a reader that resolves a key against the containers it happens to
// remember does not find the row. This file is the only list of them.
//
//   registerRows(container)   each store registers the containers it holds,
//                             once, where it is created — a container nobody
//                             registered is one no writer reaches
//   patchEverywhere(...)      the ONLY way a writer changes a row's flags,
//                             star, tags or verdicts
//   resolvePool(state)        the ordered candidate rows, for every key
//                             resolver and every read of the state a row has
//                             right now
//   paintFlags(rows)          a loader's flags (header cache, a committed list)
//                             laid over every container's copy of those rows
//   paintMovedFlags(rows, list)  the same for a reread of a whole list's flags:
//                             only the rows that differ from the list, or that a
//                             container outside the list holds
//
// A container is `{ name, store, fields, mapRows?, rows?, held?, rank?, derived? }`,
// or, for a snapshot of rows that lives outside any store, `{ name, invalidate }`:
//   fields   the store fields it holds (the guard spec lists every collection
//            a store has and asks that each is registered or exempted)
//   mapRows  (state, ctx) -> a partial state, or null when nothing changed.
//            Pure over `state`; `ctx.hit(row)` says which row of `keys` this
//            is, `ctx.mapRow(row, key)` returns the row itself when nothing
//            about it changes. Containers of one store are merged and land
//            in ONE setState: `emails` runs to five figures, and a click must
//            not pay a render per container.
//   rows     (state) -> the rows a key can be resolved against
//   rank     where its rows sit in the pool; the lowest wins a key both hold
//   held     (state) -> the few rows it keeps outside the lists (the reader, the
//            open thread, a search's hits, the body cache, a Notes card's
//            copies). A reread of every list row's flags repaints these even
//            when the list's own copy is current.
//   derived  a projection of another container (`sortedEmails`): a writer
//            that re-derives the list afterwards passes `skipDerived`
//   invalidate  (ctx) -> void, for a cache of rows a store does not hold (the
//            restore descriptors, the unified folder cache, the header memo):
//            they paint a list before any read, and a row left stale in one
//            comes back on screen. Called once per write, after the stores
//            landed, and it runs on the click path: it marks or patches the
//            entries the write touches by key (`ctx.keys`, `ctx.touches`) and
//            never scans a list or reads disk. `ctx.landed` is the set of
//            stores this write changed. Not called for an `only` paint.
//
// This module imports no store, so every store can import it.

import { emailScopeKey } from './slices/unifiedHelpers';

const containers = new Map();
let mailStore = null;

/// `store` is a zustand store; the mail store is the one a row's location is
/// read against (an unstamped row is the view's), so it is registered as such.
export function registerRows(container) {
  containers.set(container.name, container);
}

export function unregisterRows(name) {
  containers.delete(name);
}

/// The store `emailScopeKey` reads its view from.
export function setIdentityStore(store) {
  mailStore = store;
}

/// Every store field a registered container holds, by store.
export function registeredFields(store) {
  const fields = new Set();
  for (const container of containers.values()) {
    if (container.store === store) for (const field of container.fields || []) fields.add(field);
  }
  return fields;
}

export function registeredContainers() {
  return [...containers.values()];
}

/// The candidate rows of `state` (the mail store's), best copy first: the
/// lists in view, then the reader's copy, then whatever else registered rows
/// (a search's hits, which no list holds). Take the first row per key.
export function resolvePool(state = mailStore?.getState()) {
  const pool = [];
  const ranked = [...containers.values()].filter(container => container.rows)
    .sort((a, b) => (a.rank ?? 100) - (b.rank ?? 100));
  for (const container of ranked) {
    const own = container.store === mailStore ? state : container.store.getState();
    for (const row of container.rows(own) || []) if (row) pool.push(row);
  }
  return pool;
}

/// `rows` as a Map from `keyOf(row)`, the first row of a key winning.
export function indexRows(rows, keyOf) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return byKey;
}

/// The location a snapshot's rows sit in, for `mapList(rows, ctx, at)`: a row
/// that names no account or folder is the snapshot's own.
export function locationState(accountId, mailbox) {
  return { activeAccountId: accountId, activeMailbox: mailbox };
}

/// A list with `ctx.mapRow` applied to its rows of `keys`: the array itself
/// when no row changed (updateSortedEmails memoises on it), else a copy. `at`
/// places rows that name no location (see `locationState`); without it they are
/// the view's.
export function mapList(rows, ctx, at = null) {
  if (!rows?.length) return rows;
  let out = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = at ? ctx.hitAt(row, at) : ctx.hit(row);
    if (key === null) continue;
    const next = ctx.mapRow(row, key);
    if (next !== row) {
      out ??= rows.slice();
      out[i] = next;
    }
  }
  return out ?? rows;
}

/**
 * Change the rows of `keys` (`accountId-mailbox-uid`, the mail store's
 * `emailScopeKey`) in every registered container. `mapRow(row, key)` returns
 * the row itself when nothing about it changes.
 *
 * One pass per container, uid first (a five-figure list is scanned by a Set
 * lookup on a number), and one setState per store. `only` names the one
 * container an optimistic paint is for (a Notes card painted before the
 * flag core lands the change everywhere else).
 */
export function patchEverywhere(keys, mapRow, { skipDerived = false, only = null } = {}) {
  const wanted = new Set(keys);
  if (!wanted.size) return;
  const mail = mailStore?.getState();
  // A uid is the tail of the key; nothing else in a key can end in one. A
  // negative one (a sample row) reads as a dash before the tail.
  const uids = new Set();
  for (const key of wanted) {
    const at = key.lastIndexOf('-');
    const tails = [key.slice(at + 1)];
    if (at > 0 && key[at - 1] === '-') tails.push(key.slice(at));
    for (const uid of tails) {
      uids.add(uid);
      if (/^-?\d+$/.test(uid)) uids.add(Number(uid));
    }
  }
  const ctx = {
    keys: wanted,
    mapRow,
    landed: new Set(),
    hit: (row) => {
      if (!row || !uids.has(row.uid)) return null;
      const key = emailScopeKey(row, mail);
      return key !== null && wanted.has(key) ? key : null;
    },
    // A row of a snapshot placed by the snapshot's own location (see
    // `locationState`) rather than the view on screen: a descriptor's rows carry
    // no account or folder, the descriptor does.
    hitAt: (row, at) => {
      if (!row || !uids.has(row.uid)) return null;
      const key = emailScopeKey(row, at);
      return key !== null && wanted.has(key) ? key : null;
    },
    // Whether the write names any message of this folder.
    touches: (accountId, mailbox) => {
      const prefix = `${accountId}-${mailbox}-`;
      for (const key of wanted) if (key.startsWith(prefix)) return true;
      return false;
    },
  };
  const patches = new Map();
  for (const container of containers.values()) {
    if (!container.mapRows || (skipDerived && container.derived) || (only && container.name !== only)) continue;
    const patch = container.mapRows(container.store.getState(), ctx);
    if (patch) patches.set(container.store, { ...patches.get(container.store), ...patch });
  }
  for (const [store, patch] of patches) {
    store.setState(patch);
    ctx.landed.add(store);
  }
  // A skipped derived list is the writer's to re-derive; a snapshot outside
  // the store is nobody's but the registry's.
  if (only) return;
  for (const container of containers.values()) container.invalidate?.(ctx);
}

/// A loader read these rows' flags from somewhere that is right about them (the
/// header cache after the daemon synced another device's change, the list a
/// reload just committed). Lay those flags over every container's copy of each
/// row: the list took them and the reader, the open thread, the body cache and a
/// search hit did not. Rows match by message key, never by bare uid. Returns
/// whether any container changed, so the caller knows to re-derive its lists.
const sameFlags = (a, b) => {
  const x = a || [];
  const y = b || [];
  return x.length === y.length && x.every(f => y.includes(f));
};

/// The uids of the rows the containers keep outside the lists (`held`).
function heldUids() {
  const uids = new Set();
  for (const container of containers.values()) {
    if (!container.held) continue;
    for (const row of container.held(container.store.getState()) || []) if (row) uids.add(row.uid);
  }
  return uids;
}

/// `paintFlags` for a reread of the flags of every row a list holds (the daemon
/// synced a change, and the echo of the user's own STORE is the common case): a
/// five-figure list must not be keyed and scanned for the few rows that moved.
/// Paints the rows whose flags differ from the list's copy, and the rows a
/// container outside the list holds (the reader may be stale while the list is
/// current). `listRows` is the list the `rows` were read for.
export function paintMovedFlags(rows, listRows) {
  const inList = new Map();
  for (const row of listRows) if (!inList.has(row.uid)) inList.set(row.uid, row.flags);
  const held = heldUids();
  return paintFlags(rows.filter(row => row && (held.has(row.uid) || !inList.has(row.uid) || !sameFlags(inList.get(row.uid), row.flags))));
}

export function paintFlags(rows) {
  const mail = mailStore?.getState();
  const flagsByKey = new Map();
  for (const row of rows) {
    const key = row && emailScopeKey(row, mail);
    if (key !== null && !flagsByKey.has(key)) flagsByKey.set(key, row.flags || []);
  }
  let changed = false;
  patchEverywhere([...flagsByKey.keys()], (row, key) => {
    const flags = flagsByKey.get(key);
    const was = row.flags || [];
    if (sameFlags(was, flags)) return row;
    changed = true;
    return { ...row, flags };
  }, { skipDerived: true });
  return changed;
}
