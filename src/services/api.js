// API module — routes IMAP/SMTP/OAuth2 calls through the daemon transport layer.
// In dev mode (no __TAURI__), falls back to the sidecar HTTP server.
// In Tauri mode, transport.send() tries daemon socket first, then Tauri invoke().

import { send as transportSend } from './transport.js';
import { t } from '../i18n/index.js';

const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;

console.log('[api.js] Running in Tauri:', IS_TAURI);

// ── Transport-aware invoke ──────────────────────────────────────────────────

async function tauriInvoke(command, args = {}) {
  try {
    return await transportSend(command, args);
  } catch (error) {
    throw new ApiError(
      typeof error === 'string' ? error : error.message || 'Unknown error',
      0
    );
  }
}

// ── Dev mode HTTP fallback ──────────────────────────────────────────────────

const API_BASE = '/api';
const DEFAULT_FETCH_TIMEOUT = 30000;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function httpRequest(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const timeout = options.timeout || DEFAULT_FETCH_TIMEOUT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    const { timeout: _timeout, ...fetchOptions } = options;
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...fetchOptions.headers },
      ...fetchOptions,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new ApiError(`Request timed out (${endpoint}).`, 0);
    }
    throw new ApiError(`Server unreachable (${endpoint}): ${error.message}`, 0);
  }
  clearTimeout(timeoutId);

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(`Invalid response from server (${endpoint}): HTTP ${response.status}`, response.status);
  }

  if (!response.ok || !data.success) {
    throw new ApiError(data.error || `Request failed (${endpoint}): HTTP ${response.status}`, response.status);
  }

  return data;
}

// ── Exported API functions ──────────────────────────────────────────────────

export { ApiError };

export async function testConnection(account) {
  console.log('[api.js] testConnection: %s @ %s:%d', account.email, account.imapHost, account.imapPort);
  if (IS_TAURI) {
    return tauriInvoke('imap_test_connection', { account });
  }
  return httpRequest('/test-connection', {
    method: 'POST',
    body: JSON.stringify({ account }),
    timeout: 20000,
  });
}

export async function smtpTestConnection(account) {
  return tauriInvoke('smtp_test_connection', { account });
}

export async function storePassword(accountId, password) {
  return tauriInvoke('store_password', { accountId, password });
}

export async function fetchMailboxes(account) {
  if (IS_TAURI) {
    const data = await tauriInvoke('imap_get_mailboxes', { account });
    return data.mailboxes;
  }
  const data = await httpRequest('/mailboxes', {
    method: 'POST',
    body: JSON.stringify({ account }),
  });
  return data.mailboxes;
}

export async function fetchEmails(account, mailbox = 'INBOX', page = 1, limit = 200) {
  if (IS_TAURI) {
    return tauriInvoke('imap_get_emails', { account, mailbox, page, limit });
  }
  return httpRequest('/emails', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, page, limit }),
  });
}

export async function fetchEmailsRange(account, mailbox = 'INBOX', startIndex = 0, endIndex = 50) {
  if (IS_TAURI) {
    return tauriInvoke('imap_get_emails_range', { account, mailbox, startIndex, endIndex });
  }
  return httpRequest('/emails-range', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, startIndex, endIndex }),
  });
}

// ── Delta-sync helpers ────────────────────────────────────────────────────

export async function checkMailboxStatus(account, mailbox = 'INBOX') {
  if (IS_TAURI) {
    // Returns { exists, uidValidity, uidNext, highestModseq }
    return tauriInvoke('imap_check_mailbox_status', { account, mailbox });
  }
  return httpRequest('/mailbox-status', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox }),
  });
}

export async function fetchChangedFlags(account, mailbox = 'INBOX', sinceModseq) {
  if (IS_TAURI) {
    const data = await tauriInvoke('imap_fetch_changed_flags', { account, mailbox, sinceModseq });
    return data.changes; // [{ uid, flags }]
  }
  const data = await httpRequest('/fetch-changed-flags', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, sinceModseq }),
  });
  return data.changes;
}

export async function searchAllUids(account, mailbox = 'INBOX') {
  if (IS_TAURI) {
    const data = await tauriInvoke('imap_search_all_uids', { account, mailbox });
    return data.uids;
  }
  const data = await httpRequest('/search-all-uids', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox }),
  });
  return data.uids;
}

export async function fetchHeadersByUids(account, mailbox = 'INBOX', uids = []) {
  if (IS_TAURI) {
    return tauriInvoke('imap_fetch_headers_by_uids', { account, mailbox, uids });
  }
  return httpRequest('/fetch-headers-by-uids', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, uids }),
  });
}

export async function fetchEmail(account, uid, mailbox = 'INBOX') {
  if (IS_TAURI) {
    const data = await tauriInvoke('imap_get_email', { account, uid, mailbox });
    return data.email;
  }
  const data = await httpRequest(`/email/${uid}`, {
    method: 'POST',
    body: JSON.stringify({ account, mailbox }),
  });
  return data.email;
}

/**
 * The server proved this uid is not in the mailbox — a tagged OK with no rows,
 * twice (see `uid_still_present` in src-core/src/imap/mod.rs). Distinct from
 * every other body-fetch failure, which proves only that the fetch failed.
 *
 * Thrown rather than returned so the four existing callers keep the contract
 * they already have; only `selectEmail` reads the flag, to prune the row.
 */
export class MessageGoneError extends Error {
  constructor(uid, mailbox) {
    super(`Message UID ${uid} is no longer in ${mailbox}`);
    this.name = 'MessageGoneError';
    this.messageGone = true;
    this.uid = uid;
    this.mailbox = mailbox;
  }
}

export async function fetchEmailLight(account, uid, mailbox = 'INBOX', accountId = null, { background = false } = {}) {
  if (IS_TAURI) {
    const params = { account, uid, mailbox, background };
    if (accountId) params.accountId = accountId;
    const data = await tauriInvoke('imap_get_email_light', params);
    if (data?.gone) throw new MessageGoneError(data.uid ?? uid, data.mailbox ?? mailbox);
    return data.email;
  }
  // Dev mode fallback — fetch full email, strip heavy fields client-side
  const data = await httpRequest(`/email/${uid}`, {
    method: 'POST',
    body: JSON.stringify({ account, mailbox }),
  });
  const email = data.email;
  if (email) {
    delete email.rawSource;
    if (email.attachments) {
      email.attachments = email.attachments.map(({ content, ...meta }) => meta);
    }
  }
  return email;
}

export async function updateEmailFlags(account, uid, flags, action = 'add', mailbox = 'INBOX') {
  if (IS_TAURI) {
    return tauriInvoke('imap_set_flags', { account, uid, mailbox, flags, action });
  }
  return httpRequest(`/email/${uid}/flags`, {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, flags, action }),
  });
}

export async function deleteEmail(account, uid, mailbox = 'INBOX', permanent = null) {
  // Default: permanent delete for non-INBOX folders (Sent, Spam, Trash, etc.)
  // INBOX emails get moved to Trash first (non-permanent)
  if (permanent === null) {
    permanent = mailbox !== 'INBOX';
  }
  if (IS_TAURI) {
    return tauriInvoke('imap_delete_email', { account, uid, mailbox, permanent });
  }
  return httpRequest(`/email/${uid}/delete`, {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, permanent }),
  });
}

export async function sendEmail(account, email, sentMailbox = null) {
  if (IS_TAURI) {
    return tauriInvoke('smtp_send_email', { account, email, sentMailbox });
  }
  return httpRequest('/send', {
    method: 'POST',
    body: JSON.stringify({ account, email }),
  });
}

// Resolve or CREATE the Sent mailbox on the IMAP server. Tier 3 fallback for
// servers that don't advertise SPECIAL-USE and whose Sent folder name isn't
// matched by the frontend heuristic. Returns the resolved mailbox path.
export async function ensureSentMailbox(account) {
  if (IS_TAURI) {
    return tauriInvoke('imap_ensure_sent_mailbox', { account });
  }
  throw new Error('ensureSentMailbox: not supported outside Tauri');
}

// Build RFC2822 MIME bytes without sending. Used by the compose flow to
// archive outgoing mail locally before SMTP submission so the email is never
// lost even if SMTP or the server-side Sent APPEND fails.
// Returns { rawBase64, messageId, rawSize }.
export async function buildOutgoingMime(account, email) {
  if (IS_TAURI) {
    return tauriInvoke('smtp_build_mime', { account, email });
  }
  throw new Error('buildOutgoingMime: not supported outside Tauri');
}

// Same bytes for a message that is not going anywhere yet — a draft may still
// have no recipient, which the send-side builder rejects.
export async function buildDraftMime(account, email) {
  if (IS_TAURI) {
    return tauriInvoke('smtp_build_draft_mime', { account, email });
  }
  throw new Error('buildDraftMime: not supported outside Tauri');
}

export async function disconnect(account) {
  if (IS_TAURI) {
    return tauriInvoke('imap_disconnect', { account });
  }
  return httpRequest('/disconnect', {
    method: 'POST',
    body: JSON.stringify({ account }),
  });
}

export async function moveEmails(account, uids, sourceMailbox, targetMailbox) {
  if (IS_TAURI) {
    return tauriInvoke('imap_move_emails', { account, uids, sourceMailbox, targetMailbox });
  }
  return httpRequest('/move-emails', {
    method: 'POST',
    body: JSON.stringify({ account, uids, sourceMailbox, targetMailbox }),
  });
}

export async function searchEmails(account, mailbox = 'INBOX', query, filters = {}) {
  if (IS_TAURI) {
    return tauriInvoke('imap_search_emails', { account, mailbox, query, filters });
  }
  return httpRequest('/search', {
    method: 'POST',
    body: JSON.stringify({ account, mailbox, query, filters }),
  });
}

/**
 * "Is this Message-ID anywhere on this account?" — every folder, one sweep.
 *
 * The question the gold "your only copy" row is built on and could not ask.
 * A message is routinely absent from the mailbox it was archived from and
 * entirely alive in All Mail, a label, or the Bin, so nothing derived from one
 * mailbox's uid set can claim the server lost it. This asks the server.
 *
 * @returns {Promise<{messageId: string, found: {mailbox: string, uid: number}[],
 *                    searched: string[], failed: string[], complete: boolean}>}
 *   `complete && !found.length` is the ONLY shape that proves absence.
 *   `failed` names the folders that would not open, so the app can say which.
 */
export async function findMessageId(account, messageId, { stopOnFirst = true } = {}) {
  return tauriInvoke('imap_find_message_id', { account, messageId, stopOnFirst });
}

// ── OAuth2 API functions ────────────────────────────────────────────────────

export async function getOAuth2AuthUrl(email, provider, customClientId, tenantId, useGraph) {
  if (IS_TAURI) {
    return tauriInvoke('oauth2_auth_url', {
      email: email || null,
      provider: provider || null,
      customClientId: customClientId || null,
      tenantId: tenantId || null,
      useGraph: useGraph || false,
    });
  }
  const params = email ? `?login_hint=${encodeURIComponent(email)}` : '';
  return httpRequest(`/oauth2/auth-url${params}`, { method: 'GET' });
}

export async function exchangeOAuth2Code(state) {
  if (IS_TAURI) {
    return tauriInvoke('oauth2_exchange', { state });
  }
  return httpRequest('/oauth2/exchange', {
    method: 'POST',
    body: JSON.stringify({ state }),
  });
}

export async function refreshOAuth2Token(refreshToken, provider, customClientId, tenantId, useGraph) {
  if (IS_TAURI) {
    return tauriInvoke('oauth2_refresh', {
      refreshToken,
      provider: provider || null,
      customClientId: customClientId || null,
      tenantId: tenantId || null,
      useGraph: useGraph || false,
    });
  }
  return httpRequest('/oauth2/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  });
}

// ── Bulk operations API ─────────────────────────────────────────────────────

export async function readPendingOperation() {
  if (IS_TAURI) {
    return tauriInvoke('read_pending_operation', {});
  }
  return null;
}

export async function savePendingOperation(operation) {
  if (IS_TAURI) {
    return tauriInvoke('save_pending_operation', { operation });
  }
}

export async function clearPendingOperation() {
  if (IS_TAURI) {
    return tauriInvoke('clear_pending_operation', {});
  }
}

export async function bulkDeleteEmails(account, accountId, mailbox, uids) {
  if (IS_TAURI) {
    return tauriInvoke('bulk_delete_emails', {
      accountId,
      accountJson: JSON.stringify(account),
      mailbox,
      uids,
    });
  }
}

// ── Graph API functions (personal Microsoft accounts) ─────────────────────

export async function graphListFolders(accessToken) {
  return await tauriInvoke('graph_list_folders', { accessToken });
}

export async function graphListMessages(accessToken, folderId, top, skip) {
  return await tauriInvoke('graph_list_messages', { accessToken, folderId, top, skip: skip || 0 });
}

export async function graphGetMessage(accessToken, messageId) {
  return await tauriInvoke('graph_get_message', { accessToken, messageId });
}

export async function graphCacheMime(accessToken, messageId, accountId, mailbox, uid) {
  const data = await tauriInvoke('graph_cache_mime', { accessToken, messageId, accountId, mailbox, uid });
  return data.email;
}

export async function graphSetRead(accessToken, messageId, isRead) {
  return await tauriInvoke('graph_set_read', { accessToken, messageId, isRead });
}

export async function graphDeleteMessage(accessToken, messageId) {
  return await tauriInvoke('graph_delete_message', { accessToken, messageId });
}

export async function graphMoveEmails(accessToken, messageIds, targetFolderId) {
  return await tauriInvoke('graph_move_emails', { accessToken, messageIds, targetFolderId });
}

export async function resolveEmailSettings(domain) {
  if (IS_TAURI) {
    return tauriInvoke('resolve_email_settings', { domain });
  }
  throw new ApiError('DNS resolution requires desktop app', 0);
}

export async function dnsMailHealth(domain, newImapHost) {
  if (IS_TAURI) {
    return tauriInvoke('dns_mail_health', { domain, newImapHost });
  }
  throw new ApiError('DNS health check requires desktop app', 0);
}

export async function verifyArchivedEmails(accountId, mailbox, uids) {
  if (IS_TAURI) {
    return tauriInvoke('verify_archived_emails', { accountId, mailbox, uids });
  }
  return { verified: uids, missing: [] };
}

// ── Local index ───────────────────────────────────────────────────────────────

export async function appendLocalIndex(accountId, mailbox, entries) {
  if (IS_TAURI) {
    const entriesJson = JSON.stringify(entries);
    return tauriInvoke('local_index_append', { accountId, mailbox, entriesJson });
  }
}

export async function removeFromLocalIndex(accountId, mailbox, uid) {
  if (IS_TAURI) {
    return tauriInvoke('local_index_remove', { accountId, mailbox, uid });
  }
}

export async function maildirDeleteMany(accountId, mailbox, uids) {
  if (IS_TAURI) {
    return tauriInvoke('maildir_delete_many', { accountId, mailbox, uids });
  }
  return { removed: 0 };
}

export async function backupPurgeUids(email, mailbox, uids) {
  if (IS_TAURI) {
    return tauriInvoke('backup_purge_uids', { email, mailbox, uids });
  }
  return { removed: 0, queued: 0 };
}

/**
 * Uids of this mailbox present in the external backup mirror, or null when we
 * cannot tell (no location configured, or the drive is not connected). Null is
 * not an empty set — see backup_scan_uids.
 */
export async function backupScanUids(email, mailbox) {
  if (IS_TAURI) {
    return tauriInvoke('backup_scan_uids', { email, mailbox });
  }
  return null;
}

/**
 * The configured external backup location, or null when it cannot be read.
 * Only `status` is used here, and only to tell the two halves of
 * `backupScanUids` returning null apart: a drive that is not connected is
 * "unknown", a location that was never set up is "there is no such place".
 */
export async function backupGetExternalLocation() {
  if (IS_TAURI) {
    return tauriInvoke('backup_get_external_location');
  }
  return null;
}

// ── Mail storage location (vault) ─────────────────────────────────────────────

export async function vaultGetStatus() {
  return tauriInvoke('vault_get_status', {});
}

/// Classify a folder the user picked, before committing to it.
export async function vaultInspectFolder(path) {
  return tauriInvoke('vault_inspect_folder', { path });
}

/// Point the app at a folder that already holds the mail.
export async function vaultAdopt(path) {
  return tauriInvoke('vault_adopt', { path });
}

/// Copy the mail to `path`, verify, delete the originals, switch over.
export async function vaultMoveTo(path) {
  return tauriInvoke('vault_move_to', { path });
}

/// Copy the mail back into the app's own storage, then drop the custom folder.
export async function vaultMoveToDefault() {
  return tauriInvoke('vault_move_to_default', {});
}

export async function vaultReset() {
  return tauriInvoke('vault_reset', {});
}

// ── Data transfer stats ─────────────────────────────────────────────────────

/// Per-account (or all-accounts, when accountId is omitted) up/down byte totals.
export async function getTransferStats(accountId = null) {
  return tauriInvoke('get_transfer_stats', accountId ? { accountId } : {});
}

// ── Backup ────────────────────────────────────────────────────────────────────

export async function backupRunAccount(accountId, accountJson, backupPath = null, skipFolders = 0) {
  return tauriInvoke('backup_run_account', { accountId, accountJson, backupPath, skipFolders: skipFolders || null });
}

export async function backupStatus(accountId, accountJson, backupPath = null) {
  return tauriInvoke('backup_status', { accountId, accountJson, backupPath });
}

export async function backupCancel() {
  return tauriInvoke('backup_cancel', {});
}

export async function sendNotification(title, body) {
  return tauriInvoke('send_notification', { title, body });
}

// ── Migration ────────────────────────────────────────────────────────────────

export async function startMigration(sourceAccount, destAccount, sourceTransport, destTransport, folderMappings, includeLocalArchive = false) {
  return await tauriInvoke('start_migration', {
    sourceAccount: JSON.stringify(sourceAccount),
    destAccount: JSON.stringify(destAccount),
    sourceTransport, destTransport, folderMappings, includeLocalArchive
  });
}

export async function cancelMigration() {
  return await tauriInvoke('cancel_migration');
}

// ── Restore (local → server) ────────────────────────────────────────────────

export async function startRestore(account, accountId, folders) {
  return await tauriInvoke('start_restore', {
    account: typeof account === 'string' ? account : JSON.stringify(account),
    accountId,
    folders,
  });
}

export async function cancelRestore() {
  return await tauriInvoke('cancel_restore', {});
}

export async function countLocalFolder(accountId, mailbox) {
  return await tauriInvoke('count_local_folder', { accountId, mailbox });
}

export async function pauseMigration() {
  return await tauriInvoke('pause_migration');
}

export async function resumeMigration(sourceAccount, destAccount, sourceTransport, destTransport) {
  return await tauriInvoke('resume_migration', {
    sourceAccount: JSON.stringify(sourceAccount),
    destAccount: JSON.stringify(destAccount),
    sourceTransport, destTransport
  });
}

export async function getMigrationState() {
  return await tauriInvoke('get_migration_state');
}

export async function clearMigrationState() {
  return await tauriInvoke('clear_migration_state_cmd');
}

export async function getFolderMappings(sourceAccount, destAccount, sourceTransport, destTransport) {
  return await tauriInvoke('get_folder_mappings', {
    sourceAccount: JSON.stringify(sourceAccount),
    destAccount: JSON.stringify(destAccount),
    sourceTransport, destTransport
  });
}

export async function countMigrationFolders(sourceAccount, sourceTransport, folderMappings) {
  return await tauriInvoke('count_migration_folders', {
    sourceAccount: JSON.stringify(sourceAccount),
    sourceTransport,
    folderMappings
  });
}

export async function removeMigratedEmails(incompleteMigration) {
  // Best-effort removal of migrated emails from destination.
  // Since we don't have individual UIDs of successfully migrated emails
  // stored in the frontend state, we cancel the migration (which stops
  // any in-progress work) and then clear state.
  // If removal fails, we surface the error so the UI can inform the user.
  const errors = [];
  try {
    await tauriInvoke('cancel_migration');
  } catch (e) {
    errors.push(e.toString());
  }
  // Always clear state regardless of removal success
  await clearMigrationState();
  if (errors.length > 0) {
    throw new Error(t('errors.removalPartiallyFailed', { errors: errors.join('; ') }));
  }
}
