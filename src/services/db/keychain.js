// ── db/keychain - OS keychain read/write, session state, load queueing ──
//
// The daemon owns the credentials blob (Phase 1 step 0b,
// src-daemon/src/handlers/credentials.rs): `credentials.get` answers what the
// shell's `get_credentials` did, and `credentials.save` / `.update` /
// `.delete` change one account at a time on a fresh read of the store, so a
// stale cache here cannot replace another window's records. The one-release
// shell writer is no longer a mutation fallback. Unsupported and unknown
// mutations reject without replay; read compatibility remains.
// `credentials-changed {ids, version}` refreshes the presentation copy; reconnect
// starts a new in-memory read epoch. Neither reads nor reconnect cancel writes.

import { parseKeychainValue, getAccountsFromKeychain } from '../keychainUtils.js';
import * as keychainSession from '../keychainSession.js';
import { send as transportSend } from '../transport.js';
import { credentialsChanged } from '../oauthTokenSync.js';

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
  .catch(() => console.error('[db.js] Transport init check failed'));

// Bumped by every change this window made, so a refresh read that started
// before one never replaces the copy with what it read.
let localWrites = 0;
let connectionEpoch = 0;
let cacheRevision = 0;
let activeNativeWrites = 0;
let activeLegacyIntents = 0;
// Read/reset/reconnect cannot establish the outcome of a lost mutation.
let nativeOutcomeUnknown = false;
let legacyOutcomeUnknown = false;
export function markNativeMutationUncertain() { nativeOutcomeUnknown = true; }
// A lost create reply cannot authorize another add with a newly minted ID.
export function assertAccountCreateOutcomeKnown() {
  if (nativeOutcomeUnknown) throw new Error(`${keychainSession.E_KEYCHAIN_WRITE}: errors.accountsWriteFailed`);
}
export function assertNativeWriteAllowed() {
  if (legacyOutcomeUnknown || activeLegacyIntents > 0) throw new Error(`${keychainSession.E_KEYCHAIN_WRITE}: errors.keychainWriteFailed`);
}
export function assertLegacyWriteAllowed() {
  if (nativeOutcomeUnknown || legacyOutcomeUnknown || activeNativeWrites > 0) throw new Error(`${keychainSession.E_KEYCHAIN_WRITE}: errors.keychainWriteFailed`);
}
// Admission only, not a store lock: keep native/legacy operations from racing
// within this window. Native calls may still run together under native exclusion.
export function beginNativeWrite() {
  assertNativeWriteAllowed();
  activeNativeWrites += 1;
  return () => { activeNativeWrites -= 1; };
}

const errText = e => (typeof e === 'string' ? e : e?.message || String(e));
const outdated = e => e?.code === 'DAEMON_OUTDATED';
const unreachable = e => e?.code === 'DAEMON_UNAVAILABLE' || e?.code === 'NO_TAURI';
const object = r => !!r && typeof r === 'object' && !Array.isArray(r);
const strings = r => Array.isArray(r) && r.every(id => typeof id === 'string');
const isReadReply = r => object(r) && ['granted', 'empty', 'denied', 'cancelled', 'timed_out', 'unavailable'].includes(r.status)
  && (!['granted', 'empty'].includes(r.status) || (object(r.credentials) && Object.values(r.credentials).every(v => typeof v === 'string')));
function isWriteReply(method, r) {
  if (!object(r) || !Number.isInteger(r.version) || r.version < 0) return false;
  if (method === 'credentials.save') return strings(r.saved);
  if (method === 'credentials.delete') return strings(r.deleted);
  return typeof r.updated === 'boolean' && (r.staleGrant === undefined || typeof r.staleGrant === 'boolean') && !(r.staleGrant && r.updated);
}
const E_UNAVAILABLE = 'errors.keychainUnavailable';
const E_WRITE = 'errors.keychainWriteFailed';
const E_INVALID = 'errors.credentialsInvalid';
// A daemon write is parked (a keychain prompt nobody answered): retried, and
// never answered with the shell's whole-blob write, which the parked write
// could land on top of.
const E_BUSY = 'errors.keychainBusy';

const readOk = r => r?.status === 'granted' || r?.status === 'empty';

// The blob through the daemon, else the shell's own read. A daemon read that
// failed (its keychain gate blocked, a refused prompt) is tried once more
// through the shell, which reads quietly and never prompts: a read cannot
// lose anything, and whichever succeeded is kept.
async function readCredentials() {
  listenForChanges();
  {
    try {
      const reply = await invoke('credentials.get', {});
      if (isReadReply(reply)) {
        listenForChanges();
        if (readOk(reply)) {
          return reply;
        }
        const own = await Promise.resolve().then(() => invoke('get_credentials')).catch(() => null);
        if (isReadReply(own) && readOk(own)) {
          return own;
        }
        return reply;
      }
    } catch (error) {
      if (!outdated(error) && !unreachable(error)) console.warn('[db.js] The daemon could not read the credentials');
    }
  }
  const reply = await invoke('get_credentials');
  return isReadReply(reply) ? reply : { status: 'unavailable' };
}

// Keychain cache - stores full account objects (id, email, servers, password)
// Each value in the HashMap is a JSON-serialized account object.
// Format: { accountId: JSON.stringify({id, email, imapHost, smtpHost, password, createdAt}) }
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
    console.log('[db.js] Keychain session locked out - skipping automatic read');
    keychainCache = keychainCache || {};
    keychainLoaded = true;
    return keychainCache;
  }

  // Read failures are not retried; a read overtaken by a local write is replaced.
  const epoch = connectionEpoch;
  _keychainLoadPromise = (async () => {
    try {
      console.log('[db.js] Loading accounts from keychain...');
      keychainSession.recordOutcome('requesting');
      let result;
      // A read overtaken by a confirmed local mutation is stale presentation
      // data. Obtain a fresh read before settling the shared load promise.
      for (;;) {
        const writes = localWrites;
        result = await readCredentials();
        if (epoch !== connectionEpoch) return;
        if (writes === localWrites) break;
      }

      // Structured response: { status, credentials?, message? }
      const status = result?.status || 'unavailable';
      const credentials = result?.credentials || {};
      const message = null; // Arbitrary native/provider messages can contain secrets.
      const count = Object.keys(credentials).length;

      keychainSession.recordOutcome(status, message);

      if (status === 'granted' || status === 'empty') {
        keychainCache = credentials;
        cacheRevision += 1;
        keychainLoaded = true;
        console.log('[db.js] Keychain loaded:', status, `(${count} account(s))`);
      } else {
        // denied, cancelled, timed_out, unavailable
        console.warn(`[db.js] Keychain access: ${status}${message ? ' - ' + message : ''}`);
        if (isSnap() && status === 'unavailable') {
          console.error('[db.js] Snap keyring access failed - password-manager-service plug may be disconnected');
        }
        keychainCache = {};
        keychainLoaded = true;
      }
    } catch (error) {
      if (epoch !== connectionEpoch) return;
      console.warn('[db.js] Keychain read failed');
      keychainSession.recordOutcome('unavailable');
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
    // Earlier pending writes are skipped, but their callers must not hear
    // "stored" before a write that carries their data has actually landed
    // (a caller may reload the window next): settle them with the latest.
    const collapsed = pending.slice(0, -1);

      try {
        assertLegacyWriteAllowed();
        activeLegacyIntents += 1;
        try {
          await invoke('store_credentials', { credentials: latest.data });
        } finally { activeLegacyIntents -= 1; }
        localWrites += 1;
        keychainCache = { ...latest.data };
        cacheRevision += 1;
        // The daemon reads the store again before trusting a token it holds
        // (a new sign-in, a removed account, the pair it refreshed now saved).
        credentialsChanged();
        console.log('[db.js] Keychain saved for', Object.keys(latest.data).length, 'account(s)');
        latest.resolve();
        collapsed.forEach(w => w.resolve());
      } catch {
        legacyOutcomeUnknown = true;
        const error = new Error(`${keychainSession.E_KEYCHAIN_WRITE}: ${E_WRITE}`);
        latest.reject(error);
        collapsed.forEach(w => w.reject(error));
      }
  }

  _keychainWriteRunning = false;
}


// ── Per-account changes ─────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A change through the daemon: its reply, or null when this one must go
// through the shell after a trusted unsupported-method refusal. Throws when the
// daemon refused or failed it.
async function changeThroughDaemon(method, params) {
  listenForChanges();
  for (let attempt = 1; ; attempt++) {
    const release = beginNativeWrite();
    const epoch = connectionEpoch;
    const revision = cacheRevision;
    try {
      const reply = await invoke(method, params);
      if (isWriteReply(method, reply)) {
        listenForChanges();
        return { ...reply, cacheEpoch: epoch, cacheRevision: revision };
      }
      markNativeMutationUncertain();
      throw new Error(E_WRITE);
    } catch (error) {
      if (outdated(error)) throw new Error(`${keychainSession.E_KEYCHAIN_WRITE}: errors.daemonOutdated`);
      const text = errText(error);
      if (text === E_UNAVAILABLE) {
        throw new Error(keychainSession.E_KEYCHAIN_UNAVAILABLE);
      }
      if (text === E_INVALID) throw new Error(`${keychainSession.E_KEYCHAIN_WRITE}: ${E_INVALID}`);
      if (text !== E_BUSY || attempt >= 3) {
        if (text !== E_BUSY) markNativeMutationUncertain();
        throw new Error(`${keychainSession.E_KEYCHAIN_WRITE}: ${text === E_BUSY ? E_BUSY : E_WRITE}`);
      }
      console.warn(`[db.js] Credentials change failed (attempt ${attempt}/3)`);
      await sleep(1000 * attempt);
    } finally { release(); }
  }
}

// Local compatibility serializer only: another legacy window can still race.
// Each intent uses a fresh complete quiet read, never the presentation cache.
let legacyTail = Promise.resolve();
function changeThroughShell(apply) {
  const run = async () => {
    assertLegacyWriteAllowed();
    activeLegacyIntents += 1;
    try {
      let reply;
      try { reply = await invoke('get_credentials'); } catch { /* Refuse below. */ }
      if (!isReadReply(reply) || !readOk(reply)) throw new Error(keychainSession.E_KEYCHAIN_UNAVAILABLE);
      const data = { ...reply.credentials };
      const result = apply(data);
      if (result === false) return false;
      assertLegacyWriteAllowed();
      await saveKeychain(data);
      return result;
    } finally { activeLegacyIntents -= 1; }
  };
  const result = legacyTail.then(run, run);
  legacyTail = result.catch(() => {});
  return result;
}

async function withCache(reply, apply) {
  localWrites += 1;
  if (reply.cacheEpoch === connectionEpoch && reply.cacheRevision === cacheRevision) {
    if (keychainCache) apply(keychainCache);
    cacheRevision += 1;
  } else {
    // The mutation succeeded. Read the current state without replaying that
    // historical operation into a newer cache or connection.
    await refreshCache();
  }
}

const defined = fields => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/**
 * Store these records (`{ accountId: JSON.stringify(account) }`), each
 * replacing the one under its id; every other account is kept.
 */
export async function saveCredentials(records) {
  if (!Object.keys(records).length) return;
  const reply = await changeThroughDaemon('credentials.save', { records });
  if (reply) {
    await withCache(reply, cache => Object.assign(cache, records));
    return;
  }
  await changeThroughShell(data => { Object.assign(data, records); });
}

/**
 * Merge these top-level fields into the stored record of `accountId`.
 * Resolves false (and writes nothing) when no record is stored for it, or,
 * with `chain` (a refreshed pair's grant fingerprints), when the record the
 * daemon holds now is another grant's (a newer sign-in another window saved).
 */
export async function updateCredentials(accountId, fields, { chain } = {}) {
  const changes = defined(fields);
  const params = { id: accountId, fields: changes, ...(Array.isArray(chain) ? { chain } : {}) };
  const reply = await changeThroughDaemon('credentials.update', params);
  if (reply) {
    if (reply.staleGrant) return false;
    if (reply.updated) {
      await withCache(reply, cache => {
        if (!cache[accountId]) return;
        try { cache[accountId] = JSON.stringify({ ...JSON.parse(cache[accountId]), ...changes }); } catch { /* a legacy value */ }
      });
    }
    return reply.updated === true;
  }
  // A JS read/check cannot exclude a newer sign-in in another legacy window.
  if (Array.isArray(chain)) throw new Error(`${keychainSession.E_KEYCHAIN_WRITE}: errors.daemonOutdated`);
  return changeThroughShell(blob => {
    if (!blob[accountId]) return false;
    blob[accountId] = JSON.stringify({ ...JSON.parse(blob[accountId]), ...changes });
    return true;
  });
}

/** Remove the stored records of these ids. */
export async function deleteCredentials(ids) {
  if (!ids.length) return;
  const reply = await changeThroughDaemon('credentials.delete', { ids });
  if (reply) {
    await withCache(reply, cache => ids.forEach(id => delete cache[id]));
    return;
  }
  await changeThroughShell(data => ids.forEach(id => delete data[id]));
}

// ── Other writers ───────────────────────────────────────────────────────────

// Another window (or the daemon's own writer) changed the blob: take the
// daemon's copy, unless this window has written since the read started.
let refreshing = null;
let refreshAgain = false;
function refreshCache() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  const epoch = connectionEpoch;
  const task = Promise.resolve().then(async () => {
    try {
    if (!keychainLoaded) await loadKeychain();
    do {
      const status = keychainSession.getStatus();
      if (epoch !== connectionEpoch || !keychainLoaded || (status !== 'granted' && status !== 'empty')) return null;
      refreshAgain = false;
      const writes = localWrites;
      let reply;
      try { reply = await invoke('credentials.get', {}); } catch { return null; }
      if (epoch !== connectionEpoch || !isReadReply(reply) || !readOk(reply)) return null;
      if (writes !== localWrites) { refreshAgain = true; continue; }
      const next = reply.credentials || {};
      const cache = keychainCache || (keychainCache = {});
      for (const id of Object.keys(cache)) if (!(id in next)) delete cache[id];
      Object.assign(cache, next);
      cacheRevision += 1;
    } while (refreshAgain);
    return keychainCache;
    } finally {
      // Clear before this promise settles: an event arriving immediately
      // afterward must start a new read rather than join a completed task.
      if (refreshing === task) refreshing = null;
    }
  });
  refreshing = task;
  return task;
}

// A refresh pair can be published only after a current successful native read.
// Read failure returns null, never stale presentation data as confirmation.
export async function readCurrentCredentials() {
  return refreshCache();
}

let listening = false;
function listenForChanges() {
  const listen = typeof window !== 'undefined' ? window.__TAURI__?.event?.listen : undefined;
  if (listening || typeof listen !== 'function') return;
  listening = true;
  const on = (name, cb) => Promise.resolve().then(() => listen(name, cb)).catch(() => {});
  on('credentials-changed', () => {
    // A per-record acknowledgement does not prove the rest of this cache
    // contains earlier foreign changes. Coalesce reads, including own events.
    void refreshCache();
  });
  on('daemon-reconnected', () => {
    connectionEpoch += 1;
    refreshing = null;
    refreshAgain = false;
    keychainLoaded = false;
    _keychainLoadPromise = null;
    void loadKeychain();
  });
}

/** For tests: forget the transport mode and what the listeners set up. */
export function __resetKeychainForTests() {
  localWrites = 0;
  cacheRevision = 0;
  nativeOutcomeUnknown = false;
  legacyOutcomeUnknown = false;
  activeNativeWrites = 0;
  activeLegacyIntents = 0;
  legacyTail = Promise.resolve();
  listening = false;
  refreshing = null;
  refreshAgain = false;
  clearCredentialsCache();
}

// Detect snap confinement by checking if app data dir is under ~/snap/
let _isSnap = null;
function isSnap() {
  return _isSnap === true;
}

// Completed native account saves return metadata only. Invalidate presentation
// without replaying their historical secret-bearing input or resetting denial.
export function invalidateCredentialsCache() {
  localWrites += 1;
  cacheRevision += 1;
  connectionEpoch += 1;
  refreshing = null;
  refreshAgain = false;
  keychainCache = null;
  keychainLoaded = false;
  _keychainLoadPromise = null;
}

export function clearCredentialsCache() {
  connectionEpoch += 1;
  refreshing = null;
  refreshAgain = false;
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
    // Already loading or loaded - notify immediately if resolved
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
