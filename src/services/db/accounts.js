// Account metadata reads and primitive maintenance go through accounts.*.
// Creation/import and explicit patches use accounts.save, whose native owner
// merges fresh credentials, admits conflicting writers and commits metadata.
// Read fallback remains available; mutations never replay through shell writers.

import { exists, mkdir, remove } from '@tauri-apps/plugin-fs';
import { send as transportSend } from '../transport.js';
import { isPersonalMicrosoftEmail } from '../graphConfig.js';
import { parseKeychainValue, getAccountsFromKeychain, loadKeychain, saveCredentials, deleteCredentials, updateCredentials, readCurrentCredentials, markNativeMutationUncertain, beginNativeWrite, invalidateCredentialsCache } from './keychain.js';
import { grantFingerprint } from '../oauthTokenSync.js';
import * as keychainSession from '../keychainSession.js';
import { t } from '../../i18n/index.js';

// Transport-aware invoke: tries daemon socket first, falls back to Tauri invoke
const invoke = (cmd, args) => transportSend(cmd, args);

let initialized = false;

// --- File helpers (accounts.json only) ---

const MAILDIR = 'Maildir';

// The app data dir comes from Rust (`get_app_data_dir`, the same resolver the
// daemon uses), never from plugin-fs's BaseDirectory.AppData: on Windows that
// is Roaming and ignores the env, while the app and the daemon live in Local.
let appDataDir = null;

/** Absolute path of `rel` ('/'-separated) under the app data dir. */
export async function dataPath(rel) {
  appDataDir ??= invoke('get_app_data_dir').then((dir) => {
    // Diagnostic, not user copy: the Rust command's own errors are English too.
    if (typeof dir !== 'string' || !dir) throw new Error(`get_app_data_dir returned ${dir}`);
    return dir;
  });
  let dir;
  try {
    dir = await appDataDir;
  } catch (error) {
    appDataDir = null; // one failure must not poison the session
    throw error;
  }
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
}

async function ensureDir(rel) {
  const path = await dataPath(rel);
  try {
    const dirExists = await exists(path);
    if (!dirExists) {
      await mkdir(path, { recursive: true });
    }
  } catch {
    await mkdir(path, { recursive: true });
  }
}

// ── The account list, through the daemon ───────────────────────────────────

// The daemon's own errors (`accounts_doc::AccountsError`): it answered and
// refused or failed this one, so the shell is not tried instead.
const ACCOUNTS_ERRORS = ['errors.accountsConflict', 'errors.accountsInvalid', 'errors.accountsWriteFailed', 'errors.keychainUnavailable', 'errors.keychainBusy', 'errors.keychainWriteFailed', 'errors.credentialsInvalid', 'errors.daemonOutdated'];
// How long a read waits for a daemon not yet seen to answer before the shell
// reads the file instead (a cold daemon is still starting; quick load paints
// from this list).
const READ_BUDGET_MS = 1500;
const SECRET_FIELDS = ['password', 'oauth2AccessToken', 'oauth2RefreshToken'];

// 'daemon' once accounts.* answered, 'shell' for a daemon without it.
let listMode = 'unknown';

const errText = e => ACCOUNTS_ERRORS.includes(e?.message ?? e) ? (e?.message ?? e) : 'errors.accountsWriteFailed';
const object = r => !!r && typeof r === 'object' && !Array.isArray(r);
function isReply(method, r) {
  if (!object(r) || !Number.isInteger(r.version) || r.version < 0) return false;
  if (method === 'accounts.list') return Array.isArray(r.accounts);
  if (method === 'accounts.get') return r.account === null || object(r.account);
  if (method === 'accounts.save') {
    const ids = a => Array.isArray(a) && a.every(id => typeof id === 'string' && id.length > 0) && new Set(a).size === a.length;
    return ids(r.accepted) && object(r.skipped) && Object.entries(r.skipped).every(([id, target]) => id && typeof target === 'string' && target)
      && Number.isInteger(r.credentialVersion) && r.credentialVersion >= 0 && typeof r.hostChanged === 'boolean'
      && Array.isArray(r.accounts) && r.accounts.length === r.accepted.length
      && r.accounts.every((a, i) => object(a) && a.id === r.accepted[i] && !SECRET_FIELDS.some(k => Object.hasOwn(a, k)));
  }
  return Array.isArray(r.changed) && r.changed.every(id => typeof id === 'string');
}
let listListening = false;
function listenForReconnect() {
  const listen = globalThis.window?.__TAURI__?.event?.listen;
  if (listListening || typeof listen !== 'function') return;
  listListening = true;
  Promise.resolve(listen('daemon-reconnected', () => { listMode = 'unknown'; })).catch(() => {});
}

function withBudget(promise, ms) {
  let timer;
  const budget = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('budget'), { code: 'DAEMON_UNAVAILABLE' })), ms); });
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
}

async function accountsCall(method, params = {}) {
  const read = method === 'accounts.list' || method === 'accounts.get';
  const release = read ? () => {} : beginNativeWrite();
  listenForReconnect();
  {
    try {
      const call = Promise.resolve().then(() => invoke(method, params));
      const reply = await (read && listMode !== 'daemon' ? withBudget(call, READ_BUDGET_MS) : call);
      if (isReply(method, reply)) {
        listMode = 'daemon';
        return reply;
      }
      throw new Error('errors.accountsWriteFailed');
    } catch (error) {
      if (!read) {
        const message = error?.code === 'DAEMON_OUTDATED' ? 'errors.daemonOutdated' : errText(error);
        if (!['errors.accountsConflict', 'errors.accountsInvalid', 'errors.keychainBusy', 'errors.keychainUnavailable', 'errors.credentialsInvalid', 'errors.daemonOutdated'].includes(message)) markNativeMutationUncertain();
        throw new Error(message);
      }
    } finally { release(); }
  }
  try {
    const reply = await invoke('accounts_fallback', { method, params });
    if (!isReply(method, reply)) throw new Error('errors.accountsWriteFailed');
    return reply;
  } catch (error) {
    if (!read) markNativeMutationUncertain();
    throw new Error(errText(error));
  }
}

const stripSecrets = (account) => Object.fromEntries(Object.entries(account).filter(([k]) => !SECRET_FIELDS.includes(k)));

// The list and its version. Throws when it could not be read: a caller about
// to change the list must never work from a list it did not get.
async function listAccounts() {
  const reply = await accountsCall('accounts.list');
  if (!Array.isArray(reply.accounts)) throw new Error('errors.accountsWriteFailed');
  if (reply.recovered) console.warn('[db.js] accounts.json did not parse; recovered list used');
  return { accounts: reply.accounts, version: reply.version };
}

// The list for showing and merging: empty when it cannot be read.
async function readAccountsFile() {
  try {
    return (await listAccounts()).accounts;
  } catch (error) {
    console.warn('[db.js] Failed to read accounts.json:', errText(error));
    return [];
  }
}

/** For tests: forget which way the list was reached. */
export function __resetAccountsForTests() {
  listMode = 'unknown';
  listListening = false;
  initialized = false;
  basicInitDone = false;
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

  // accounts.json is not created here any more: a missing file is an empty
  // list to every reader, and the old `catch` wrote `[]` over the file when
  // a mere existence check failed.

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
      console.warn('[db.js] Migration failed (non-fatal)');
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
        await deleteCredentials(keysToRemove);
        console.log('[db.js] Legacy keychain cleanup complete');
      }
    } catch (e) {
      console.warn('[db.js] Legacy keychain cleanup failed (non-fatal)');
    }
  }

  initialized = true;
  console.log('[db.js] Maildir .eml storage initialized');
}

// --- Account operations ---

// Finite source context: absence and explicit null are different guards.
const identityContext = ['email', 'authType', 'imapHost', 'oauth2Provider', 'oauth2Transport'];
const oauthContext = [...identityContext, 'oauth2ClientId', 'oauth2CustomClientId', 'oauth2TenantId'];
const serverContext = [...identityContext, 'imapPort', 'imapSecure', 'imapSecurity', 'smtpHost', 'smtpPort', 'smtpSecure', 'jmapSessionUrl', 'jmapAuth', 'jmapUsername'];
export function accountExpectedContext(account, kind = 'server') {
  const keys = kind === 'oauth' ? oauthContext : kind === 'all' ? [...new Set([...serverContext, ...oauthContext])]
    : kind === 'repair' ? ['email', 'authType', 'oauth2Transport'] : serverContext;
  return {
    fields: Object.fromEntries(keys.filter(k => account[k] !== undefined).map(k => [k, account[k]])),
    absent: keys.filter(k => account[k] === undefined),
    ...(kind === 'repair' ? { credentialPresent: true } : {}),
  };
}
async function persistAccount(params) {
  await initBasic();
  let reply;
  try { reply = await accountsCall('accounts.save', params); }
  catch (error) { throw accountsWriteError(error); }
  invalidateCredentialsCache();
  return reply;
}
export async function patchAccount(id, fields, { unset = [], expected } = {}) {
  const reply = await persistAccount({ patch: { id, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), ...(unset.length ? { unset } : {}), ...(expected ? { expected } : {}) } });
  if (reply.accepted.length !== 1 || reply.accepted[0] !== id || Object.keys(reply.skipped).length) {
    markNativeMutationUncertain();
    throw accountsWriteError(new Error('errors.accountsWriteFailed'));
  }
  return { ...reply, account: reply.accounts[0] };
}
// Add only. Existing-account callers must express their intended patch.
export async function saveAccount(entry) {
  const reply = await persistAccount({ entries: [entry], ifAbsent: false });
  if (reply.accepted.length !== 1 || reply.accepted[0] !== entry.id || Object.keys(reply.skipped).length) {
    markNativeMutationUncertain();
    throw accountsWriteError(new Error('errors.accountsWriteFailed'));
  }
  return reply.accounts[0];
}
export async function saveAccounts(entries) {
  if (!Array.isArray(entries) || entries.some(e => !object(e) || !Object.hasOwn(e, 'id') || typeof e.id !== 'string' || !e.id)
    || new Set(entries.map(e => e.id)).size !== entries.length) {
    throw accountsWriteError(new Error('errors.accountsInvalid'));
  }
  const requested = new Set(entries.map(e => e.id));
  const reply = await persistAccount({ entries, ifAbsent: true });
  const completed = [...reply.accepted, ...Object.keys(reply.skipped)];
  if (completed.length !== requested.size || new Set(completed).size !== completed.length || completed.some(id => !requested.has(id))) {
    markNativeMutationUncertain();
    throw accountsWriteError(new Error('errors.accountsWriteFailed'));
  }
  return reply;
}

// The shell's keychain queue rejects with store_credentials' raw Rust string,
// the account list with its catalog key; callers map on an E_* prefix.
function accountsWriteError(error) {
  const message = error?.message ?? error;
  if (message === keychainSession.E_KEYCHAIN_UNAVAILABLE || message === 'errors.keychainUnavailable') return new Error(keychainSession.E_KEYCHAIN_UNAVAILABLE);
  const key = ACCOUNTS_ERRORS.includes(message) ? message : 'errors.keychainWriteFailed';
  return new Error(`${keychainSession.E_KEYCHAIN_WRITE}: ${key}`);
}

export async function getAccountsWithoutPasswords() {
  await initBasic();
  return await readAccountsFile();
}

// Ensure account metadata (no password) exists in accounts.json for quick-load.
// Called after full init to backfill from keychain data.
/**
 * Logical account identity key - same email + same server/provider = same account.
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

// Batch version: one change that adds every account whose id and logical
// identity (accountLogicalKey, matched by the daemon) the list lacks.
export async function ensureAccountsInFile(accounts) {
  const entries = accounts.filter(a => a?.id).map(stripSecrets);
  if (!entries.length) return;
  const reply = await accountsCall('accounts.put', { entries, ifAbsent: true });
  const added = Array.isArray(reply.changed) ? reply.changed.length : 0;
  if (added > 0) console.log('[db.js] Backfilled', added, 'accounts to accounts.json');
}

export async function getAccounts() {
  await initDB();

  let accounts;

  if (invoke) {
    const data = await loadKeychain();
    const keychainAccounts = getAccountsFromKeychain(data);

    // Filter to only valid accounts (must have email)
    const validAccounts = keychainAccounts.filter(a => a.email);

    // Always read file accounts as a fallback - merge to ensure no accounts are lost
    // when keychain times out and returns fewer accounts
    const listed = await listAccounts().catch((error) => {
      console.warn('[db.js] Failed to read accounts.json:', errText(error));
      return { accounts: [], version: null };
    });
    const fileAccounts = listed.accounts;

    if (validAccounts.length > 0) {
      // Merge: keychain is authoritative, but include file-only accounts (missing from keychain due to timeout)
      // Use both id AND logical key to prevent duplicates from 2.3.2 upgrade path
      const keychainIds = new Set(validAccounts.map(a => a.id));
      const keychainKeys = new Set(validAccounts.map(a => accountLogicalKey(a)));
      const fileOnly = fileAccounts.filter(a => !keychainIds.has(a.id) && !keychainKeys.has(accountLogicalKey(a)));
      if (fileOnly.length > 0) {
        console.log(`[db.js] ${fileOnly.length} account(s) from file not in keychain - adding without credentials`);
      }
      accounts = [...validAccounts, ...fileOnly];
    } else {
      // Keychain empty (timeout or fresh install) - use file accounts with whatever passwords are available
      accounts = fileAccounts.map(a => ({
        ...a,
        password: data[a.id] || undefined
      }));
    }

    // Deduplicate by logical identity (email + server/provider)
    accounts = deduplicateAccounts(accounts);

    // One-time cleanup: remove duplicates from accounts.json. Only over the
    // list as it was read (its version): if it changed since, skip it.
    const cleanedFile = deduplicateAccounts(fileAccounts);
    if (cleanedFile.length < fileAccounts.length && listed.version != null) {
      console.log(`[db.js] Cleaning up ${fileAccounts.length - cleanedFile.length} duplicate(s) from accounts.json`);
      await accountsCall('accounts.replace_all', { entries: cleanedFile.map(stripSecrets), baseVersion: listed.version })
        .catch(e => console.warn('[db.js] Failed to clean accounts.json:', errText(e)));
    }
  } else {
    accounts = deduplicateAccounts(await readAccountsFile());
  }

  // Auto-repair: personal Microsoft accounts must use Graph transport.
  // Older saved accounts may have oauth2Transport: 'imap' which fails with XOAUTH2.
  for (const account of accounts) {
    if (account.authType === 'oauth2' && isPersonalMicrosoftEmail(account.email) && account.oauth2Transport !== 'graph') {
      const expected = accountExpectedContext(account, 'repair');
      // Retain the display fallback; only native confirmation proves repair.
      account.oauth2Transport = 'graph';
      try { await patchAccount(account.id, { oauth2Transport: 'graph' }, { expected }); }
      catch { console.warn('[db.js] Transport repair was not confirmed'); }
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

    const stored = JSON.parse(data[accountId]);
    // The refresh token only when the pair carries one: this window's copy
    // may be older than a Reconnect another window saved.
    const fields = {
      oauth2AccessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { oauth2RefreshToken: tokens.refreshToken } : {}),
      oauth2ExpiresAt: tokens.expiresAt,
    };
    // Only these fields change, merged into the record as stored now, and
    // only while it is still this pair's grant (`chain`, checked by the
    // daemon against what it holds, not against this window's copy).
    if (!(await updateCredentials(accountId, fields, { chain: tokens.chain }))) return;
    const currentData = await readCurrentCredentials();
    const current = currentData?.[accountId] ? JSON.parse(currentData[accountId]) : null;
    const expected = { ...stored, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    if (!current || current.oauth2AccessToken !== expected.oauth2AccessToken
      || Number(current.oauth2ExpiresAt) !== Number(expected.oauth2ExpiresAt)
      || await grantFingerprint(current) !== await grantFingerprint(expected)) {
      console.warn('[db.js] Refreshed pair is not confirmed current for account:', accountId);
      return;
    }
    console.log('[db.js] OAuth2 tokens updated for account:', accountId);
    return current;
  } catch (error) {
    console.error('[db.js] Failed to update OAuth2 tokens:', errText(error));
    throw error;
  }
}

export async function deleteAccount(id) {
  // Remove this account's compose receipts before any account cleanup.
  await invoke('compose.receipts.remove_account', { accountId: id });
  await initDB();

  // Native metadata writes preserve legacy credentials first. Removing the
  // list row before its credential prevents preservation from recreating it.
  // A refused/unknown step rejects before local cleanup; prior effects may remain.
  await accountsCall('accounts.remove', { ids: [id] });
  await deleteCredentials([id]);

  // Remove Maildir/{accountId}/ directory
  try {
    const dirPath = await dataPath(accountDir(id));
    const dirExists = await exists(dirPath);
    if (dirExists) {
      await remove(dirPath, { recursive: true });
    }
  } catch (error) {
    console.warn('[db.js] Failed to remove account Maildir');
  }

  // Clear email headers cache for this account
  if (invoke) {
    try {
      await invoke('clear_email_cache', { accountId: id });
    } catch (error) {
      console.warn('[db.js] Failed to clear email cache');
    }

    // Clear mailbox cache
    try {
      await invoke('delete_mailbox_cache', { accountId: id });
    } catch (error) {
      console.warn('[db.js] Failed to clear mailbox cache');
    }
  }
}
