// ── db/emails — Maildir email storage, local/archived reads, search, storage stats ──

import { readDir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { send as transportSend } from '../transport.js';
import { initDB, initBasic, accountDir } from './accounts.js';

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

export async function getLocalEmails(accountId, mailbox) {
  await initBasic();
  if (!invoke) return [];

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

export async function getAllLocalEmails(accountId) {
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
      const emails = await getLocalEmails(accountId, mbEntry.name);
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
  if (!parsed || !invoke) return;

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
    emails = await getAllLocalEmails(accountId);
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
