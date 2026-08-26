// ── db/emails — Maildir email storage, local/archived reads, search, storage stats ──

import { readDir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { send as transportSend } from '../transport.js';
import { initDB, initBasic, accountDir } from './accounts.js';
import { mailboxPathFromVaultDir } from '../../stores/slices/unifiedHelpers.js';
import { normalizeMessageId } from '../../utils/emailParser.js';

// Transport-aware invoke: tries daemon socket first, falls back to Tauri invoke
const invoke = (cmd, args) => transportSend(cmd, args);

// localId format: {uuid}-{mailbox}-{uid}
// UUID v4 is always 36 chars (8-4-4-4-12), uid is always numeric
function parseLocalId(localId) {
  const match = localId.match(/^(.{36})-(.+)-(\d+)$/);
  if (!match) return null;
  return { accountId: match[1], mailbox: match[2], uid: match[3] };
}

// --- Email operations (Rust Maildir commands) ---

export async function saveEmails(emails, accountId, mailbox) {
  await initDB();
  if (!invoke) throw new Error('Tauri invoke not available');

  const results = [];
  for (const email of emails) {
    if (!email.rawSource) {
      console.warn(`[db.js] Email UID ${email.uid} has no rawSource, skipping`);
      continue;
    }
    await invoke('maildir_store', {
      accountId,
      mailbox,
      uid: email.uid,
      rawSourceBase64: email.rawSource,
      flags: ['archived', 'seen'],
    });
    results.push({ ...email, localId: `${accountId}-${mailbox}-${email.uid}` });
  }
  return results;
}

export async function archiveEmail(accountId, mailbox, uid) {
  await initDB();
  if (!invoke) return;

  try {
    const summaries = await invoke('maildir_list', { accountId, mailbox, requireFlag: null });
    const summary = summaries.find(s => s.uid === uid);
    if (!summary) throw new Error(`Email UID ${uid} not found in Maildir`);

    const newFlags = [...summary.flags];
    if (!newFlags.includes('archived')) {
      newFlags.push('archived');
    }
    await invoke('maildir_set_flags', { accountId, mailbox, uid, flags: newFlags });
  } catch (error) {
    console.warn('[db.js] Failed to archive email:', error);
    throw error;
  }
}

// ── Vault generation (UIDVALIDITY) ────────────────────────────────────────
//
// The vault is keyed (accountId, mailbox, uid). A uid only means anything
// inside one UIDVALIDITY generation, so once a server reissues its UID space —
// a change-server migration, or a reissue it does on its own — every uid the
// vault holds names a different message. `getSavedEmailIds` / `getArchivedEmailIds`
// answer "is uid N archived?" straight off those filenames, so they answer yes
// about some other message, and every badge, state icon and bulk target reads
// that as fact.
//
// The repair belongs here rather than at the ~15 places that call those getters:
// a step each caller has to remember is a step each new caller forgets. Rust
// no-ops when the recorded generation already matches (two small file reads),
// and no-ops outright for a mailbox that has never synced and for Graph
// accounts, which have no IMAP UID space to reissue.
const _generationRepairs = new Map();

export function ensureVaultGeneration(accountId, mailbox) {
  if (!accountId || !mailbox) return Promise.resolve(null);
  const key = `${accountId}|${mailbox}`;
  // Both getters are routinely awaited in the same Promise.all. Two concurrent
  // repairs would be two concurrent rename passes over one directory.
  let inFlight = _generationRepairs.get(key);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        return await invoke('maildir_repair_generation', { accountId, mailbox });
      } catch (e) {
        console.warn('[db] Vault generation repair failed:', e);
        return null;
      } finally {
        _generationRepairs.delete(key);
      }
    })();
    _generationRepairs.set(key, inFlight);
  }
  return inFlight;
}

/** Files a repair moved out of the uid namespace — one account, or the vault. */
export async function getVaultOrphanStats(accountId = null) {
  await initBasic();
  try {
    return await invoke('maildir_orphan_stats', { accountId });
  } catch (e) {
    console.warn('[db] Failed to read orphan stats:', e);
    return { count: 0, bytes: 0 };
  }
}

/** Delete orphaned vault files. Destructive — these exist on no server. */
export async function purgeVaultOrphans(accountId = null) {
  await initBasic();
  return invoke('maildir_purge_orphans', { accountId });
}

// No generation repair here on purpose: this is the per-message read path, and
// a repair per opened message would be a directory scan per click. selectEmail's
// `_readVerifiedLocal` already refuses a copy whose Message-ID contradicts the
// row, which is the stricter check for a single message.
export async function getLocalEmailLight(accountId, mailbox, uid) {
  await initDB();
  if (!invoke) return undefined;

  try {
    const email = await invoke('maildir_read_light', { accountId, mailbox, uid: parseInt(uid, 10) });
    return email || undefined;
  } catch {
    return undefined;
  }
}

// The Message-ID of the vault file itself. Header block only: a quoted reply
// carries its parent's Message-ID further down the body.
function readRawMessageId(raw) {
  const head = raw.split(/\r?\n\r?\n/, 1)[0];
  const m = head.match(/^message-id:[ \t]*(.+(?:\r?\n[ \t]+.+)*)/im);
  return m ? m[1].replace(/\s+/g, '') : null;
}

// Raw source is the one view that shows the vault file verbatim, so it needs
// the same Message-ID proof every other vault read takes. Without it a uid the
// vault archived under an older UIDVALIDITY hands the reader another message's
// full source under this row's header — which is exactly how the March
// StrictSeal mail turned up under an August Zendesk row.
//
// Returns { b64, error }: never a file that contradicts the row. A missing id
// on either side proves nothing and is allowed through, same contract as
// bodyMatchesHeader.
export async function getVerifiedRawSource(accountId, mailbox, uid, headerRow) {
  await initDB();
  if (!invoke) return { b64: null, error: null };

  const b64 = await invoke('maildir_read_raw_source', { accountId, mailbox, uid: parseInt(uid, 10) });
  if (!b64) return { b64: null, error: null };

  const rowId = normalizeMessageId(headerRow?.messageId || headerRow?.message_id);
  const rawId = normalizeMessageId(readRawMessageId(atob(b64)));
  if (rowId && rawId && rowId !== rawId) {
    console.warn('[db] Raw source belongs to another message — refusing', {
      accountId, mailbox, uid, rowId, rawId,
    });
    return {
      b64: null,
      error: 'The vault file stored under this UID is a different message, so its source is not shown.',
    };
  }
  return { b64, error: null };
}

export async function getLocalEmails(accountId, mailbox) {
  await initBasic();
  if (!invoke) return [];

  await ensureVaultGeneration(accountId, mailbox);
  try {
    const summaries = await invoke('maildir_list', { accountId, mailbox, requireFlag: null });
    if (summaries.length === 0) return [];

    // Build archive flag lookup
    const archivedUids = new Set(summaries.filter(s => s.isArchived).map(s => s.uid));
    const uids = summaries.map(s => s.uid);

    // Batch read all emails in a single IPC call
    const results = await invoke('maildir_read_light_batch', { accountId, mailbox, uids });
    const emails = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i]) {
        emails.push({
          ...results[i],
          localId: `${accountId}-${mailbox}-${uids[i]}`,
          // Provenance travels with the message. A UID names a message only
          // inside one (account, mailbox); a row that reaches a view without
          // these gets its location guessed from the ACTIVE folder, which is
          // right until the moment it isn't — search results span folders by
          // design, so every one of them was being fetched from whatever
          // folder happened to be selected.
          _accountId: accountId,
          _mailbox: mailbox,
          isArchived: archivedUids.has(uids[i])
        });
      }
    }
    return emails;
  } catch {
    return [];
  }
}

/**
 * Read local-index.json for fast archived email metadata.
 * Returns null if the file doesn't exist (caller should fall back to getLocalEmails).
 */
export async function readLocalEmailIndex(accountId, mailbox) {
  await initBasic();
  if (!invoke) return null;
  await ensureVaultGeneration(accountId, mailbox);
  try {
    const data = await invoke('local_index_read', { accountId, mailbox });
    if (data) {
      const entries = JSON.parse(data);
      return entries.map(e => ({
        ...e,
        source: 'local',
        isLocal: true,
        isArchived: true,
      }));
    }
  } catch (e) {
    console.warn('[db] Failed to read local-index.json:', e);
  }
  return null;
}

/**
 * uid → the local index's own `source` string, straight off disk.
 *
 * `readLocalEmailIndex` rewrites every entry to `source: 'local'` so the rows
 * render as local, which destroys the one field that records where a message
 * came from: `'local'` means archived FROM a server, `'local_sent'` and
 * `'local_draft'` mean it was created here and never existed on one. A
 * destructive path needs that distinction, so it reads the raw entries.
 */
export async function getLocalIndexProvenance(accountId, mailbox) {
  await initBasic();
  if (!invoke) return new Map();
  await ensureVaultGeneration(accountId, mailbox);
  try {
    const data = await invoke('local_index_read', { accountId, mailbox });
    if (!data) return new Map();
    const entries = JSON.parse(data);
    return new Map(
      entries
        .filter(e => e && e.uid != null && typeof e.source === 'string')
        .map(e => [Number(e.uid), e.source])
    );
  } catch (e) {
    console.warn('[db] Failed to read local index provenance:', e);
    return new Map();
  }
}

/**
 * One local-index entry, raw, for a single uid — or null when there is none.
 *
 * `getLocalIndexProvenance` above keeps only `source`, which answers "where did
 * this come from" and nothing else. Reopening a draft also needs the headers
 * the .eml parse does not surface (In-Reply-To, References live in the index,
 * not in `ParsedEmail`), so this returns the whole entry rather than reading
 * the same file twice for two halves of one answer.
 */
export async function getLocalIndexEntry(accountId, mailbox, uid) {
  await initBasic();
  if (!invoke) return null;
  await ensureVaultGeneration(accountId, mailbox);
  try {
    const data = await invoke('local_index_read', { accountId, mailbox });
    if (!data) return null;
    const entries = JSON.parse(data);
    return entries.find(e => e && e.uid != null && Number(e.uid) === Number(uid)) || null;
  } catch (e) {
    console.warn('[db] Failed to read local index entry:', e);
    return null;
  }
}

/**
 * The whole parsed .eml, attachment bytes included.
 *
 * `getLocalEmailLight` deliberately leaves attachment content on disk, which is
 * right for rendering a message and wrong for reopening one in compose: an
 * editor has to be able to send the files back out again.
 */
export async function getLocalEmailFull(accountId, mailbox, uid) {
  await initDB();
  if (!invoke) return undefined;
  try {
    const email = await invoke('maildir_read', { accountId, mailbox, uid: parseInt(uid, 10) });
    return email || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load only archived emails from Maildir (fast — reads only archived .eml files, not all).
 * Uses archivedEmailIds (already loaded via fast maildir_list) to read only the subset.
 */
/**
 * Load archived email headers for instant display.
 *
 * Strategy (fast path first):
 * 1. Try sidecar cache (email_cache/{uid}.json) — already populated by IMAP sync.
 *    Reads only the specific UID files we need. Instant for most archived emails.
 * 2. For UIDs not in sidecar: try archived_headers.json (populated after first full load)
 * 3. Last resort: batch-load from .eml files (slow — MIME parsing)
 * 4. Save results to archived_headers.json for next time
 */
export async function getArchivedEmails(accountId, mailbox, archivedUidSet, onBatch) {
  await initBasic();
  if (!invoke || !archivedUidSet || archivedUidSet.size === 0) return [];

  const uids = Array.from(archivedUidSet).sort((a, b) => b - a); // newest first
  console.log('[db] getArchivedEmails: %d UIDs', uids.length);

  // 1. Fast path: read from sidecar cache (email_cache/{uid}.json)
  // These are already written by IMAP sync — no .eml parsing needed
  let sidecarEmails = [];
  try {
    sidecarEmails = await invoke('load_email_cache_by_uids', {
      accountId, mailbox, uids
    });
  } catch (e) {
    console.warn('[db] getArchivedEmails: sidecar load failed:', e);
  }

  if (sidecarEmails.length > 0) {
    const emails = sidecarEmails.map(e => ({
      ...e,
      localId: `${accountId}-${mailbox}-${e.uid}`,
      isArchived: true
    }));
    console.log('[db] getArchivedEmails: sidecar hit %d/%d UIDs', emails.length, uids.length);
    if (onBatch) onBatch(emails);

    // If sidecar covered all UIDs, we're done
    if (emails.length >= uids.length * 0.9) {
      return emails;
    }

    // Some UIDs missing from sidecar — find which ones
    const foundUids = new Set(emails.map(e => e.uid));
    const missingUids = uids.filter(uid => !foundUids.has(uid));
    if (missingUids.length === 0) return emails;

    // Load missing from .eml files
    console.log('[db] getArchivedEmails: %d UIDs missing from sidecar, loading from .eml', missingUids.length);
    const BATCH_SIZE = 200;
    try {
      for (let i = 0; i < missingUids.length; i += BATCH_SIZE) {
        const batchUids = missingUids.slice(i, i + BATCH_SIZE);
        const results = await invoke('maildir_read_light_batch', { accountId, mailbox, uids: batchUids });
        for (let j = 0; j < results.length; j++) {
          if (results[j]) {
            emails.push({
              ...results[j],
              localId: `${accountId}-${mailbox}-${batchUids[j]}`,
              isArchived: true
            });
          }
        }
        if (onBatch) onBatch([...emails]);
      }
    } catch (e) {
      console.warn('[db] getArchivedEmails: .eml fallback failed:', e);
    }
    return emails;
  }

  // 2. No sidecar data — try archived_headers.json cache
  try {
    const cached = await invoke('maildir_read_archived_cached', {
      accountId, mailbox, expectedCount: uids.length
    });
    if (cached && cached.length > 0) {
      const emails = cached.map(e => ({
        ...e,
        localId: `${accountId}-${mailbox}-${e.uid}`,
        isArchived: true
      }));
      console.log('[db] getArchivedEmails: archived cache hit, %d emails', emails.length);
      if (onBatch) onBatch(emails);
      return emails;
    }
  } catch {
    // Fall through
  }

  // 3. Last resort: batch load from .eml files (slow — MIME parsing)
  console.log('[db] getArchivedEmails: full .eml fallback for %d UIDs', uids.length);
  const BATCH_SIZE = 200;
  const allEmails = [];
  try {
    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
      const batchUids = uids.slice(i, i + BATCH_SIZE);
      const results = await invoke('maildir_read_light_batch', { accountId, mailbox, uids: batchUids });
      for (let j = 0; j < results.length; j++) {
        if (results[j]) {
          allEmails.push({
            ...results[j],
            localId: `${accountId}-${mailbox}-${batchUids[j]}`,
            isArchived: true
          });
        }
      }
      console.log('[db] getArchivedEmails: batch %d/%d, loaded: %d', Math.floor(i / BATCH_SIZE) + 1, Math.ceil(uids.length / BATCH_SIZE), allEmails.length);
      if (onBatch) onBatch([...allEmails]);
    }

    // Save to archived_headers.json for next load
    if (allEmails.length > 0) {
      const forCache = allEmails.map(({ localId, isArchived, ...rest }) => rest);
      invoke('maildir_save_archived_cache', { accountId, mailbox, emails: forCache }).catch(() => {});
    }

    console.log('[db] getArchivedEmails: complete, loaded %d emails', allEmails.length);
    return allEmails;
  } catch (e) {
    console.error('[db] getArchivedEmails: .eml loading FAILED:', e);
    return allEmails.length > 0 ? allEmails : [];
  }
}

export async function getAllLocalEmails(accountId, mailboxes = []) {
  await initDB();
  if (!invoke) return [];

  const acctDir = accountDir(accountId);
  try {
    const dirExists = await exists(acctDir, { baseDir: BaseDirectory.AppData });
    if (!dirExists) return [];

    const mailboxDirs = await readDir(acctDir, { baseDir: BaseDirectory.AppData });
    const allEmails = [];
    for (const mbEntry of mailboxDirs) {
      if (!mbEntry.name || !mbEntry.isDirectory) continue;
      // The directory name is sanitised and lossy — pass the SERVER path it
      // came from, so `_mailbox` on these rows is something IMAP can SELECT.
      const mailbox = mailboxPathFromVaultDir(mbEntry.name, mailboxes);
      const emails = await getLocalEmails(accountId, mailbox);
      allEmails.push(...emails);
    }
    return allEmails;
  } catch {
    return [];
  }
}

export async function deleteLocalEmail(localId) {
  await initDB();
  const parsed = parseLocalId(localId);
  if (!parsed) {
    // Silent no-op here reads as "delete succeeded" all the way up to the row.
    console.warn('[db.js] deleteLocalEmail: unparseable local id', localId);
    return;
  }
  if (!invoke) return;

  try {
    await invoke('maildir_delete', {
      accountId: parsed.accountId,
      mailbox: parsed.mailbox,
      uid: parseInt(parsed.uid, 10),
    });
  } catch (error) {
    console.warn('[db.js] Failed to delete email:', error);
  }
}

export async function isEmailSaved(accountId, mailbox, uid) {
  await initDB();
  if (!invoke) return false;
  try {
    return await invoke('maildir_exists', { accountId, mailbox, uid: parseInt(uid, 10) });
  } catch {
    return false;
  }
}

export async function getSavedEmailIds(accountId, mailbox) {
  await initBasic();
  if (!invoke) return new Set();
  await ensureVaultGeneration(accountId, mailbox);
  try {
    const summaries = await invoke('maildir_list', { accountId, mailbox, requireFlag: null });
    return new Set(summaries.map(s => s.uid));
  } catch {
    return new Set();
  }
}

export async function getArchivedEmailIds(accountId, mailbox) {
  await initBasic();
  if (!invoke) return new Set();
  await ensureVaultGeneration(accountId, mailbox);
  try {
    const summaries = await invoke('maildir_list', { accountId, mailbox, requireFlag: 'archived' });
    return new Set(summaries.map(s => s.uid));
  } catch (e) {
    console.warn('[db] getArchivedEmailIds failed:', e);
    return new Set();
  }
}

export async function exportEmail(localId) {
  await initDB();
  const parsed = parseLocalId(localId);
  if (!parsed || !invoke) return null;

  try {
    // Get light email for subject, and raw source separately
    const [email, rawBase64] = await Promise.all([
      invoke('maildir_read_light', {
        accountId: parsed.accountId,
        mailbox: parsed.mailbox,
        uid: parseInt(parsed.uid, 10),
      }),
      invoke('maildir_read_raw_source', {
        accountId: parsed.accountId,
        mailbox: parsed.mailbox,
        uid: parseInt(parsed.uid, 10),
      }),
    ]);
    if (!email || !rawBase64) return null;

    return {
      filename: `${(email.subject || 'email').replace(/[^a-zA-Z0-9]/g, '_')}.eml`,
      content: atob(rawBase64),
      rawBase64,
      mimeType: 'message/rfc822'
    };
  } catch {
    return null;
  }
}

// --- Storage usage ---

export async function getStorageUsage() {
  await initDB();
  if (!invoke) return { totalMB: 0, totalBytes: 0, emailCount: 0, emailsSizeMB: 0, headersSizeMB: 0 };

  try {
    const stats = await invoke('maildir_storage_stats', { accountId: null });
    return {
      totalMB: stats.totalMB,
      totalBytes: stats.totalBytes,
      emailCount: stats.emailCount,
      emailsSizeMB: stats.totalMB,
      headersSizeMB: 0
    };
  } catch {
    return { totalMB: 0, totalBytes: 0, emailCount: 0, emailsSizeMB: 0, headersSizeMB: 0 };
  }
}

// --- Search ---

export async function migrateMaildirEmailDirs(accounts) {
  if (!invoke) return;
  const accountMap = {};
  for (const a of accounts) {
    if (a.email && a.id && a.email !== a.id) {
      accountMap[a.email] = a.id;
    }
  }
  if (Object.keys(accountMap).length === 0) return;
  try {
    const result = await invoke('maildir_migrate_email_dirs', { accountMap });
    if (result.migrated > 0) {
      console.log(`[db.js] Maildir migration: moved ${result.migrated} files`);
    }
  } catch (e) {
    console.warn('[db.js] Maildir migration failed (non-fatal):', e);
  }
}

export async function searchLocalEmails(accountId, query, filters = {}) {
  await initDB();

  let emails;
  if (filters.mailbox && filters.mailbox !== 'all') {
    emails = await getLocalEmails(accountId, filters.mailbox);
  } else {
    emails = await getAllLocalEmails(accountId, filters.mailboxes);
  }

  const queryLower = query?.toLowerCase().trim() || '';

  return emails.filter(email => {
    if (filters.sender) {
      const senderMatch =
        (email.from?.address || '').toLowerCase().includes(filters.sender.toLowerCase()) ||
        (email.from?.name || '').toLowerCase().includes(filters.sender.toLowerCase());
      if (!senderMatch) return false;
    }

    if (filters.dateFrom && email.date && email.date < filters.dateFrom) return false;
    if (filters.dateTo && email.date && email.date > filters.dateTo) return false;

    if (filters.hasAttachments && !email.hasAttachments) return false;

    if (queryLower) {
      const searchable = [
        email.subject,
        email.from?.address,
        email.from?.name,
        email.text,
        email.html
      ].filter(Boolean).join(' ').toLowerCase();
      if (!searchable.includes(queryLower)) return false;
    }

    return true;
  }).map(email => ({
    ...email,
    isLocal: true,
    source: 'local'
  }));
}
