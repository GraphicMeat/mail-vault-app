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

