// API module — routes all IMAP/SMTP/OAuth2 calls through Tauri invoke()
// In dev mode (no __TAURI__), falls back to the sidecar HTTP server.

const IS_TAURI = !!window.__TAURI__;

console.log('[api.js] Running in Tauri:', IS_TAURI);

// ── Tauri invoke helper ─────────────────────────────────────────────────────

let invoke = null;

const invokeReady = IS_TAURI
  ? import('@tauri-apps/api/core').then(mod => {
      invoke = mod.invoke;
      console.log('[api.js] Tauri invoke loaded');
    }).catch(err => {
      console.error('[api.js] Failed to load Tauri invoke:', err);
    })
  : Promise.resolve();

async function tauriInvoke(command, args = {}) {
  await invokeReady;
  if (!invoke) throw new ApiError('Tauri invoke not available', 0);
  try {
    return await invoke(command, args);
  } catch (error) {
    // Tauri invoke errors come as strings
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

export async function fetchEmailLight(account, uid, mailbox = 'INBOX', accountId = null) {
  if (IS_TAURI) {
    const params = { account, uid, mailbox };
    if (accountId) params.accountId = accountId;
    const data = await tauriInvoke('imap_get_email_light', params);
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

export async function sendEmail(account, email) {
  if (IS_TAURI) {
    return tauriInvoke('smtp_send_email', { account, email });
  }
  return httpRequest('/send', {
    method: 'POST',
    body: JSON.stringify({ account, email }),
  });
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

export async function graphGetMime(accessToken, messageId) {
  return await tauriInvoke('graph_get_mime', { accessToken, messageId });
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

export async function verifyArchivedEmails(accountId, mailbox, uids) {
  if (IS_TAURI) {
    return tauriInvoke('verify_archived_emails', { accountId, mailbox, uids });
  }
  return { verified: uids, missing: [] };
}

// ── Local index ───────────────────────────────────────────────────────────────

export async function readLocalIndex(accountId, mailbox) {
  if (IS_TAURI) {
    return tauriInvoke('local_index_read', { accountId, mailbox });
  }
  return null;
}

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
