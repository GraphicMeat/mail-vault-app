// ── db/caches — mailbox cache, email header cache, Graph ID map persistence ──

import { send as transportSend } from '../transport.js';

// Transport-aware invoke: tries daemon socket first, falls back to Tauri invoke
const invoke = (cmd, args) => transportSend(cmd, args);

/**
 * Safely parse a response that may be a JSON string (from Tauri invoke)
 * or an already-parsed object (from daemon RPC via transport).
 */
function safeParse(data) {
  if (data == null) return null;
  if (typeof data === 'object') return data; // Already parsed (daemon response)
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return null; }
  }
  return null;
}

// ── Mailbox cache ─────────────────────────────────────────────────────────

export async function saveMailboxes(accountId, mailboxes) {
  if (invoke) {
    try {
      // If we're saving a non-empty mailbox tree, also snapshot it as last-known-good
      const now = Date.now();
      const entry = { mailboxes, fetchedAt: now };
      if (mailboxes && mailboxes.length > 0) {
        entry.lastKnownGoodMailboxes = mailboxes;
        entry.lastKnownGoodAt = now;
      } else {
        // Preserve existing last-known-good when saving empty
        const existing = await getCachedMailboxEntry(accountId);
        if (existing?.lastKnownGoodMailboxes) {
          entry.lastKnownGoodMailboxes = existing.lastKnownGoodMailboxes;
          entry.lastKnownGoodAt = existing.lastKnownGoodAt;
        }
      }
      const data = JSON.stringify(entry);
      await invoke('save_mailbox_cache', { accountId, data });
    } catch (error) {
      console.warn('[db.js] Failed to save mailbox cache:', error);
    }
  }
}

export async function getCachedMailboxEntry(accountId) {
  if (invoke) {
    try {
      const data = await invoke('load_mailbox_cache', { accountId });
      if (data) {
        const entry = safeParse(data);
        if (Array.isArray(entry)) {
          return { mailboxes: entry, fetchedAt: null, lastKnownGoodMailboxes: null, lastKnownGoodAt: null };
        }
        return {
          mailboxes: entry.mailboxes || null,
          fetchedAt: entry.fetchedAt ?? entry.lastSynced ?? null,
          lastKnownGoodMailboxes: entry.lastKnownGoodMailboxes || null,
          lastKnownGoodAt: entry.lastKnownGoodAt || null,
        };
      }
    } catch (error) {
      console.warn('[db.js] Failed to load mailbox cache:', error);
    }
  }
  return null;
}

export async function getCachedMailboxes(accountId) {
  const entry = await getCachedMailboxEntry(accountId);
  return entry?.mailboxes || null;
}

// ── Email header cache ───────────────────────────────────────────────────

export async function saveEmailHeaders(accountId, mailbox, emails, totalEmails, { uidValidity, uidNext, highestModseq, serverUids } = {}) {
  const cacheEntry = {
    accountId,
    mailbox,
    emails,
    totalEmails,
    uidValidity: uidValidity ?? null,
    uidNext: uidNext ?? null,
    highestModseq: highestModseq ?? null,
    serverUids: serverUids ? Array.from(serverUids) : undefined,
    lastSynced: Date.now()
  };

  // Track last-known-good email count for corruption detection
  if (emails && emails.length > 0) {
    cacheEntry.lastKnownGoodTotalEmails = totalEmails;
    cacheEntry.lastKnownGoodCount = emails.length;
    cacheEntry.lastKnownGoodAt = Date.now();
  } else {
    // Preserve existing last-known-good when saving empty headers
    try {
      const existingMeta = await getEmailHeadersMeta(accountId, mailbox);
      if (existingMeta?.lastKnownGoodTotalEmails) {
        cacheEntry.lastKnownGoodTotalEmails = existingMeta.lastKnownGoodTotalEmails;
        cacheEntry.lastKnownGoodCount = existingMeta.lastKnownGoodCount;
      }
    } catch { /* ignore — best effort */ }
  }

  if (invoke) {
    try {
      const data = JSON.stringify(cacheEntry);
      await invoke('save_email_cache', { accountId, mailbox, data });
      console.log('[db.js] Email headers saved to file cache:', emails.length, 'emails');
    } catch (error) {
      console.warn('[db.js] Failed to save to file cache:', error);
    }
  }

  return cacheEntry;
}

export async function getEmailHeadersPartial(accountId, mailbox, limit = 200) {
  if (invoke) {
    try {
      const data = await invoke('load_email_cache_partial', { accountId, mailbox, limit });
      if (data) {
        const entry = safeParse(data);
        console.log('[db.js] Partial email headers loaded:', entry.emails?.length, 'of', entry.totalCached, 'emails');
        return {
          emails: entry.emails,
          totalEmails: entry.totalEmails,
          totalCached: entry.totalCached,
          uidValidity: entry.uidValidity ?? null,
          uidNext: entry.uidNext ?? null,
          highestModseq: entry.highestModseq ?? null,
          serverUids: entry.serverUids ? new Set(entry.serverUids) : null,
          lastSynced: entry.lastSynced
        };
      }
    } catch (error) {
      console.warn('[db.js] Failed to load partial cache:', error);
    }
  }

  return null;
}

export async function getEmailHeadersMeta(accountId, mailbox) {
  if (invoke) {
    try {
      const data = await invoke('load_email_cache_meta', { accountId, mailbox });
      if (data) {
        const entry = safeParse(data);
        return {
          totalEmails: entry.totalEmails,
          totalCached: entry.totalCached ?? 0,
          uidValidity: entry.uidValidity ?? null,
          uidNext: entry.uidNext ?? null,
          highestModseq: entry.highestModseq ?? null,
          lastSynced: entry.lastSynced,
          lastKnownGoodTotalEmails: entry.lastKnownGoodTotalEmails ?? null,
          lastKnownGoodCount: entry.lastKnownGoodCount ?? null,
        };
      }
    } catch (error) {
      console.warn('[db.js] Failed to load cache meta:', error);
    }
  }
  return null;
}

export async function getEmailHeaders(accountId, mailbox) {
  if (invoke) {
    try {
      const data = await invoke('load_email_cache', { accountId, mailbox });
      if (data) {
        const entry = safeParse(data);
        console.log('[db.js] Email headers loaded from file cache:', entry.emails?.length, 'emails');
        return {
          emails: entry.emails,
          totalEmails: entry.totalEmails,
          uidValidity: entry.uidValidity ?? null,
          uidNext: entry.uidNext ?? null,
          highestModseq: entry.highestModseq ?? null,
          lastSynced: entry.lastSynced
        };
      }
    } catch (error) {
      console.warn('[db.js] Failed to load from file cache:', error);
    }
  }

  return null;
}

// ── Graph ID map persistence (UID → Graph message ID) ───────────────────

export async function saveGraphIdMap(accountId, mailbox, mapObj) {
  if (invoke) {
    try {
      const data = JSON.stringify(mapObj);
      await invoke('save_graph_id_map', { accountId, mailbox, data });
    } catch (error) {
      console.warn('[db.js] Failed to save graph ID map:', error);
    }
  }
}

export async function loadGraphIdMap(accountId, mailbox) {
  if (invoke) {
    try {
      const data = await invoke('load_graph_id_map', { accountId, mailbox });
      if (data) {
        return safeParse(data);
      }
    } catch (error) {
      console.warn('[db.js] Failed to load graph ID map:', error);
    }
  }
  return null;
}
