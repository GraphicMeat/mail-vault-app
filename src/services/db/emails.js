// ── db/emails — Maildir email storage, local/archived reads, search, storage stats ──

import { readDir, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { send as transportSend } from '../transport.js';
import { initDB, initBasic, accountDir } from './accounts.js';
import { mailboxPathFromVaultDir } from '../../stores/slices/unifiedHelpers.js';
import { normalizeMessageId } from '../../utils/emailParser.js';
import { custodySource } from '../../stores/slices/custody.js';
import { t } from '../../i18n/index.js';
import { insightsBodyMatchesHeader } from '../../utils/insights/messageIdentity.js';

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
  if (!invoke) throw new Error(t('errors.tauriUnavailable'));

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
      // The message's own flags — the same rule as vaultStoreFlags in
      // workflows/messageMutations.js, which owns the Tauri path.
      flags: [
        'archived',
        ...(email.flags?.includes('\\Seen') ? ['seen'] : []),
        ...(email.flags?.includes('\\Flagged') ? ['flagged'] : []),
        ...(email.flags?.includes('\\Answered') ? ['replied'] : []),
      ],
    });
    results.push({ ...email, localId: `${accountId}-${mailbox}-${email.uid}` });
  }
  return results;
}

export async function archiveEmail(accountId, mailbox, uid) {
  await initDB();
  if (!invoke) return;

  // Rust hands back a number and takes a u32, so the compare below and the
  // set_flags call have to agree with `isEmailSaved`'s parseInt — a caller that
  // reaches here holding the string "30" would otherwise pass the exists check
  // and then fail to find its own message.
  const numericUid = Number(uid);

  try {
    const summaries = await invoke('maildir_list', { accountId, mailbox, requireFlag: null });
    const summary = summaries.find(s => s.uid === numericUid);
    if (!summary) throw new Error(t('errors.uidNotInMaildir', { uid }));

    const newFlags = [...summary.flags];
    if (!newFlags.includes('archived')) {
      newFlags.push('archived');
    }
    await invoke('maildir_set_flags', { accountId, mailbox, uid: numericUid, flags: newFlags });
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

  // Insights can retain older physical copies with reused IDs. Verify all
  // known identity fields against the file's parsed metadata before exposing
  // its source, just as the Insights body reader does.
  if (headerRow?._insightsReadOnly) {
    const body = await invoke('maildir_read_light', { accountId, mailbox, uid: parseInt(uid, 10) });
    if (!body || (body.uid != null && Number(body.uid) !== Number(uid)) || !insightsBodyMatchesHeader(headerRow, body)) {
      return { b64: null, error: t('insights.messageChanged') };
    }
  }

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
      error: t('svc.emails.vaultFileStoredUnderUid'),
    };
  }
  return { b64, error: null };
}

/**
 * The vault rows of one mailbox: headers, attachment list and `snippet`, no
 * body. One `vault_light_rows` call answered from the daemon's registry (the
 * daemon runs the generation repair first), plus custody off one index read.
 *
 * `null` when the answer is unknown (vault unreachable, repair failed, folder
 * unlistable, or the call itself failed): unknown is not empty, so callers
 * keep what they already hold rather than adopting "the vault has nothing".
 */
export async function getLocalEmails(accountId, mailbox) {
  await initBasic();
  if (!invoke) return [];
  let rows;
  try {
    rows = await invoke('vault_light_rows', { accountId, mailbox });
  } catch (e) {
    console.warn('[db] vault_light_rows failed:', e);
    return null;
  }
  if (!Array.isArray(rows)) return null;
  // These rows become `localEmails`, so custody belongs on them: unstamped, an
  // archived message loses `_origin` / `serverDeleted` / `serverAbsent`
  // whenever this path builds the row instead of getArchivedEmails, and the
  // gold band goes quiet about a message it should be shouting about.
  // Covered by __tests__/vaultRowCustody.test.js.
  const stamp = custodyStamper(await getLocalIndexMeta(accountId, mailbox));
  return rows.map(row => stamp({
    ...row,
    localId: `${accountId}-${mailbox}-${row.uid}`,
    // Provenance travels with the message. A UID names a message only
    // inside one (account, mailbox); a row that reaches a view without
    // these gets its location guessed from the ACTIVE folder, which is
    // right until the moment it isn't — search results span folders by
    // design, so every one of them was being fetched from whatever
    // folder happened to be selected.
    _accountId: accountId,
    _mailbox: mailbox,
    isArchived: !!row.isArchived,
  }));
}

// The same rows WITH `text`/`html`: the no-index search scan matches bodies,
// so it keeps the per-file batch read. The rare fallback, never a list read.
async function _getLocalEmailsWithBodies(accountId, mailbox) {
  await initBasic();
  if (!invoke) return [];

  await ensureVaultGeneration(accountId, mailbox);
  try {
    const summaries = await invoke('maildir_list', { accountId, mailbox, requireFlag: null });
    if (summaries.length === 0) return [];

    const archivedUids = new Set(summaries.filter(s => s.isArchived).map(s => s.uid));
    const uids = summaries.map(s => s.uid);
    const results = await invoke('maildir_read_light_batch', { accountId, mailbox, uids });
    const emails = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i]) {
        emails.push({
          ...results[i],
          localId: `${accountId}-${mailbox}-${uids[i]}`,
          _accountId: accountId,
          _mailbox: mailbox,
          isArchived: archivedUids.has(uids[i])
        });
      }
    }
    return emails.map(custodyStamper(await getLocalIndexMeta(accountId, mailbox)));
  } catch {
    // A search over what could be read: an unreadable folder adds no hits.
    return [];
  }
}

/**
 * Read the mailbox's custody entries for fast archived email metadata.
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
        // The raw entry's own `source` is the only record of where a message
        // came from, and the rewrite below destroys it. Custody reads
        // `_origin` (see stores/slices/custody.js), so keep it.
        _origin: e.source,
        source: 'local',
        isLocal: true,
        isArchived: true,
      }));
    }
  } catch (e) {
    console.warn('[db] Failed to read the custody entries:', e);
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
/**
 * uid → `{ origin, serverDeleted, serverAbsent }` for one mailbox's index.
 *
 * The three facts custody needs, read together because they come from the same
 * record: `origin` is the entry's raw `source` (`local_sent` / `local_draft`
 * meaning the message never had a server copy), `serverDeleted` is stamped by
 * applyServerRemoval when this app deletes the server copy, and `serverAbsent`
 * by probeServerCopy when a completed Message-ID sweep of every folder found
 * nothing. All three are on disk, so a gold row survives a reload — the uid set
 * it used to be derived from does not.
 */
export async function getLocalIndexMeta(accountId, mailbox) {
  await initBasic();
  if (!invoke) return new Map();
  await ensureVaultGeneration(accountId, mailbox);
  try {
    const data = await invoke('local_index_read', { accountId, mailbox });
    if (!data) return new Map();
    const entries = JSON.parse(data);
    return new Map(entries
      .filter(e => e && e.uid != null)
      .map(e => [Number(e.uid), {
        origin: e.source,
        serverDeleted: e.serverDeleted === true,
        serverAbsent: e.serverAbsent === true,
      }]));
  } catch (e) {
    console.warn('[db] Failed to read local index meta:', e);
    return new Map();
  }
}

/**
 * Stamp custody onto a vault row from one mailbox/index-meta pair.
 *
 * `getArchivedEmails` builds vault rows from three different sources, none of
 * which knows anything about provenance, so the stamp is what lets custody tell
 * a staged send from an archived server message.
 *
 * `getLocalEmails` stamps with it too, for the same reason and off the same
 * per-mailbox read.
 */
export function custodyStamper(meta) {
  return (e) => {
    const m = meta.get(Number(e.uid));
    return m
      ? { ...e, _origin: m.origin, serverDeleted: m.serverDeleted, serverAbsent: m.serverAbsent }
      : e;
  };
}

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
 * The archived rows of one mailbox, cheapest source first.
 *
 * 1. header sidecars (`email_cache/<uid>.json`), written by the sync;
 * 2. the rows the search index already parsed (`vault_rows`), with flags read
 *    off the current file name;
 * 3. the vault registry's light rows (each file MIME-parsed once, then stored).
 *
 * Each tier is asked only for what the ones before it missed, and nothing is
 * cached: the per-folder archived-headers file this function used to write was
 * never repatched after a flag change and the index holds the same rows for
 * the same files.
 */
export async function getArchivedEmails(accountId, mailbox, archivedUidSet, onBatch) {
  await initBasic();
  if (!invoke || !archivedUidSet || archivedUidSet.size === 0) return [];

  const uids = Array.from(archivedUidSet).sort((a, b) => b - a); // newest first
  console.log('[db] getArchivedEmails: %d UIDs', uids.length);

  // Custody rides along with the row, from one read for the whole mailbox:
  // every source below knows nothing about provenance, and without the stamp
  // the list cannot tell a staged send from an archived server message.
  const withCustody = custodyStamper(await getLocalIndexMeta(accountId, mailbox));
  const emails = [];
  const found = new Set();
  const take = (rows, tier) => {
    for (const row of rows) {
      if (!row || found.has(row.uid)) continue;
      found.add(row.uid);
      emails.push(withCustody({ ...row, localId: `${accountId}-${mailbox}-${row.uid}`, isArchived: true }));
    }
    console.log('[db] getArchivedEmails: %s %d/%d', tier, emails.length, uids.length);
    if (rows.length && onBatch) onBatch([...emails]);
  };
  const missing = () => uids.filter((uid) => !found.has(uid));

  // 1. Header sidecars (email_cache/<uid>.json), written by the sync.
  try {
    take(await invoke('load_email_cache_by_uids', { accountId, mailbox, uids }), 'sidecars');
  } catch (e) {
    console.warn('[db] getArchivedEmails: sidecar load failed:', e);
  }
  // 2. Rows the search index already parsed (headers, flags off the file name).
  if (missing().length) {
    try {
      take(await invoke('vault_rows', { accountId, mailbox, uids: missing() }), 'index');
    } catch (e) {
      console.warn('[db] getArchivedEmails: index rows failed:', e);
    }
  }
  // 3. The registry's light rows (parsed once, then stored), 500 per call.
  // The reply omits uids the vault does not hold, so each row names its own.
  const rest = missing();
  const BATCH_SIZE = 500;
  for (let i = 0; i < rest.length; i += BATCH_SIZE) {
    const batch = rest.slice(i, i + BATCH_SIZE);
    let rows;
    try {
      rows = await invoke('vault_light_rows', { accountId, mailbox, uids: batch });
    } catch (e) {
      console.error('[db] getArchivedEmails: vault rows FAILED:', e);
      break;
    }
    if (!Array.isArray(rows)) break;
    take(rows, 'files');
  }
  return emails;
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
      // One call per vault directory, and the read stamps custody off that
      // mailbox's index once for the whole batch — one read per MAILBOX here,
      // never one per message. Bodies included: this feeds the search scan.
      const emails = await _getLocalEmailsWithBodies(accountId, mailbox);
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
    // `=== true`, not the raw value: this is a two-process answer, and a
    // transport that ever hands back an envelope instead of a bool would make
    // every message read as already-archived. Callers branch on this.
    return await invoke('maildir_exists', { accountId, mailbox, uid: parseInt(uid, 10) }) === true;
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

/**
 * What the vault holds for one mailbox: `{ saved, archived }` uid Sets, from
 * one `vault_uid_sets` call the daemon answers off its registry (generation
 * repair included, daemon-side).
 *
 * `null` means unknown — the call failed, the daemon said `null` (vault
 * unreachable, repair failed, folder unlistable) or the reply is malformed.
 * Never an empty Set on failure (I-5 below): every caller keeps what it
 * already knows instead of persisting "the vault has nothing".
 */
export async function getVaultUidSets(accountId, mailbox) {
  await initBasic();
  if (!invoke) return null;
  try {
    const reply = await invoke('vault_uid_sets', { accountId, mailbox });
    if (!Array.isArray(reply?.saved) || !Array.isArray(reply?.archived)) return null;
    return { saved: new Set(reply.saved), archived: new Set(reply.archived) };
  } catch (e) {
    console.warn('[db] vault_uid_sets failed:', e);
    return null;
  }
}

// Final fix wave I-5: a failed read returns `null`, never an empty Set.
// `stampVaultEntry` (messageMutations.js) and every other caller that
// persists this into the store treats "empty" as durable fact — a message
// really has no archived copy — so a swallowed daemon error (guaranteed on
// every cold start and every vault move, not just a disk error) used to be
// indistinguishable from that, and silently dropped the serverDeleted/
// serverAbsent stamp for good (memory: an unlistable directory is not an
// empty one). Every caller below is expected to treat `null` as "unknown,
// keep whatever was already known" rather than adopting it.
export async function getArchivedEmailIds(accountId, mailbox) {
  await initBasic();
  if (!invoke) return new Set();
  await ensureVaultGeneration(accountId, mailbox);
  try {
    const summaries = await invoke('maildir_list', { accountId, mailbox, requireFlag: 'archived' });
    return new Set(summaries.map(s => s.uid));
  } catch (e) {
    console.warn('[db] getArchivedEmailIds failed:', e);
    return null;
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

const toUnixSeconds = (d) => (d ? Math.floor(new Date(d).getTime() / 1000) : null);

/**
 * Vault search. The offline index (`vault_search`, app process) answers when it
 * is open; until then — or when the command fails — the per-message scan below
 * answers exactly as it always has.
 *
 * Index rows are the same `LightEmail` JSON the vault reads return, so they get
 * the same decoration `getLocalEmails` gives vault rows: the SERVER path the
 * sanitised directory came from, provenance, and custody off one local-index
 * read per mailbox. The array carries a non-enumerable
 * `coverage = { indexed, total, complete, matched, shown }` so the UI can say how
 * much of the vault the answer covers and whether rows were capped; scan results
 * have none.
 */
export async function searchLocalEmails(accountId, query, filters = {}) {
  await initDB();
  const mailboxes = filters.mailbox && filters.mailbox !== 'all'
    ? [filters.mailbox]
    : (filters.restrictTo ? [...filters.restrictTo] : null);
  let reply = null;
  try {
    reply = await invoke('vault_search', { request: {
      accountId, query: query || '', mailboxes,
      sender: filters.sender || null,
      dateFrom: toUnixSeconds(filters.dateFrom), dateTo: toUnixSeconds(filters.dateTo),
      hasAttachments: !!filters.hasAttachments,
    } });
  } catch (e) {
    console.warn('[db] vault_search failed; scanning the vault instead:', e);
  }
  if (!reply?.available) return scanLocalEmails(accountId, query, filters);

  // The paths this search asked for come first: the scan stamps a one-folder
  // search with `filters.mailbox` verbatim, whether or not the tree lists it.
  const knownBoxes = [...(mailboxes || []).map(path => ({ path })), ...(filters.mailboxes || [])];
  const stamperByMailbox = new Map();
  const rows = [];
  for (const row of reply.rows || []) {
    const mailbox = mailboxPathFromVaultDir(row.vaultDir, knownBoxes);
    if (!stamperByMailbox.has(mailbox)) {
      stamperByMailbox.set(mailbox, custodyStamper(await getLocalIndexMeta(accountId, mailbox)));
    }
    const stamped = stamperByMailbox.get(mailbox)({
      ...row,
      localId: `${accountId}-${mailbox}-${row.uid}`,
      _accountId: accountId,
      _mailbox: mailbox,
      isArchived: !!row.isArchived,
    });
    rows.push({ ...stamped, isLocal: true, source: custodySource(stamped) });
  }
  Object.defineProperty(rows, 'coverage', {
    // `matched` counts every hit; the index returns at most 500 rows of them.
    value: { indexed: reply.indexed, total: reply.totalMessages, complete: !!reply.complete, matched: reply.total, shown: rows.length },
    enumerable: false,
  });
  return rows;
}

async function scanLocalEmails(accountId, query, filters = {}) {
  await initDB();

  let emails;
  if (filters.mailbox && filters.mailbox !== 'all') {
    emails = await _getLocalEmailsWithBodies(accountId, filters.mailbox);
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
    // Not a constant: `describeMessageState` reads `email.source` and only
    // falls back to `custodySource` when the field is absent, so a hardcoded
    // 'local' outranks every proof the rows above now carry — a message the
    // server was asked about and does not have rendered as an ordinary vault
    // copy in search while the same message was gold in the folder list. Same
    // derivation the list itself uses (stores/slices/messageListSlice.js).
    source: custodySource(email)
  }));
}
