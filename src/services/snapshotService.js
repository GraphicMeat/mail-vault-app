/**
 * Snapshot Service — manages Time Capsule snapshots via the daemon.
 *
 * Snapshots are lightweight JSON manifests listing every email's UID, subject,
 * sender, date, flags, and size at a point in time. The .eml files themselves
 * are always preserved in local Maildir storage.
 */

import { daemonCall } from './daemonClient.js';

/**
 * Create a snapshot from provided email data.
 * Called after a backup completes with the current mailbox state.
 *
 * @param {string} accountId
 * @param {string} accountEmail
 * @param {Object} mailboxes - { [mailboxName]: { total_emails, emails: [{uid, subject, from, date, flags, size}] } }
 * @returns {Promise<{ timestamp, filename, size_bytes, total_emails, mailbox_count }>}
 */
export async function createSnapshot(accountId, accountEmail, mailboxes) {
  return daemonCall('snapshot.create', { accountId, accountEmail, mailboxes });
}

/**
 * Create a snapshot by scanning the local Maildir on disk.
 * Useful for manual "take snapshot now" without a full backup.
 * Note: email metadata (subject, from, date) may be incomplete since
 * it only reads filenames, not .eml contents.
 *
 * @param {string} accountId
 * @param {string} accountEmail
 * @returns {Promise<{ timestamp, filename, size_bytes, total_emails, mailbox_count }>}
 */
export async function createSnapshotFromMaildir(accountId, accountEmail) {
  return daemonCall('snapshot.create_from_maildir', { accountId, accountEmail });
}

/**
 * List all snapshots for an account, newest first.
 *
 * @param {string} accountId
 * @returns {Promise<Array<{ timestamp, filename, size_bytes, total_emails, mailbox_count }>>}
 */
export async function listSnapshots(accountId) {
  return daemonCall('snapshot.list', { accountId });
}

/**
 * Load a full snapshot manifest by filename.
 *
 * @param {string} accountId
 * @param {string} filename - e.g. "2026-04-03T10-30-00.000Z.json.gz"
 * @returns {Promise<{ account_id, account_email, timestamp, mailboxes }>}
 */
export async function loadSnapshot(accountId, filename) {
  return daemonCall('snapshot.load', { accountId, filename });
}

/**
 * Delete a snapshot by filename.
 *
 * @param {string} accountId
 * @param {string} filename
 * @returns {Promise<{ deleted: true }>}
 */
export async function deleteSnapshot(accountId, filename) {
  return daemonCall('snapshot.delete', { accountId, filename });
}
