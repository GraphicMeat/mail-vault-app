// ── db/index — re-exports the full db.js surface from its split modules ──
// Explicit list (rather than `export *`) so the public surface matches the
// original monolithic db.js exactly — internal cross-module helpers like
// loadKeychain/saveKeychain/accountDir stay implementation details.

export {
  parseKeychainValue,
  getAccountsFromKeychain,
  clearCredentialsCache,
  startKeychainLoad,
  onKeychainReady,
} from './keychain.js';

export {
  initBasic,
  initDB,
  saveAccount,
  getAccountsWithoutPasswords,
  accountLogicalKey,
  ensureAccountsInFile,
  getAccounts,
  getAccount,
  updateOAuth2Tokens,
  deleteAccount,
} from './accounts.js';

export {
  saveEmails,
  archiveEmail,
  getLocalEmailLight,
  getLocalEmails,
  readLocalEmailIndex,
  getArchivedEmails,
  getAllLocalEmails,
  deleteLocalEmail,
  isEmailSaved,
  getSavedEmailIds,
  getArchivedEmailIds,
  exportEmail,
  getStorageUsage,
  migrateMaildirEmailDirs,
  searchLocalEmails,
} from './emails.js';

export {
  saveMailboxes,
  getCachedMailboxEntry,
  getCachedMailboxes,
  saveEmailHeaders,
  getEmailHeadersPartial,
  getEmailHeadersMeta,
  getEmailHeaders,
  saveGraphIdMap,
  loadGraphIdMap,
} from './caches.js';
