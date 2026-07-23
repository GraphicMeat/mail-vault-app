// ── db/accounts — accounts.json + keychain account CRUD, dedup, bootstrapping ──

import { readTextFile, writeTextFile, exists, mkdir, remove, BaseDirectory } from '@tauri-apps/plugin-fs';
import { send as transportSend } from '../transport.js';
import { isPersonalMicrosoftEmail } from '../graphConfig.js';
import { parseKeychainValue, getAccountsFromKeychain, loadKeychain, saveKeychain } from './keychain.js';

// Transport-aware invoke: tries daemon socket first, falls back to Tauri invoke
const invoke = (cmd, args) => transportSend(cmd, args);

let initialized = false;

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

export function accountDir(accountId) {
  return `${MAILDIR}/${accountId}`;
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

  // Stamp a host change so post-sync detection can offer to restore local mail
  // to a freshly-migrated server. Best-effort: a missing prior account (first
  // save) simply has nothing to compare.
  try {
    const prior = await getAccount(account.id);
    if (prior && prior.imapHost && account.imapHost && prior.imapHost !== account.imapHost) {
      account.previousImapHost = prior.imapHost;
      account.hostChangedAt = Date.now();
    }
  } catch { /* first save — nothing to compare */ }

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

  // Also write metadata (no secrets) to accounts.json for quick loading
  const { password, oauth2AccessToken, oauth2RefreshToken, ...acctData } = account;
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
/**
 * Logical account identity key — same email + same server/provider = same account.
 * Used to detect duplicates across keychain and accounts.json.
 */
export function accountLogicalKey(a) {
  const email = (a.email || '').toLowerCase();
  const server = (a.imapHost || a.oauth2Provider || '').toLowerCase();
  return `${email}@${server}`;
}

/**
 * Deduplicate accounts by logical identity (email + server/provider).
 * Prefers accounts with credentials (password/token) over empty ones.
 * Prefers keychain-sourced accounts over file-only accounts.
 */
function deduplicateAccounts(accounts) {
  const seen = new Map(); // logicalKey → account
  const deduped = [];

  for (const account of accounts) {
    const key = accountLogicalKey(account);
    if (seen.has(key)) {
      const existing = seen.get(key);
      // Prefer the one with credentials
      const existingHasCreds = !!(existing.password || existing.oauth2RefreshToken);
      const newHasCreds = !!(account.password || account.oauth2RefreshToken);
      if (newHasCreds && !existingHasCreds) {
        // Replace with the credentialed version
        const idx = deduped.indexOf(existing);
        if (idx >= 0) deduped[idx] = account;
        seen.set(key, account);
        console.log(`[db.js] Dedup: replaced ${existing.id} with ${account.id} for ${account.email} (has credentials)`);
      } else {
        console.log(`[db.js] Dedup: skipping duplicate ${account.id} for ${account.email} (keeping ${existing.id})`);
      }
    } else {
      seen.set(key, account);
      deduped.push(account);
    }
  }

  if (deduped.length < accounts.length) {
    console.log(`[db.js] Deduplicated ${accounts.length - deduped.length} duplicate account(s)`);
  }

  return deduped;
}

// Batch version: reads accounts.json once, merges all missing accounts, writes once.
export async function ensureAccountsInFile(accounts) {
  const existing = await readAccountsFile();
  const existingIds = new Set(existing.map(a => a.id));
  const existingKeys = new Set(existing.map(a => accountLogicalKey(a)));
  const newAccounts = accounts
    .filter(a => !existingIds.has(a.id) && !existingKeys.has(accountLogicalKey(a)))
    .map(({ password, oauth2AccessToken, oauth2RefreshToken, ...acctData }) => acctData);
  if (newAccounts.length > 0) {
    await writeAccountsFile([...existing, ...newAccounts]);
    console.log('[db.js] Backfilled', newAccounts.length, 'accounts to accounts.json');
  }
}

export async function getAccounts() {
  await initDB();

  let accounts;

  if (invoke) {
    const data = await loadKeychain();
    const keychainAccounts = getAccountsFromKeychain(data);

    // Filter to only valid accounts (must have email)
    const validAccounts = keychainAccounts.filter(a => a.email);

    // Always read file accounts as a fallback — merge to ensure no accounts are lost
    // when keychain times out and returns fewer accounts
    const fileAccounts = await readAccountsFile();

    if (validAccounts.length > 0) {
      // Merge: keychain is authoritative, but include file-only accounts (missing from keychain due to timeout)
      // Use both id AND logical key to prevent duplicates from 2.3.2 upgrade path
      const keychainIds = new Set(validAccounts.map(a => a.id));
      const keychainKeys = new Set(validAccounts.map(a => accountLogicalKey(a)));
      const fileOnly = fileAccounts.filter(a => !keychainIds.has(a.id) && !keychainKeys.has(accountLogicalKey(a)));
      if (fileOnly.length > 0) {
        console.log(`[db.js] ${fileOnly.length} account(s) from file not in keychain — adding without credentials`);
      }
      accounts = [...validAccounts, ...fileOnly];
    } else {
      // Keychain empty (timeout or fresh install) — use file accounts with whatever passwords are available
      accounts = fileAccounts.map(a => ({
        ...a,
        password: data[a.id] || undefined
      }));
    }

    // Deduplicate by logical identity (email + server/provider)
    accounts = deduplicateAccounts(accounts);

    // One-time cleanup: remove duplicates from accounts.json
    const cleanedFile = deduplicateAccounts(fileAccounts);
    if (cleanedFile.length < fileAccounts.length) {
      console.log(`[db.js] Cleaning up ${fileAccounts.length - cleanedFile.length} duplicate(s) from accounts.json`);
      const cleanedWithoutCreds = cleanedFile.map(({ password, oauth2AccessToken, oauth2RefreshToken, ...rest }) => rest);
      await writeAccountsFile(cleanedWithoutCreds).catch(e => console.warn('[db.js] Failed to clean accounts.json:', e));
    }
  } else {
    accounts = deduplicateAccounts(await readAccountsFile());
  }

  // Auto-repair: personal Microsoft accounts must use Graph transport.
  // Older saved accounts may have oauth2Transport: 'imap' which fails with XOAUTH2.
  let repaired = false;
  for (const account of accounts) {
    if (account.authType === 'oauth2' && isPersonalMicrosoftEmail(account.email) && account.oauth2Transport !== 'graph') {
      console.log(`[db.js] Auto-repairing ${account.email}: switching oauth2Transport from '${account.oauth2Transport}' to 'graph'`);
      account.oauth2Transport = 'graph';
      repaired = true;
    }
  }

  // Persist the repair to keychain so it's permanent
  if (repaired && invoke) {
    try {
      const credentials = {};
      for (const a of accounts) {
        credentials[a.id] = JSON.stringify(a);
      }
      await invoke('store_credentials', { credentials });
      console.log('[db.js] Persisted auto-repaired account transports to keychain');
    } catch (e) {
      console.warn('[db.js] Failed to persist transport repair:', e);
    }
  }

  return accounts;
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

export async function updateOAuth2Tokens(accountId, tokens) {
  if (!invoke) return;

  try {
    const data = await loadKeychain();
    if (!data[accountId]) return;

    const account = JSON.parse(data[accountId]);
    account.oauth2AccessToken = tokens.accessToken;
    account.oauth2RefreshToken = tokens.refreshToken || account.oauth2RefreshToken;
    account.oauth2ExpiresAt = tokens.expiresAt;

    data[accountId] = JSON.stringify(account);
    await saveKeychain(data);
    console.log('[db.js] OAuth2 tokens updated for account:', accountId);
    return account;
  } catch (error) {
    console.error('[db.js] Failed to update OAuth2 tokens:', error);
    throw error;
  }
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

    // Clear mailbox cache
    try {
      await invoke('delete_mailbox_cache', { accountId: id });
    } catch (error) {
      console.warn('[db.js] Failed to clear mailbox cache:', error);
    }
  }
}
