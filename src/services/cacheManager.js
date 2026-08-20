// ── Lightweight Restore Cache & Graph ID Map ──────────────────────────────
// Stores compact RestoreDescriptors for instant first-window render on switch.
// No heavyweight state blobs — store is the sole owner of list data.

// ── Restore descriptor cache (max 8 entries) ──────────────────────────────
const _descriptorCache = new Map();
const DESCRIPTOR_CACHE_MAX = 8;

function _descriptorKey(accountId, mailbox, viewMode) {
  return `${accountId}:${mailbox}:${viewMode}`;
}

export function saveRestoreDescriptor(descriptor) {
  const key = _descriptorKey(descriptor.accountId, descriptor.mailbox, descriptor.viewMode);
  const now = Date.now();
  // timestamp = creation time (immutable, for stale-age checks)
  // _lruTimestamp = last access time (mutable, for LRU eviction ordering)
  _descriptorCache.set(key, { ...descriptor, timestamp: now, _lruTimestamp: now });

  // LRU eviction
  while (_descriptorCache.size > DESCRIPTOR_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _descriptorCache) {
      if (v._lruTimestamp < oldestTime) { oldestTime = v._lruTimestamp; oldestKey = k; }
    }
    if (oldestKey) _descriptorCache.delete(oldestKey);
    else break;
  }
}

export function getRestoreDescriptor(accountId, mailbox, viewMode) {
  const key = _descriptorKey(accountId, mailbox, viewMode);
  const cached = _descriptorCache.get(key);
  if (cached) cached._lruTimestamp = Date.now(); // LRU touch — does not affect timestamp
  return cached || null;
}

export function invalidateRestoreDescriptors(accountId) {
  for (const key of _descriptorCache.keys()) {
    if (key.startsWith(`${accountId}:`)) {
      _descriptorCache.delete(key);
    }
  }
}

/**
 * Returns the mailbox tree from the most recent descriptor for an account.
 * Used by sidebar and unified inbox to access cached mailbox metadata
 * without storing a separate heavyweight account snapshot.
 */
export function getAccountCacheMailboxes(accountId) {
  let newest = null;
  let newestTime = 0;
  for (const [key, desc] of _descriptorCache) {
    if (key.startsWith(`${accountId}:`) && desc.timestamp > newestTime) {
      newest = desc;
      newestTime = desc.timestamp;
    }
  }
  return newest?.mailboxes || null;
}

// ── Graph ID map (UID → Graph message ID) ────
const _graphIdMap = new Map();

// When each `accountId:mailbox` last paid for a relist, so a loop over many
// uids cannot pay for one each.
const _graphIdRebuiltAt = new Map();
const GRAPH_REBUILD_COOLDOWN_MS = 30_000;

export function setGraphIdMap(accountId, mailbox, uidToGraphId) {
  _graphIdMap.set(`${accountId}:${mailbox}`, uidToGraphId);
  import('./db.js').then(db => {
    const obj = Object.fromEntries(uidToGraphId);
    db.saveGraphIdMap(accountId, mailbox, obj)
      .catch(e => console.warn('[graphIdMap] Failed to persist:', e));
  }).catch(() => {});
}

export function getGraphMessageId(accountId, mailbox, uid) {
  const map = _graphIdMap.get(`${accountId}:${mailbox}`);
  return map?.get(uid) || null;
}

/**
 * The Graph message id for a row, in decreasing order of trust.
 *
 * A Graph "UID" is not an identifier: `graph_list_messages` hands out the
 * message's 1-based POSITION in the folder listing (commands.rs), so every
 * arrival or deletion renumbers the whole mailbox. The map below is that
 * numbering frozen at the last list call and persisted to disk, which makes a
 * uid lookup wrong exactly when the folder has changed since — and a wrong
 * lookup on a delete path spends the user's intent on somebody else's message.
 *
 * `row._graphId` is stamped onto the header from the same response that
 * assigned its position (loadEmails / activateAccount), so header and id
 * cannot disagree. Prefer it. Fall back to the map, and when that misses,
 * relist the folder rather than guessing — the same recovery selectEmail has
 * always done for bodies, now shared with the mutation paths.
 *
 * Returns null when the id cannot be established. Callers must treat null as a
 * failure: doing the operation anyway is how a delete reports success while
 * the message stays on the server.
 */
export async function resolveGraphMessageId(accountId, mailbox, uid, { row, token } = {}) {
  if (row?._graphId) return row._graphId;

  const known = getGraphMessageId(accountId, mailbox, uid);
  if (known) return known;
  if (!token) return null;

  // One relist per folder, not per message. A bulk delete walks its uids in a
  // loop, and a uid genuinely absent from the folder misses the refreshed map
  // as surely as it missed the stale one — without this, 500 selected messages
  // against an emptied folder is 500 round trips.
  const rebuildKey = `${accountId}:${mailbox}`;
  const lastRebuild = _graphIdRebuiltAt.get(rebuildKey) || 0;
  if (Date.now() - lastRebuild < GRAPH_REBUILD_COOLDOWN_MS) return null;
  _graphIdRebuiltAt.set(rebuildKey, Date.now());

  try {
    const [api, { normalizeGraphFolderName }] = await Promise.all([
      import('./api.js'),
      import('./graphConfig.js'),
    ]);
    const folders = await api.graphListFolders(token);
    const folder = folders.find(f => {
      const normalized = normalizeGraphFolderName(f.displayName);
      return normalized === mailbox || f.displayName === mailbox;
    });
    if (!folder) return null;

    const { headers, graphMessageIds } = await api.graphListMessages(token, folder.id, 200, 0);
    const uidMap = new Map();
    headers.forEach((h, i) => uidMap.set(h.uid, graphMessageIds[i]));
    setGraphIdMap(accountId, mailbox, uidMap);
    return uidMap.get(uid) || null;
  } catch (e) {
    console.warn('[graphIdMap] Rebuild failed for %s:%s', accountId, mailbox, e);
    return null;
  }
}

export function clearGraphIdMap(accountId) {
  for (const key of _graphIdMap.keys()) {
    if (key.startsWith(`${accountId}:`)) {
      _graphIdMap.delete(key);
    }
  }
}

/**
 * Restore a persisted Graph ID map from disk into the in-memory cache.
 * Called during Graph account init before message fetching.
 */
export async function restoreGraphIdMap(accountId, mailbox) {
  const key = `${accountId}:${mailbox}`;
  if (_graphIdMap.has(key)) return;
  try {
    const db = await import('./db.js');
    const saved = await db.loadGraphIdMap(accountId, mailbox);
    if (saved && typeof saved === 'object') {
      const map = new Map();
      for (const [uid, graphId] of Object.entries(saved)) {
        map.set(Number(uid), graphId);
      }
      _graphIdMap.set(key, map);
      console.log('[graphIdMap] Restored %d entries for %s:%s', map.size, accountId, mailbox);
    }
  } catch (e) {
    console.warn('[graphIdMap] Failed to restore from disk:', e);
  }
}
