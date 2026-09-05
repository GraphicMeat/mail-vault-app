/**
 * Sync Service — triggers and monitors daemon-driven email sync.
 *
 * The daemon owns all IMAP connections. The app triggers sync via RPC
 * and reads results from local cache/Maildir.
 */

import { daemonCall } from './daemonClient.js';
import { useSettingsStore, hasPremiumAccess } from '../stores/settingsStore.js';

/**
 * Trigger an immediate sync for an account.
 * Returns immediately — sync runs in the daemon background.
 * When the user has premium access, the daemon will also
 * classify new emails in the background after sync completes.
 *
 * The `ticket` names this sync and nothing else; pass it to `waitForSync`.
 *
 * @param {object} account - { id, email, imapConfig: { email, password, imapHost, imapPort, ... } }
 * @param {string} [mailbox='INBOX']
 * @returns {Promise<{ started: boolean, accountId: string, mailbox: string, ticket: number }>}
 */
export async function syncNow(account, mailbox = 'INBOX') {
  const autoClassify = hasPremiumAccess(useSettingsStore.getState().billingProfile);
  return daemonCall('sync.now', { account, mailbox, autoClassify });
}

/**
 * Wait for one specific sync to complete. The daemon holds the connection open
 * until that sync finishes or times out — no polling needed.
 *
 * Waiting by account is what this replaced: INBOX and Sent sync concurrently,
 * so the account's "last result" belonged to whichever finished first — and
 * after the first completion it came back instantly, forever.
 *
 * @param {number} ticket - from `syncNow`
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<{ account_id, mailbox, new_emails, total_emails, success, error? }>}
 */
export async function waitForSync(ticket, timeoutMs = 30000) {
  if (!Number.isFinite(ticket)) {
    throw new Error('sync.wait needs the ticket sync.now returned');
  }
  return daemonCall('sync.wait', { ticket, timeoutMs });
}

/**
 * Current sync state for an account, including `backfilling` — true while the
 * daemon is still filling a partly-cached mailbox from the server.
 *
 * @param {string} accountId
 * @returns {Promise<{ status, backfilling: boolean, total_emails?: number }>}
 */
export async function getSyncStatus(accountId) {
  return daemonCall('sync.status', { accountId });
}

// ── IDLE watchers and the change feed ───────────────────────────────────────

/**
 * The account shape the daemon's sync RPCs take: id, email and the IMAP half
 * of the config. The daemon deserializes these twelve names — a store account
 * carries a pile of UI-only keys besides, and none of them belong on a socket.
 *
 * @param {object} account - a store account row
 * @param {string} [id=account.id] - explicit id, for callers that know it first
 */
export function toSyncAccount(account, id = account.id) {
  return {
    id, email: account.email,
    imapConfig: {
      email: account.email, password: account.password,
      imapHost: account.imapHost, imapPort: account.imapPort,
      imapSecure: account.imapSecure, authType: account.authType,
      oauth2AccessToken: account.oauth2AccessToken,
      smtpHost: account.smtpHost, smtpPort: account.smtpPort,
      smtpSecure: account.smtpSecure, name: account.name,
      oauth2Transport: account.oauth2Transport,
    },
  };
}

/**
 * Ask the daemon to hold this account's INBOX in IDLE. Idempotent — the app
 * re-registers on every refresh so a freshly minted OAuth token reaches the
 * watcher, and an unchanged account is a no-op inside the daemon.
 *
 * No daemon means no IDLE, not a broken app: a missing daemon is swallowed
 * silently rather than warned about once per account per refresh.
 */
export async function watchAccount(account) {
  try {
    return await daemonCall('sync.watch', { account: toSyncAccount(account) });
  } catch (e) {
    if (e?.code !== 'DAEMON_OFFLINE' && e?.code !== 'NO_TAURI') {
      console.warn('[sync] watch failed:', e?.message || e);
    }
    return null;
  }
}

/** Drop an account's watcher. Best-effort — a removed account is gone either way. */
export async function unwatchAccount(accountId) {
  try { return await daemonCall('sync.unwatch', { accountId }); } catch { return null; }
}

/**
 * Long-poll the daemon's change feed: resolves when its generation passes
 * `since`, or after `timeoutMs` with `changes: []`.
 *
 * The reply's `gen` is the only cursor — adopt it as-is. The daemon's counter
 * restarts at 0 when the daemon does, and it answers a cursor from the future
 * at once with where it actually is; clamping upward parks the app on a
 * generation that will never come round again.
 *
 * @param {number} since
 * @param {number} [timeoutMs=25000] - the daemon clamps this to 60s
 * @returns {Promise<{ gen: number, changes: Array<{ gen, accountId, mailbox, newEmails, updatedFlags, at }> }>}
 */
export function waitForSyncChanges(since, timeoutMs = 25000) {
  return daemonCall('sync.events', { since, timeoutMs });
}
