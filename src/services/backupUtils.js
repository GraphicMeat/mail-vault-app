/**
 * Build the ZIP-internal path for a backup email file.
 * @param {string} email - Account email address
 * @param {string} mailbox - Mailbox name (e.g. "INBOX", "Sent")
 * @param {string} filename - Maildir filename (e.g. "123:2,AS")
 * @returns {string} Path like "emails/luke@example.com/INBOX/123:2,AS"
 */
export function buildBackupEmailPath(email, mailbox, filename) {
  return `emails/${email}/${mailbox}/${filename}`;
}

/**
 * Match manifest accounts to existing accounts by email address.
 * @param {Array<{email: string}>} manifestAccounts - Accounts from backup manifest
 * @param {Array<{id: string, email: string}>} existingAccounts - Currently configured accounts
 * @returns {Map<string, string|null>} Map of manifest email -> existing accountId (or null if not found)
 */
export function matchAccountsByEmail(manifestAccounts, existingAccounts) {
  const emailToId = new Map();
  for (const acct of existingAccounts) {
    if (acct.email) {
      emailToId.set(acct.email, acct.id);
    }
  }

  const result = new Map();
  for (const manifestAcct of manifestAccounts) {
    result.set(manifestAcct.email, emailToId.get(manifestAcct.email) || null);
  }
  return result;
}

/**
 * Parse and validate a backup manifest JSON string.
 * @param {string} jsonString - Raw JSON string from manifest.json
 * @returns {{ version: number, exportedAt: string, accounts: Array, settings: object|null }}
 * @throws {Error} If the manifest is invalid
 */
export function parseBackupManifest(jsonString) {
  const manifest = JSON.parse(jsonString);

  if (!manifest.version) {
    throw new Error('Invalid manifest: missing version');
  }
  if (!Array.isArray(manifest.accounts)) {
    throw new Error('Invalid manifest: missing accounts array');
  }

  return {
    version: manifest.version,
    exportedAt: manifest.exportedAt,
    accounts: manifest.accounts,
    settings: manifest.settings || null,
  };
}
