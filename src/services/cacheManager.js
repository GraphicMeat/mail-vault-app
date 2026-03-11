// ── LRU Caches & Graph ID Map ─────────────────────────────────────────────
// Pure data structures — no store dependency.
// Previously scattered as module-level state in mailStore.js.

// ── Mailbox LRU cache (max 2 entries) — instant mailbox switching ────
const _mailboxCache = new Map();
const MAILBOX_CACHE_MAX = 2;

export function saveToMailboxCache(accountId, mailbox, state) {
  const key = `${accountId}:${mailbox}`;
  _mailboxCache.set(key, {
    emails: state.emails,
    localEmails: state.localEmails,
    emailsByIndex: state.emailsByIndex,
    totalEmails: state.totalEmails,
    savedEmailIds: state.savedEmailIds,
    archivedEmailIds: state.archivedEmailIds,
    loadedRanges: state.loadedRanges,
    currentPage: state.currentPage,
    hasMoreEmails: state.hasMoreEmails,
    timestamp: Date.now(),
  });

  // LRU eviction
  if (_mailboxCache.size > MAILBOX_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _mailboxCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) _mailboxCache.delete(oldestKey);
  }
}

export function getFromMailboxCache(accountId, mailbox) {
  const key = `${accountId}:${mailbox}`;
  const cached = _mailboxCache.get(key);
  if (cached) {
    cached.timestamp = Date.now(); // Touch for LRU
  }
  return cached || null;
}

export function invalidateMailboxCache(accountId) {
  for (const key of _mailboxCache.keys()) {
    if (key.startsWith(`${accountId}:`)) {
      _mailboxCache.delete(key);
    }
  }
}

// ── Account LRU cache (max 8 entries) — instant account switching ────
const _accountCache = new Map();
const ACCOUNT_CACHE_MAX = 8;

export function saveToAccountCache(accountId, state) {
  _accountCache.set(accountId, {
    emails: state.emails,
    localEmails: state.localEmails,
    emailsByIndex: state.emailsByIndex,
    totalEmails: state.totalEmails,
    savedEmailIds: state.savedEmailIds,
    archivedEmailIds: state.archivedEmailIds,
    loadedRanges: state.loadedRanges,
    currentPage: state.currentPage,
    hasMoreEmails: state.hasMoreEmails,
    sentEmails: state.sentEmails,
    mailboxes: state.mailboxes,
    mailboxesFetchedAt: state.mailboxesFetchedAt ?? null,
    connectionStatus: state.connectionStatus,
    activeMailbox: state.activeMailbox,
    lastSyncTimestamp: Date.now(),
    timestamp: Date.now(),
  });

  // LRU eviction
  if (_accountCache.size > ACCOUNT_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of _accountCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) _accountCache.delete(oldestKey);
  }
}

export function getFromAccountCache(accountId) {
  const cached = _accountCache.get(accountId);
  if (cached) cached.timestamp = Date.now();
  return cached || null;
}

export function invalidateAccountCache(accountId) {
  _accountCache.delete(accountId);
}

export function getAccountCacheEntries() {
  return _accountCache;
}

// ── Graph ID map (UID → Graph message ID) ────
const _graphIdMap = new Map();

export function setGraphIdMap(accountId, mailbox, uidToGraphId) {
  _graphIdMap.set(`${accountId}:${mailbox}`, uidToGraphId);
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
