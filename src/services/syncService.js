/**
 * Sync Service — triggers and monitors daemon-driven email sync.
 *
 * The daemon owns all IMAP connections. The app triggers sync via RPC
 * and reads results from local cache/Maildir.
 */

import { daemonCall } from './daemonClient.js';

/**
 * Trigger an immediate sync for an account.
 * Returns immediately — sync runs in the daemon background.
 *
 * @param {object} account - { id, email, imapConfig: { email, password, imapHost, imapPort, ... } }
 * @param {string} [mailbox='INBOX']
 * @returns {Promise<{ started: boolean, accountId: string, mailbox: string }>}
 */
export async function syncNow(account, mailbox = 'INBOX') {
  return daemonCall('sync.now', { account, mailbox });
}

/**
 * Wait for a sync to complete. The daemon holds the connection open
 * until sync finishes or times out — no polling needed.
 *
 * @param {string} accountId
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<{ account_id, mailbox, new_emails, total_emails, success, error? }>}
 */
export async function waitForSync(accountId, timeoutMs = 30000) {
  return daemonCall('sync.wait', { accountId, timeoutMs });
}

/**
 * Get sync status for an account or all accounts.
 *
 * @param {string} [accountId] - if omitted, returns all account states
 * @returns {Promise<object|Array>}
 */
export async function getSyncStatus(accountId) {
  const params = accountId ? { accountId } : {};
  return daemonCall('sync.status', params);
}
