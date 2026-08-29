import { t } from '../i18n/index.js';
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

// ── Graph UID allocation (UID ↔ Graph message ID) ────
//
// A Graph message has no UID. `graph_list_messages` hands out the message's
// 1-based POSITION in a `receivedDateTime desc` listing (commands.rs), so one
// arrival renumbers the whole folder — while the header sidecar, this map and
// the vault Maildir each hold one of those numberings frozen at a different
// moment. That is how one message's body came to be filed under another's
// number: cur/7:2,.eml and cur/6:2,.eml hold the same message, written either
// side of the day a new mail shifted every position.
//
// So MailVault mints the uid instead of deriving it, the way an IMAP server
// does: the first sight of a Graph id takes the next number and keeps it for
// good. The map below is that allocation ledger, not a cache of the last
// listing.
//
// It is never pruned by absence. Graph pages the newest 200, so everything
// below that window reads as "not in this listing" whether it was deleted or
// merely not asked for — and re-allocating a message we forgot is exactly how
// a second vault copy appears under a second number.
const _graphIdMap = new Map();

// When each `accountId:mailbox` last paid for a relist, so a loop over many
// uids cannot pay for one each.
const _graphIdRebuiltAt = new Map();
const GRAPH_REBUILD_COOLDOWN_MS = 30_000;

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

    await listGraphMessages(accountId, mailbox, token, folder.id);
    return getGraphMessageId(accountId, mailbox, uid);
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
  const db = await import('./db.js');
  // Not caught. A ledger that exists but cannot be read is not the same as no
  // ledger: treating the read failure as "no allocations yet" hands uid 1 to
  // today's newest message and files its body over whatever already owns that
  // number. Failing the load is recoverable; renumbering the vault is not.
  const saved = await db.loadGraphIdMap(accountId, mailbox);
  if (saved && typeof saved === 'object') {
    const map = new Map();
    for (const [uid, graphId] of Object.entries(saved)) {
      map.set(Number(uid), graphId);
    }
    _graphIdMap.set(key, map);
    console.log('[graphIdMap] Restored %d entries for %s:%s', map.size, accountId, mailbox);
  }
}

/**
 * List a Graph folder and give every header a uid that will still name the
 * same message next week.
 *
 * The only supported way for app code to read a Graph listing — `headers[i].uid`
 * straight off `api.graphListMessages` is a position, and a position is not a
 * name. Callers that persist by uid (the sidecar cache, the vault Maildir, the
 * saved/archived sets) must go through here or they file today's mail under
 * yesterday's numbers.
 */
export async function listGraphMessages(accountId, mailbox, token, folderId, { top = 200, skip = 0 } = {}) {
  const api = await import('./api.js');
  const result = await api.graphListMessages(token, folderId, top, skip);
  const headers = await _allocateGraphUids(
    accountId, mailbox, result.headers || [], result.graphMessageIds || []
  );
  return { ...result, headers };
}

/**
 * Stamp each header with its allocated uid and its Graph id, allocating fresh
 * numbers for ids this mailbox has never seen. Mutates and returns `headers`.
 */
async function _allocateGraphUids(accountId, mailbox, headers, graphMessageIds) {
  if (headers.length !== graphMessageIds.length) {
    // The two arrays are the same Vec walked twice in commands.rs, so a length
    // mismatch means the response is not what it claims. Pairing them anyway
    // gives every row a confidently wrong id, and a delete would spend the
    // user's intent on someone else's message.
    throw new Error(
      `[graphIdMap] ${accountId}:${mailbox} listing returned ${headers.length} headers `
      + `and ${graphMessageIds.length} ids — refusing to pair them by position`
    );
  }
  if (headers.length === 0) return headers;

  await restoreGraphIdMap(accountId, mailbox);

  const key = `${accountId}:${mailbox}`;
  const ledger = _graphIdMap.get(key) || new Map();
  const uidByGraphId = new Map();
  let nextUid = 0;
  for (const [uid, graphId] of ledger) {
    uidByGraphId.set(graphId, uid);
    if (uid > nextUid) nextUid = uid;
  }

  const fresh = [];
  headers.forEach((header, i) => {
    const graphId = graphMessageIds[i];
    let uid = uidByGraphId.get(graphId);
    if (uid === undefined) {
      uid = ++nextUid;
      uidByGraphId.set(graphId, uid);
      fresh.push([uid, graphId]);
    }
    header.uid = uid;
    header.seq = uid;
    // Self-describing row: the sidecar cache stores headers verbatim, so a
    // paint restored from disk carries its own id and never has to ask the
    // ledger for it.
    header._graphId = graphId;
  });

  // A repeat listing of mail we already know allocates nothing and writes
  // nothing — the steady state costs no disk at all.
  if (fresh.length === 0) return headers;

  // Persist before committing to memory, never after. A uid that is live in
  // this session but absent from disk is handed out again next launch, to a
  // different message — the corruption this ledger exists to prevent. On a
  // failed write the old ledger stays in place untouched and the caller gets
  // the error, so the retry re-reads disk and allocates from the truth.
  const grown = new Map(ledger);
  for (const [uid, graphId] of fresh) grown.set(uid, graphId);

  const db = await import('./db.js');
  await db.saveGraphIdMap(accountId, mailbox, Object.fromEntries(grown));

  _graphIdMap.set(key, grown);
  console.log('[graphIdMap] Allocated %d new uids for %s:%s (%d total)',
    fresh.length, accountId, mailbox, grown.size);

  return headers;
}
