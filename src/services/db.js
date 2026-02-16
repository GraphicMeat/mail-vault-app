import { readTextFile, writeTextFile, readDir, mkdir, remove, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { parseKeychainValue, getAccountsFromKeychain } from './keychainUtils.js';

// Re-export for any consumers that import from db.js
export { parseKeychainValue, getAccountsFromKeychain };

// Use global Tauri API (more reliable in production builds)
const invoke = window.__TAURI__?.core?.invoke;

console.log('[db.js] Initializing (Maildir .eml)...');
console.log('[db.js] invoke available:', !!invoke);

if (invoke) {
  invoke('get_app_data_dir')
    .then(result => console.log('[db.js] Tauri invoke working. App data dir:', result))
    .catch(error => console.error('[db.js] Tauri invoke failed:', error));
}

let initialized = false;

// Keychain cache - stores full account objects (id, email, servers, password)
// Each value in the HashMap is a JSON-serialized account object.
// Format: { accountId: JSON.stringify({id, email, imapServer, smtpServer, password, createdAt}) }
let keychainCache = null;
let keychainLoaded = false;

async function loadKeychain() {
  if (keychainLoaded) return keychainCache || {};
  if (!invoke) { keychainLoaded = true; return {}; }

  try {
    console.log('[db.js] Loading accounts from keychain...');
    keychainCache = await invoke('get_credentials');
    keychainLoaded = true;
    console.log('[db.js] Keychain loaded for', Object.keys(keychainCache).length, 'account(s)');
    return keychainCache;
  } catch (error) {
    console.log('[db.js] No keychain data found or error:', error);
    keychainCache = {};
    keychainLoaded = true;
    return keychainCache;
  }
}

async function saveKeychain(data) {
  if (!invoke) return;
  try {
    await invoke('store_credentials', { credentials: data });
    keychainCache = data;
    console.log('[db.js] Keychain saved for', Object.keys(data).length, 'account(s)');
  } catch (error) {
    console.error('[db.js] Failed to save keychain:', error);
    throw error;
  }
}

export function clearCredentialsCache() {
  keychainCache = null;
  keychainLoaded = false;
}

// --- File helpers (accounts.json only) ---

const ACCOUNTS_FILE = 'accounts.json';
const MAILDIR = 'Maildir';

async function ensureDir(path) {
  try {
    const dirExists = await exists(path, { baseDir: BaseDirectory.AppData });
    if (!dirExists) {
      await mkdir(path, { baseDir: BaseDirectory.AppData, recursive: true });
    }
  } catch {
    await mkdir(path, { baseDir: BaseDirectory.AppData, recursive: true });
  }
}

async function readAccountsFile() {
  try {
    const fileExists = await exists(ACCOUNTS_FILE, { baseDir: BaseDirectory.AppData });
    if (!fileExists) return [];
    const data = await readTextFile(ACCOUNTS_FILE, { baseDir: BaseDirectory.AppData });
    return JSON.parse(data);
  } catch (error) {
    console.warn('[db.js] Failed to read accounts.json:', error);
    return [];
  }
}

async function writeAccountsFile(accounts) {
  await writeTextFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), { baseDir: BaseDirectory.AppData });
}

function accountDir(accountId) {
  return `${MAILDIR}/${accountId}`;
}

// localId format: {uuid}-{mailbox}-{uid}
// UUID v4 is always 36 chars (8-4-4-4-12), uid is always numeric
function parseLocalId(localId) {
  const match = localId.match(/^(.{36})-(.+)-(\d+)$/);
  if (!match) return null;
  return { accountId: match[1], mailbox: match[2], uid: match[3] };
}

// --- Init ---

// Lightweight init: directories + accounts.json only. NO keychain access.
// Used by quick-load to show cached data before keychain prompt.
let basicInitDone = false;

export async function initBasic() {
  if (basicInitDone) return;

  // Ensure base directories exist
  await ensureDir(MAILDIR);

  // Ensure accounts.json exists
  try {
    const fileExists = await exists(ACCOUNTS_FILE, { baseDir: BaseDirectory.AppData });
    if (!fileExists) {
      await writeAccountsFile([]);
    }
  } catch {
    await writeAccountsFile([]);
  }

  basicInitDone = true;
  console.log('[db.js] Basic init done (no keychain)');
}

export async function initDB() {
  if (initialized) return;

  await initBasic();

  // Run one-time migration from .json to .eml (idempotent)
  if (invoke) {
    try {
      const result = await invoke('maildir_migrate_json_to_eml');
      console.log('[db.js] Migration:', result);
    } catch (e) {
      console.warn('[db.js] Migration failed (non-fatal):', e);
    }
  }

  // Clean up legacy keychain entries that have no email (just { id, password })
  if (invoke) {
    try {
      const data = await loadKeychain();
      const allKeys = Object.keys(data);
      const keysToRemove = [];

      for (const key of allKeys) {
        const account = parseKeychainValue(key, data[key]);
        if (!account.email) {
          keysToRemove.push(key);
        }
      }

      if (keysToRemove.length > 0) {
        console.log('[db.js] Removing', keysToRemove.length, 'legacy keychain entries without email:', keysToRemove);
        for (const key of keysToRemove) {
          delete data[key];
        }
        await saveKeychain(data);
        console.log('[db.js] Legacy keychain cleanup complete');
      }
    } catch (e) {
      console.warn('[db.js] Legacy keychain cleanup failed (non-fatal):', e);
    }
  }

  initialized = true;
  console.log('[db.js] Maildir .eml storage initialized');
}

// --- Account operations ---

export async function saveAccount(account) {
  console.log('[db.js] saveAccount called', { accountId: account.id, hasPassword: !!account.password });
  await initDB();

  // Store full account (including password) in keychain
  if (invoke) {
    try {
      const data = await loadKeychain();
      data[account.id] = JSON.stringify(account);
      await saveKeychain(data);
      console.log('[db.js] Account stored in keychain');
    } catch (error) {
      console.error('[db.js] Failed to store account in keychain:', error);
      throw error;
    }
  }

  // Also write metadata (no password) to accounts.json for quick loading
  const { password, ...acctData } = account;
  const accounts = await readAccountsFile();
  const idx = accounts.findIndex(a => a.id === acctData.id);
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], ...acctData };
  } else {
    accounts.push(acctData);
  }
  await writeAccountsFile(accounts);
  console.log('[db.js] Account metadata saved to accounts.json');
  return account;
}

export async function getAccountsWithoutPasswords() {
  await initBasic();
  return await readAccountsFile();
}

// Ensure account metadata (no password) exists in accounts.json for quick-load.
// Called after full init to backfill from keychain data.
export async function ensureAccountInFile(account) {
  const accounts = await readAccountsFile();
  if (accounts.some(a => a.id === account.id)) return;
  const { password, ...acctData } = account;
  accounts.push(acctData);
  await writeAccountsFile(accounts);
  console.log('[db.js] Backfilled account to accounts.json:', account.email);
}

export async function getAccounts() {
  await initDB();

  if (invoke) {
    const data = await loadKeychain();
    const keychainAccounts = getAccountsFromKeychain(data);

    // Filter to only valid accounts (must have email)
    const validAccounts = keychainAccounts.filter(a => a.email);

    if (validAccounts.length > 0) {
      return validAccounts;
    }

    // Legacy fallback: keychain only has passwords, combine with accounts.json
    const fileAccounts = await readAccountsFile();
    return fileAccounts.map(a => ({
      ...a,
      password: data[a.id] || undefined
    }));
  }
  return await readAccountsFile();
}

export async function getAccount(id) {
  await initDB();

  if (invoke) {
    const data = await loadKeychain();
    if (data[id]) {
      const account = parseKeychainValue(id, data[id]);
      if (account.email) return account;
    }
  }

  // Fallback to accounts.json (no password)
  const accounts = await readAccountsFile();
  return accounts.find(a => a.id === id);
}

export async function deleteAccount(id) {
  await initDB();

  // Remove from keychain
  if (invoke) {
    try {
      const data = await loadKeychain();
      delete data[id];
      await saveKeychain(data);
      console.log('[db.js] Account removed from keychain:', id);
    } catch (error) {
      console.error('[db.js] Failed to remove account from keychain:', error);
    }
  }

  // Remove from accounts.json
  const accounts = await readAccountsFile();
  const filtered = accounts.filter(a => a.id !== id);
  await writeAccountsFile(filtered);

  // Remove Maildir/{accountId}/ directory
  try {
    const dirPath = accountDir(id);
    const dirExists = await exists(dirPath, { baseDir: BaseDirectory.AppData });
    if (dirExists) {
      await remove(dirPath, { baseDir: BaseDirectory.AppData, recursive: true });
    }
  } catch (error) {
    console.warn('[db.js] Failed to remove account Maildir:', error);
  }

  // Clear email headers cache for this account
  if (invoke) {
    try {
      await invoke('clear_email_cache', { accountId: id });
    } catch (error) {
      console.warn('[db.js] Failed to clear email cache:', error);
    }
  }
}

// --- Email operations (Rust Maildir commands) ---

export async function saveEmail(email, accountId, mailbox) {
  await initDB();
  if (!invoke) throw new Error('Tauri invoke not available');

  if (!email.rawSource) {
    console.warn('[db.js] Email UID', email.uid, 'has no rawSource, cannot save as .eml');
    throw new Error('Email has no rawSource for .eml storage');
  }

  await invoke('maildir_store', {
    accountId,
    mailbox,
    uid: email.uid,
    rawSourceBase64: email.rawSource,
    flags: ['seen'],
  });

  return { ...email, localId: `${accountId}-${mailbox}-${email.uid}` };
}

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
      flags: ['seen'],
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

export async function getLocalEmail(accountId, mailbox, uid) {
  await initDB();
  if (!invoke) return undefined;

  try {
    const email = await invoke('maildir_read', { accountId, mailbox, uid: parseInt(uid, 10) });
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
    const emails = [];
    for (const summary of summaries) {
      try {
        const email = await invoke('maildir_read', { accountId, mailbox, uid: summary.uid });
        if (email) emails.push({ ...email, localId: `${accountId}-${mailbox}-${summary.uid}`, isArchived: summary.isArchived });
      } catch (e) {
        console.warn(`[db.js] Failed to read email UID ${summary.uid}:`, e);
      }
    }
    return emails;
  } catch {
    return [];
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

export async function deleteLocalEmails(localIds) {
  for (const localId of localIds) {
    await deleteLocalEmail(localId);
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
  } catch {
    return new Set();
  }
}

export async function exportEmail(localId) {
  await initDB();
  const parsed = parseLocalId(localId);
  if (!parsed || !invoke) return null;

  try {
    const email = await invoke('maildir_read', {
      accountId: parsed.accountId,
      mailbox: parsed.mailbox,
      uid: parseInt(parsed.uid, 10),
    });
    if (!email) return null;

    // rawSource is base64-encoded
    return {
      filename: `${(email.subject || 'email').replace(/[^a-zA-Z0-9]/g, '_')}.eml`,
      content: atob(email.rawSource),
      rawBase64: email.rawSource,
      mimeType: 'message/rfc822'
    };
  } catch {
    return null;
  }
}

// --- Email headers cache ---
// Uses file-based caching via Tauri commands (unchanged)

export async function saveEmailHeaders(accountId, mailbox, emails, totalEmails) {
  const cacheEntry = {
    accountId,
    mailbox,
    emails,
    totalEmails,
    lastSynced: Date.now()
  };

  if (invoke) {
    try {
      const data = JSON.stringify(cacheEntry);
      await invoke('save_email_cache', { accountId, mailbox, data });
      console.log('[db.js] Email headers saved to file cache:', emails.length, 'emails');
    } catch (error) {
      console.warn('[db.js] Failed to save to file cache:', error);
    }
  }

  return cacheEntry;
}

export async function getEmailHeaders(accountId, mailbox) {
  if (invoke) {
    try {
      const data = await invoke('load_email_cache', { accountId, mailbox });
      if (data) {
        const entry = JSON.parse(data);
        console.log('[db.js] Email headers loaded from file cache:', entry.emails?.length, 'emails');
        return {
          emails: entry.emails,
          totalEmails: entry.totalEmails,
          lastSynced: entry.lastSynced
        };
      }
    } catch (error) {
      console.warn('[db.js] Failed to load from file cache:', error);
    }
  }

  return null;
}

export async function clearEmailHeadersCache(accountId) {
  if (invoke) {
    try {
      await invoke('clear_email_cache', { accountId: accountId || null });
      console.log('[db.js] File-based email cache cleared for:', accountId || 'all accounts');
    } catch (error) {
      console.warn('[db.js] Failed to clear file cache:', error);
    }
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
