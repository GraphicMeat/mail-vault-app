import { readTextFile, writeTextFile, readDir, mkdir, remove, exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { parseKeychainValue, getAccountsFromKeychain } from './keychainUtils.js';
import * as keychainSession from './keychainSession.js';

// Re-export for any consumers that import from db.js
export { parseKeychainValue, getAccountsFromKeychain };

// Use global Tauri API (more reliable in production builds)
const invoke = window.__TAURI__?.core?.invoke;

console.log('[db.js] Initializing (Maildir .eml)...');
console.log('[db.js] invoke available:', !!invoke);

if (invoke) {
  invoke('get_app_data_dir')
    .then(result => {
      console.log('[db.js] Tauri invoke working. App data dir:', result);
      _isSnap = typeof result === 'string' && result.includes('/snap/');
    })
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
  if (!invoke) { keychainLoaded = true; keychainSession.recordOutcome('empty'); return {}; }

  // If a keychain load is already in flight, reuse the shared promise
  if (_keychainLoadPromise) {
    await _keychainLoadPromise;
    return keychainCache || {};
  }

  // If the session is locked out (user denied/cancelled), don't re-prompt automatically
  if (keychainSession.isLockedOut()) {
    console.log('[db.js] Keychain session locked out — skipping automatic read');
    keychainCache = keychainCache || {};
    keychainLoaded = true;
    return keychainCache;
  }

  // Single attempt — no retry loop. The Rust side has its own timeout+retry.
  _keychainLoadPromise = (async () => {
    try {
      console.log('[db.js] Loading accounts from keychain...');
      keychainSession.recordOutcome('requesting');
      const result = await invoke('get_credentials');

      // Structured response: { status, credentials?, message? }
      const status = result?.status || 'unavailable';
      const credentials = result?.credentials || {};
      const message = result?.message || null;
      const count = Object.keys(credentials).length;

      keychainSession.recordOutcome(status, message);

      if (status === 'granted' || status === 'empty') {
        keychainCache = credentials;
        keychainLoaded = true;
        console.log('[db.js] Keychain loaded:', status, `(${count} account(s))`);
      } else {
        // denied, cancelled, timed_out, unavailable
        console.warn(`[db.js] Keychain access: ${status}${message ? ' — ' + message : ''}`);
        if (isSnap() && status === 'unavailable') {
          console.error('[db.js] Snap keyring access failed — password-manager-service plug may be disconnected');
        }
        keychainCache = {};
        keychainLoaded = true;
      }
    } catch (error) {
      console.warn('[db.js] Keychain read threw:', error);
      keychainSession.recordOutcome('unavailable', String(error));
      keychainCache = {};
      keychainLoaded = true;
    }
  })();

  await _keychainLoadPromise;
  return keychainCache || {};
}

let _keychainWriteQueue = [];
let _keychainWriteRunning = false;

async function saveKeychain(data) {
  if (!invoke) return;

  // Safety: if new data has fewer entries than cached, merge with cache to prevent data loss.
  // This handles the case where loadKeychain() returned partial/empty data due to timeout.
  const newCount = Object.keys(data).length;
  const cachedCount = Object.keys(keychainCache || {}).length;
  if (newCount < cachedCount && cachedCount > 0) {
    console.warn(`[db.js] saveKeychain: merging — new data has ${newCount} entries but cache has ${cachedCount}, preserving existing`);
    data = { ...keychainCache, ...data };
  }

  // Queue writes to prevent concurrent overwrites
  return new Promise((resolve, reject) => {
    _keychainWriteQueue.push({ data, resolve, reject });
    _processKeychainQueue();
  });
}

async function _processKeychainQueue() {
  if (_keychainWriteRunning || _keychainWriteQueue.length === 0) return;
  _keychainWriteRunning = true;

  while (_keychainWriteQueue.length > 0) {
    // Take the latest write (skip stale intermediate writes)
    const pending = _keychainWriteQueue.splice(0);
    const latest = pending[pending.length - 1];
    // Resolve all earlier pending writes silently
    for (let i = 0; i < pending.length - 1; i++) pending[i].resolve();

    let retries = 0;
    const maxRetries = 3;
    while (retries < maxRetries) {
      try {
        await invoke('store_credentials', { credentials: latest.data });
        keychainCache = latest.data;
        console.log('[db.js] Keychain saved for', Object.keys(latest.data).length, 'account(s)');
        latest.resolve();
        break;
      } catch (error) {
        retries++;
        console.warn(`[db.js] Keychain write failed (attempt ${retries}/${maxRetries}):`, error);
        if (retries < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * retries)); // 1s, 2s, 3s backoff
        } else {
          console.error('[db.js] Keychain write failed after all retries:', error);
          latest.reject(error);
        }
      }
    }
  }

  _keychainWriteRunning = false;
}


// Detect snap confinement by checking if app data dir is under ~/snap/
let _isSnap = null;
function isSnap() {
  return _isSnap === true;
}

export function clearCredentialsCache() {
  keychainCache = null;
  keychainLoaded = false;
  _keychainResolved = false;
  _keychainLoadPromise = null;
  keychainSession.resetForRetry();
}

// Fire-and-forget keychain loading with callback notification
let _keychainReadyCallbacks = [];
let _keychainResolved = false;
let _keychainLoadPromise = null;

/**
 * Start loading keychain in background. Does NOT block.
 * Register onKeychainReady() to be notified when credentials are available.
 */
export function startKeychainLoad() {
  if (_keychainLoadPromise || keychainLoaded) {
    // Already loading or loaded — notify immediately if resolved
    if (keychainLoaded) {
      _keychainResolved = true;
      const cbs = _keychainReadyCallbacks;
      _keychainReadyCallbacks = [];
      cbs.forEach(cb => cb(null, keychainCache));
    }
    return;
  }

  _keychainLoadPromise = loadKeychain()
    .then((data) => {
      _keychainResolved = true;
      const cbs = _keychainReadyCallbacks;
      _keychainReadyCallbacks = [];
      cbs.forEach(cb => cb(null, data));
    })
    .catch((err) => {
      _keychainResolved = true;
      const cbs = _keychainReadyCallbacks;
      _keychainReadyCallbacks = [];
      cbs.forEach(cb => cb(err, null));
    });
}

/**
 * Register a callback for when keychain credentials become available.
 * If already resolved, fires immediately.
 */
export function onKeychainReady(callback) {
  if (_keychainResolved || keychainLoaded) {
    callback(null, keychainCache);
    return;
  }
  _keychainReadyCallbacks.push(callback);
}

export function isKeychainLoaded() {
  return keychainLoaded;
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
export async function ensureAccountInFile(account) {
  const accounts = await readAccountsFile();
  if (accounts.some(a => a.id === account.id)) return;
  const { password, ...acctData } = account;
  accounts.push(acctData);
  await writeAccountsFile(accounts);
  console.log('[db.js] Backfilled account to accounts.json:', account.email);
}

// Batch version: reads accounts.json once, merges all missing accounts, writes once.
export async function ensureAccountsInFile(accounts) {
  const existing = await readAccountsFile();
  const existingIds = new Set(existing.map(a => a.id));
  const newAccounts = accounts
    .filter(a => !existingIds.has(a.id))
    .map(({ password, oauth2AccessToken, oauth2RefreshToken, ...acctData }) => acctData);
  if (newAccounts.length > 0) {
    await writeAccountsFile([...existing, ...newAccounts]);
    console.log('[db.js] Backfilled', newAccounts.length, 'accounts to accounts.json');
  }
}

export async function getAccounts() {
  await initDB();

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
      const keychainIds = new Set(validAccounts.map(a => a.id));
      const fileOnly = fileAccounts.filter(a => !keychainIds.has(a.id));
      if (fileOnly.length > 0) {
        console.log(`[db.js] ${fileOnly.length} account(s) from file not in keychain — adding without credentials`);
      }
      return [...validAccounts, ...fileOnly];
    }

    // Keychain empty (timeout or fresh install) — use file accounts with whatever passwords are available
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
      flags: ['archived', 'seen'],
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

export async function getLocalEmailLight(accountId, mailbox, uid) {
  await initDB();
  if (!invoke) return undefined;

  try {
    const email = await invoke('maildir_read_light', { accountId, mailbox, uid: parseInt(uid, 10) });
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
    if (summaries.length === 0) return [];

    // Build archive flag lookup
    const archivedUids = new Set(summaries.filter(s => s.isArchived).map(s => s.uid));
    const uids = summaries.map(s => s.uid);

    // Batch read all emails in a single IPC call
    const results = await invoke('maildir_read_light_batch', { accountId, mailbox, uids });
    const emails = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i]) {
        emails.push({
          ...results[i],
          localId: `${accountId}-${mailbox}-${uids[i]}`,
          isArchived: archivedUids.has(uids[i])
        });
      }
    }
    return emails;
  } catch {
    return [];
  }
}

/**
 * Read local-index.json for fast archived email metadata.
 * Returns null if the file doesn't exist (caller should fall back to getLocalEmails).
 */
export async function readLocalEmailIndex(accountId, mailbox) {
  await initBasic();
  if (!invoke) return null;
  try {
    const data = await invoke('local_index_read', { accountId, mailbox });
    if (data) {
      const entries = JSON.parse(data);
      return entries.map(e => ({
        ...e,
        source: 'local',
        isLocal: true,
        isArchived: true,
      }));
    }
  } catch (e) {
    console.warn('[db] Failed to read local-index.json:', e);
  }
  return null;
}

/**
 * Load only archived emails from Maildir (fast — reads only archived .eml files, not all).
 * Uses archivedEmailIds (already loaded via fast maildir_list) to read only the subset.
 */
/**
 * Load archived email headers for instant display.
 *
 * Strategy (fast path first):
 * 1. Try sidecar cache (email_cache/{uid}.json) — already populated by IMAP sync.
 *    Reads only the specific UID files we need. Instant for most archived emails.
 * 2. For UIDs not in sidecar: try archived_headers.json (populated after first full load)
 * 3. Last resort: batch-load from .eml files (slow — MIME parsing)
 * 4. Save results to archived_headers.json for next time
 */
export async function getArchivedEmails(accountId, mailbox, archivedUidSet, onBatch) {
  await initBasic();
  if (!invoke || !archivedUidSet || archivedUidSet.size === 0) return [];

  const uids = Array.from(archivedUidSet).sort((a, b) => b - a); // newest first
  console.log('[db] getArchivedEmails: %d UIDs', uids.length);

  // 1. Fast path: read from sidecar cache (email_cache/{uid}.json)
  // These are already written by IMAP sync — no .eml parsing needed
  let sidecarEmails = [];
  try {
    sidecarEmails = await invoke('load_email_cache_by_uids', {
      accountId, mailbox, uids
    });
  } catch (e) {
    console.warn('[db] getArchivedEmails: sidecar load failed:', e);
  }

  if (sidecarEmails.length > 0) {
    const emails = sidecarEmails.map(e => ({
      ...e,
      localId: `${accountId}-${mailbox}-${e.uid}`,
      isArchived: true
    }));
    console.log('[db] getArchivedEmails: sidecar hit %d/%d UIDs', emails.length, uids.length);
    if (onBatch) onBatch(emails);

    // If sidecar covered all UIDs, we're done
    if (emails.length >= uids.length * 0.9) {
      return emails;
    }

    // Some UIDs missing from sidecar — find which ones
    const foundUids = new Set(emails.map(e => e.uid));
    const missingUids = uids.filter(uid => !foundUids.has(uid));
    if (missingUids.length === 0) return emails;

    // Load missing from .eml files
    console.log('[db] getArchivedEmails: %d UIDs missing from sidecar, loading from .eml', missingUids.length);
    const BATCH_SIZE = 200;
    try {
      for (let i = 0; i < missingUids.length; i += BATCH_SIZE) {
        const batchUids = missingUids.slice(i, i + BATCH_SIZE);
        const results = await invoke('maildir_read_light_batch', { accountId, mailbox, uids: batchUids });
        for (let j = 0; j < results.length; j++) {
          if (results[j]) {
            emails.push({
              ...results[j],
              localId: `${accountId}-${mailbox}-${batchUids[j]}`,
              isArchived: true
            });
          }
        }
        if (onBatch) onBatch([...emails]);
      }
    } catch (e) {
      console.warn('[db] getArchivedEmails: .eml fallback failed:', e);
    }
    return emails;
  }

  // 2. No sidecar data — try archived_headers.json cache
  try {
    const cached = await invoke('maildir_read_archived_cached', {
      accountId, mailbox, expectedCount: uids.length
    });
    if (cached && cached.length > 0) {
      const emails = cached.map(e => ({
        ...e,
        localId: `${accountId}-${mailbox}-${e.uid}`,
        isArchived: true
      }));
      console.log('[db] getArchivedEmails: archived cache hit, %d emails', emails.length);
      if (onBatch) onBatch(emails);
      return emails;
    }
  } catch {
    // Fall through
  }

  // 3. Last resort: batch load from .eml files (slow — MIME parsing)
  console.log('[db] getArchivedEmails: full .eml fallback for %d UIDs', uids.length);
  const BATCH_SIZE = 200;
  const allEmails = [];
  try {
    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
      const batchUids = uids.slice(i, i + BATCH_SIZE);
      const results = await invoke('maildir_read_light_batch', { accountId, mailbox, uids: batchUids });
      for (let j = 0; j < results.length; j++) {
        if (results[j]) {
          allEmails.push({
            ...results[j],
            localId: `${accountId}-${mailbox}-${batchUids[j]}`,
            isArchived: true
          });
        }
      }
      console.log('[db] getArchivedEmails: batch %d/%d, loaded: %d', Math.floor(i / BATCH_SIZE) + 1, Math.ceil(uids.length / BATCH_SIZE), allEmails.length);
      if (onBatch) onBatch([...allEmails]);
    }

    // Save to archived_headers.json for next load
    if (allEmails.length > 0) {
      const forCache = allEmails.map(({ localId, isArchived, ...rest }) => rest);
      invoke('maildir_save_archived_cache', { accountId, mailbox, emails: forCache }).catch(() => {});
    }

    console.log('[db] getArchivedEmails: complete, loaded %d emails', allEmails.length);
    return allEmails;
  } catch (e) {
    console.error('[db] getArchivedEmails: .eml loading FAILED:', e);
    return allEmails.length > 0 ? allEmails : [];
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
  } catch (e) {
    console.warn('[db] getArchivedEmailIds failed:', e);
    return new Set();
  }
}

export async function exportEmail(localId) {
  await initDB();
  const parsed = parseLocalId(localId);
  if (!parsed || !invoke) return null;

  try {
    // Get light email for subject, and raw source separately
    const [email, rawBase64] = await Promise.all([
      invoke('maildir_read_light', {
        accountId: parsed.accountId,
        mailbox: parsed.mailbox,
        uid: parseInt(parsed.uid, 10),
      }),
      invoke('maildir_read_raw_source', {
        accountId: parsed.accountId,
        mailbox: parsed.mailbox,
        uid: parseInt(parsed.uid, 10),
      }),
    ]);
    if (!email || !rawBase64) return null;

    return {
      filename: `${(email.subject || 'email').replace(/[^a-zA-Z0-9]/g, '_')}.eml`,
      content: atob(rawBase64),
      rawBase64,
      mimeType: 'message/rfc822'
    };
  } catch {
    return null;
  }
}

// --- Email headers cache ---
// ── Mailbox cache ─────────────────────────────────────────────────────────

export async function saveMailboxes(accountId, mailboxes) {
  if (invoke) {
    try {
      // If we're saving a non-empty mailbox tree, also snapshot it as last-known-good
      const now = Date.now();
      const entry = { mailboxes, fetchedAt: now };
      if (mailboxes && mailboxes.length > 0) {
        entry.lastKnownGoodMailboxes = mailboxes;
        entry.lastKnownGoodAt = now;
      } else {
        // Preserve existing last-known-good when saving empty
        const existing = await getCachedMailboxEntry(accountId);
        if (existing?.lastKnownGoodMailboxes) {
          entry.lastKnownGoodMailboxes = existing.lastKnownGoodMailboxes;
          entry.lastKnownGoodAt = existing.lastKnownGoodAt;
        }
      }
      const data = JSON.stringify(entry);
      await invoke('save_mailbox_cache', { accountId, data });
    } catch (error) {
      console.warn('[db.js] Failed to save mailbox cache:', error);
    }
  }
}

export async function getCachedMailboxEntry(accountId) {
  if (invoke) {
    try {
      const data = await invoke('load_mailbox_cache', { accountId });
      if (data) {
        const entry = JSON.parse(data);
        if (Array.isArray(entry)) {
          return { mailboxes: entry, fetchedAt: null, lastKnownGoodMailboxes: null, lastKnownGoodAt: null };
        }
        return {
          mailboxes: entry.mailboxes || null,
          fetchedAt: entry.fetchedAt ?? entry.lastSynced ?? null,
          lastKnownGoodMailboxes: entry.lastKnownGoodMailboxes || null,
          lastKnownGoodAt: entry.lastKnownGoodAt || null,
        };
      }
    } catch (error) {
      console.warn('[db.js] Failed to load mailbox cache:', error);
    }
  }
  return null;
}

export async function getCachedMailboxes(accountId) {
  const entry = await getCachedMailboxEntry(accountId);
  return entry?.mailboxes || null;
}

// ── Email header cache ───────────────────────────────────────────────────

export async function saveEmailHeaders(accountId, mailbox, emails, totalEmails, { uidValidity, uidNext, highestModseq, serverUids } = {}) {
  const cacheEntry = {
    accountId,
    mailbox,
    emails,
    totalEmails,
    uidValidity: uidValidity ?? null,
    uidNext: uidNext ?? null,
    highestModseq: highestModseq ?? null,
    serverUids: serverUids ? Array.from(serverUids) : undefined,
    lastSynced: Date.now()
  };

  // Track last-known-good email count for corruption detection
  if (emails && emails.length > 0) {
    cacheEntry.lastKnownGoodTotalEmails = totalEmails;
    cacheEntry.lastKnownGoodCount = emails.length;
    cacheEntry.lastKnownGoodAt = Date.now();
  } else {
    // Preserve existing last-known-good when saving empty headers
    try {
      const existingMeta = await getEmailHeadersMeta(accountId, mailbox);
      if (existingMeta?.lastKnownGoodTotalEmails) {
        cacheEntry.lastKnownGoodTotalEmails = existingMeta.lastKnownGoodTotalEmails;
        cacheEntry.lastKnownGoodCount = existingMeta.lastKnownGoodCount;
      }
    } catch { /* ignore — best effort */ }
  }

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

export async function getEmailHeadersPartial(accountId, mailbox, limit = 200) {
  if (invoke) {
    try {
      const data = await invoke('load_email_cache_partial', { accountId, mailbox, limit });
      if (data) {
        const entry = JSON.parse(data);
        console.log('[db.js] Partial email headers loaded:', entry.emails?.length, 'of', entry.totalCached, 'emails');
        return {
          emails: entry.emails,
          totalEmails: entry.totalEmails,
          totalCached: entry.totalCached,
          uidValidity: entry.uidValidity ?? null,
          uidNext: entry.uidNext ?? null,
          highestModseq: entry.highestModseq ?? null,
          serverUids: entry.serverUids ? new Set(entry.serverUids) : null,
          lastSynced: entry.lastSynced
        };
      }
    } catch (error) {
      console.warn('[db.js] Failed to load partial cache:', error);
    }
  }

  return null;
}

export async function getEmailHeadersMeta(accountId, mailbox) {
  if (invoke) {
    try {
      const data = await invoke('load_email_cache_meta', { accountId, mailbox });
      if (data) {
        const entry = JSON.parse(data);
        return {
          totalEmails: entry.totalEmails,
          totalCached: entry.totalCached ?? 0,
          uidValidity: entry.uidValidity ?? null,
          uidNext: entry.uidNext ?? null,
          highestModseq: entry.highestModseq ?? null,
          lastSynced: entry.lastSynced,
          lastKnownGoodTotalEmails: entry.lastKnownGoodTotalEmails ?? null,
          lastKnownGoodCount: entry.lastKnownGoodCount ?? null,
        };
      }
    } catch (error) {
      console.warn('[db.js] Failed to load cache meta:', error);
    }
  }
  return null;
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
          uidValidity: entry.uidValidity ?? null,
          uidNext: entry.uidNext ?? null,
          highestModseq: entry.highestModseq ?? null,
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

// ── Graph ID map persistence (UID → Graph message ID) ───────────────────

export async function saveGraphIdMap(accountId, mailbox, mapObj) {
  if (invoke) {
    try {
      const data = JSON.stringify(mapObj);
      await invoke('save_graph_id_map', { accountId, mailbox, data });
    } catch (error) {
      console.warn('[db.js] Failed to save graph ID map:', error);
    }
  }
}

export async function loadGraphIdMap(accountId, mailbox) {
  if (invoke) {
    try {
      const data = await invoke('load_graph_id_map', { accountId, mailbox });
      if (data) {
        return JSON.parse(data);
      }
    } catch (error) {
      console.warn('[db.js] Failed to load graph ID map:', error);
    }
  }
  return null;
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

export async function migrateMaildirEmailDirs(accounts) {
  if (!invoke) return;
  const accountMap = {};
  for (const a of accounts) {
    if (a.email && a.id && a.email !== a.id) {
      accountMap[a.email] = a.id;
    }
  }
  if (Object.keys(accountMap).length === 0) return;
  try {
    const result = await invoke('maildir_migrate_email_dirs', { accountMap });
    if (result.migrated > 0) {
      console.log(`[db.js] Maildir migration: moved ${result.migrated} files`);
    }
  } catch (e) {
    console.warn('[db.js] Maildir migration failed (non-fatal):', e);
  }
}

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
