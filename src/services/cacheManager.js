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
