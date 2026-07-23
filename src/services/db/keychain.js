// ── db/keychain — OS keychain read/write, session state, load queueing ──

import { parseKeychainValue, getAccountsFromKeychain } from '../keychainUtils.js';
import * as keychainSession from '../keychainSession.js';
import { send as transportSend } from '../transport.js';

// Re-export for any consumers that import from db.js
export { parseKeychainValue, getAccountsFromKeychain };

// Transport-aware invoke: tries daemon socket first, falls back to Tauri invoke
const invoke = (cmd, args) => transportSend(cmd, args);

console.log('[db.js] Initializing (Maildir .eml)...');

// Check Tauri connectivity on init
transportSend('get_app_data_dir', {})
  .then(result => {
    console.log('[db.js] Transport working. App data dir:', result);
    _isSnap = typeof result === 'string' && result.includes('/snap/');
  })
  .catch(error => console.error('[db.js] Transport init check failed:', error));

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

export { loadKeychain, saveKeychain };
