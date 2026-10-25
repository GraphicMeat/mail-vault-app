// Storage for Zustand persist, backed by the settings document the daemon
// owns (`frontend-settings.json`, `src-core/src/settings_doc.rs`). Bypasses
// localStorage/WKWebView storage, which throws "SecurityError: The operation
// is insecure" in App Sandbox.
//
// One top-level key per persisted store. Reads come from `settings.get` once
// per window; a change is written 500ms later with `settings.replace`, which
// replaces just the stores that changed (whole, so a key a store dropped is
// gone). The daemon writes atomically, keeps a version and backups, and emits
// `settings-changed {keys, version}`, which every window takes in.
//
// Fallbacks (one release, for an update that pairs this app with an older
// daemon): a daemon without `settings.*` (errors.daemonOutdated, or any reply
// that is not a snapshot) switches this window to the shell's
// read/write_settings_json for good. A daemon that is unreachable or failing
// at startup gets the file read through the shell once, and the window keeps
// asking the daemon (backoff, every write, every reconnect). A write while it
// is unreachable goes through the shell. A shell write lays only the changed
// keys over what is on disk now, so it never undoes another writer's keys.
//
// Nothing is written before this window has seen the document: a store that
// hydrated from nothing holds its defaults, and those must never replace the
// saved settings. Its queued change is laid over the document once one is read.
//
// Falls back to in-memory storage when Tauri is not available (dev browser).

import { isChildWindow } from '../utils/privacy/isChildWindow';

const invoke = typeof window !== 'undefined' ? window.__TAURI__?.core?.invoke : undefined;

// The two markers `daemon_rpc` (src-tauri) returns: no daemon reachable, and a
// daemon that does not know the method.
const UNAVAILABLE = 'errors.daemonUnavailable';
const OUTDATED = 'errors.daemonOutdated';
// Refused because this window never saw the document (catalog key).
const NOT_LOADED = 'errors.settingsNotLoaded';
// The daemon's own settings errors (`settings_doc::SettingsError`): a daemon
// that knows settings.* answered, and failed this time.
const SETTINGS_ERRORS = ['errors.settingsConflict', 'errors.settingsInvalid', 'errors.settingsWriteFailed'];
const isSettingsError = text => SETTINGS_ERRORS.includes(text);
// How long a window waits for its first settings.get before reading the file
// through the shell instead. A warm daemon answers in milliseconds; a cold
// one is still starting, and the UI paints defaults until hydration, so the
// shell's read (what every window did before) takes over quickly.
const FIRST_READ_BUDGET_MS = 1500;
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 60000;

// In-memory cache — always holds the current state, as JSON strings.
const cache = new Map();
// Keys changed in this window and not yet written.
const dirty = new Set();
// Keys a window that cannot write changed in its own memory: kept out of
// `dirty` (which would stop it following those keys for good), but a full
// refresh does not delete them.
const localOnly = new Set();
// Keys in the write on the wire.
const inflight = new Set();
// Keys written before the document loaded. Zustand persist writes a store's
// whole state on every setState, hydrated or not, so such a write is the
// store's DEFAULTS plus one change; letting it win would drop every setting
// the user saved under that key. The document wins instead, and hydration
// merges it over the in-memory state as usual.
const early = new Set();
let settledLoad = false;

// 'daemon' once settings.get answered with a snapshot; 'pending' while the
// daemon was unreachable or failing at startup (writes still try it first);
// 'shell' for a daemon without settings.* (and every test that mocks invoke
// without it).
let mode = 'shell';
let lastVersion = null;
// The first read put the document into the cache.
let loaded = false;

// Promise that resolves once the document has been loaded into the cache.
let loadPromise = null;

const errText = e => (typeof e === 'string' ? e : e?.message || String(e));
const parse = value => { try { return JSON.parse(value); } catch { return value; } };
const isSnapshot = r => !!r && typeof r === 'object' && Number.isInteger(r.version)
  && !!r.values && typeof r.values === 'object' && !Array.isArray(r.values);

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function rpc(method, params) {
  return invoke('daemon_rpc', { method, params });
}

function withBudget(promise, ms) {
  let timer;
  const budget = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(UNAVAILABLE)), ms); });
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
}

function noteVersion(version) {
  if (Number.isInteger(version)) lastVersion = lastVersion == null ? version : Math.max(lastVersion, version);
}

function fill(values) {
  const overruled = [];
  for (const [key, value] of Object.entries(values)) {
    if (early.has(key)) {
      overruled.push(key);
      dirty.delete(key);
    } else if (cache.has(key)) {
      continue;
    }
    cache.set(key, JSON.stringify(value));
  }
  if (overruled.length) console.warn('[safeStorage] Kept the saved settings over a write made before they loaded:', overruled.join(', '));
}

// `snapshot`, or why not: `lacks` (an older daemon: the shell for good) or
// `transient` (unreachable, timed out, or the daemon's own read failed:
// keep asking it).
async function readThroughDaemon() {
  const started = Date.now();
  let transient = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await withBudget(Promise.resolve().then(() => rpc('settings.get', {})), Math.max(1, FIRST_READ_BUDGET_MS - (Date.now() - started)));
      if (!isSnapshot(reply)) return { lacks: true };
      return { snapshot: reply };
    } catch (e) {
      const text = errText(e);
      if (text === OUTDATED) return { lacks: true };
      if (text !== UNAVAILABLE) return { transient: isSettingsError(text) ? 'retry' : 'once' };
      transient = 'retry';
      // `daemon_rpc` already spawned and waited for the daemon; one more try
      // covers a daemon that was restarting, inside the same budget.
      if (Date.now() - started > FIRST_READ_BUDGET_MS - 500) break;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return { transient };
}

// The document through the shell: its values, or null when it cannot be read.
async function readThroughShell() {
  try {
    const data = await invoke('read_settings_json');
    const parsed = data ? JSON.parse(data) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn('[safeStorage] The settings file does not hold an object');
  } catch (e) {
    console.warn('[safeStorage] Could not load settings from disk:', errText(e));
  }
  return null;
}

function ensureLoaded() {
  if (loadPromise) return loadPromise;
  if (!invoke) {
    loadPromise = Promise.resolve();
    return loadPromise;
  }
  loadPromise = (async () => {
    const started = Date.now();
    const { snapshot, lacks, transient } = await readThroughDaemon();
    if (snapshot) {
      mode = 'daemon';
      noteVersion(snapshot.version);
      fill(snapshot.values);
      loaded = true;
      if (snapshot.recovered) console.warn('[safeStorage] The settings file did not parse; the daemon recovered it from', snapshot.recovered);
      console.log(`[safeStorage] Loaded settings from the daemon in ${Date.now() - started}ms:`, Object.keys(snapshot.values).join(', '));
    } else {
      mode = lacks ? 'shell' : 'pending';
      if (!lacks) console.warn('[safeStorage] The daemon did not answer settings.get; read the settings file through the shell instead');
      const values = await readThroughShell();
      if (values) {
        fill(values);
        loaded = true;
        console.log('[safeStorage] Loaded settings from disk:', Object.keys(values).join(', '));
      }
      if (transient === 'retry') scheduleProbe();
    }
    if (mode !== 'shell') listenForChanges();
  })().finally(() => { settledLoad = true; early.clear(); });
  return loadPromise;
}

// ── A document read late ────────────────────────────────────────────────────

// A store's persisted defaults, to tell the changes in a queued write (a store
// that hydrated from nothing writes its defaults plus the user's change) from
// the defaults themselves. Null when the store is not known here.
function persistedDefaults(store) {
  const options = store?.persist?.getOptions?.();
  if (!options || typeof store.getInitialState !== 'function') return null;
  const initial = store.getInitialState();
  try {
    return JSON.parse(JSON.stringify(typeof options.partialize === 'function' ? options.partialize(initial) : initial));
  } catch {
    return null;
  }
}

// The queued write laid over the document: the document, plus each field the
// queued write changed from the store's defaults. Null when that cannot be
// told (an unknown store, another store version).
function layOver(name, queued, doc) {
  if (!queued?.state || !doc?.state || (queued.version ?? 0) !== (doc.version ?? 0)) return null;
  const defaults = persistedDefaults(stores.get(name));
  if (!defaults) return null;
  const state = { ...doc.state };
  for (const [field, value] of Object.entries(queued.state)) {
    if (!deepEqual(value, defaults[field])) state[field] = value;
  }
  return { ...doc, state };
}

// Takes in a document this window could not read at startup: every key it
// had not touched, and every queued change laid over its key, then lets each
// store hydrate from it.
function adoptLate(values) {
  const hydrate = [];
  const dropped = [];
  for (const [name, doc] of Object.entries(values)) {
    if (dirty.has(name) && !inflight.has(name)) {
      const merged = layOver(name, cache.has(name) ? parse(cache.get(name)) : undefined, doc);
      if (merged) {
        cache.set(name, JSON.stringify(merged));
      } else {
        dirty.delete(name);
        dropped.push(name);
        cache.set(name, JSON.stringify(doc));
      }
    } else if (!inflight.has(name)) {
      cache.set(name, JSON.stringify(doc));
    }
    hydrate.push(name);
  }
  if (dropped.length) console.warn('[safeStorage] Kept the saved settings over a change made before they could be read:', dropped.join(', '));
  for (const name of hydrate) {
    const rehydrate = stores.get(name)?.persist?.rehydrate;
    if (typeof rehydrate === 'function') Promise.resolve().then(() => rehydrate()).catch(() => {});
  }
}

// One more try at the document (the daemon, then the shell). True once read.
let lateRead = null;
function readLate() {
  if (loaded) return Promise.resolve(true);
  lateRead ??= (async () => {
    let values = null;
    if (mode !== 'shell') {
      try {
        const reply = await withBudget(Promise.resolve().then(() => rpc('settings.get', {})), FIRST_READ_BUDGET_MS);
        if (isSnapshot(reply)) {
          mode = 'daemon';
          noteVersion(reply.version);
          values = reply.values;
        } else {
          mode = 'shell';
        }
      } catch (e) {
        if (errText(e) === OUTDATED) mode = 'shell';
      }
    }
    values ??= await readThroughShell();
    if (!values) return false;
    adoptLate(values);
    loaded = true;
    console.log('[safeStorage] Loaded settings late:', Object.keys(values).join(', '));
    if (mode !== 'shell') listenForChanges();
    return true;
  })().finally(() => { lateRead = null; });
  return lateRead;
}

// While the daemon was failing at startup: ask it again with backoff until it
// answers, so this window follows changes and writes through it again.
let probeTimer = null;
let probeDelay = 0;
function scheduleProbe() {
  if (probeTimer) return;
  probeDelay = Math.min(probeDelay ? probeDelay * 2 : RETRY_FIRST_MS, RETRY_MAX_MS);
  probeTimer = setTimeout(async () => {
    probeTimer = null;
    if (!loaded) await readLate();
    else if (mode === 'pending') await refresh(null);
    if (mode === 'pending' || !loaded) scheduleProbe();
  }, probeDelay);
  probeTimer?.unref?.();
}

// ── Writing ─────────────────────────────────────────────────────────────────

// The changed keys laid over the file as it is now, through the shell.
async function writeThroughShell(names) {
  let base = null;
  try {
    const parsed = JSON.parse(await invoke('read_settings_json'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
  } catch { /* unreadable or broken: decided below */ }
  if (!base) {
    // Only a cache that holds the whole document may stand in for it.
    if (!loaded) throw new Error(NOT_LOADED);
    base = {};
    for (const [key, value] of cache.entries()) base[key] = parse(value);
  }
  for (const name of names) {
    if (cache.has(name)) base[name] = parse(cache.get(name));
    else delete base[name];
  }
  await invoke('write_settings_json', { data: JSON.stringify(base) });
}

async function send(names) {
  if (mode !== 'shell') {
    const values = Object.fromEntries(names.map(n => [n, cache.has(n) ? parse(cache.get(n)) : null]));
    try {
      const reply = await rpc('settings.replace', { values });
      if (reply && Number.isInteger(reply.version)) {
        mode = 'daemon';
        noteVersion(reply.version);
        return;
      }
      mode = 'shell';
    } catch (e) {
      const text = errText(e);
      if (text === OUTDATED) mode = 'shell';
      // A daemon that answered with an error of its own (the write failed,
      // the file is intact): keep the change queued and try again later.
      else if (isSettingsError(text)) throw e;
      // Unreachable, or not a settings answer: through the shell this time,
      // so nothing waits on it.
    }
  }
  await writeThroughShell(names);
}

async function writeDirty() {
  if (!writesEnabled) return;
  if (!invoke) return;
  await ensureLoaded(); // never write before the document is known
  if (!writesEnabled || !dirty.size) return;
  // A window that never saw the document holds store defaults: one more try
  // at reading it, else nothing is written and the change stays queued.
  if (!loaded && !(await readLate())) {
    scheduleRetry();
    throw new Error(NOT_LOADED);
  }
  if (!dirty.size) return;
  const names = [...dirty];
  dirty.clear();
  names.forEach(n => inflight.add(n));
  try {
    await send(names);
    retryDelay = 0;
  } catch (e) {
    // Keep every change queued; a newer setItem for the same key is already there.
    names.forEach(n => dirty.add(n));
    scheduleRetry();
    throw e;
  } finally {
    names.forEach(n => inflight.delete(n));
  }
}

// One write at a time: two writes on two connections could land out of order.
let writeChain = Promise.resolve();
function writeQueued() {
  const run = writeChain.then(writeDirty);
  writeChain = run.catch(() => {});
  return run;
}

// The debounced path: warns on failure and never rejects.
function saveToDisk() {
  saveTimer = null;
  return writeQueued().catch(e => console.warn('[safeStorage] Failed to write settings:', errText(e)));
}

// Debounced save — avoids excessive disk writes
let saveTimer = null;
let retryDelay = 0;
function scheduleRetry() {
  if (!writesEnabled || saveTimer) return;
  retryDelay = Math.min(retryDelay ? retryDelay * 2 : RETRY_FIRST_MS, RETRY_MAX_MS);
  saveTimer = setTimeout(saveToDisk, retryDelay);
}

// The detached compose bundle imports the same persisted stores, but its
// snapshot is intentionally partial. Decide before Zustand can hydrate so it
// can never overwrite the main window's settings file during child startup.
let writesEnabled = !isChildWindow();
function debouncedSave() {
  if (!writesEnabled) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDisk, 500);
}

// False in a window whose writes are disabled (detached compose/settings):
// its changes reach the settings file only through the main window.
export function safeStorageWritable() {
  return writesEnabled;
}

// Detached compose receives a settings snapshot from its owner. It may read
// defaults but must never serialize its partial webview cache over main state.
export function setSafeStorageWriteEnabled(enabled) {
  writesEnabled = Boolean(enabled);
  if (writesEnabled) {
    localOnly.forEach(n => dirty.add(n));
    localOnly.clear();
  }
  if (!writesEnabled && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// Write now instead of in 500ms, and resolve once the document is written: a
// caller about to reload the window (account transfer import) would otherwise
// lose whatever the debounce had not yet saved. One write covers every
// persisted store (settings and theme share this cache). A no-op in windows
// whose writes are disabled (detached compose/settings). REJECTS when the
// write fails, so the caller can tell the user their settings did not land;
// the change stays queued and is retried.
export async function flushSafeStorage({ acknowledge = false } = {}) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await ensureLoaded(); // never write a cache that is missing on-disk keys
  await writeQueued();
  if (!acknowledge) return;
  if (!writesEnabled || !invoke) throw new Error('compose.preparationUnavailable');
  // A write arriving during flush/read needs a new acknowledged generation.
  // The bounded loop does not retry an ordinary preparation timeout.
  for (let attempt = 0; attempt < 3; attempt++) {
    await writeQueued();
    const expected = identityValues(parse(cache.get('mailvault-settings')));
    const reply = await rpc('settings.get', {});
    if (!isSnapshot(reply) || reply.version < 0 || reply.recovered) throw new Error('compose.preparationUnavailable');
    const current = identityValues(parse(cache.get('mailvault-settings')));
    if (deepEqual(expected, current) && deepEqual(current, identityValues(reply.values['mailvault-settings']))
      && !dirty.has('mailvault-settings') && !inflight.has('mailvault-settings')) return reply.version;
  }
  throw new Error('errors.settingsConflict');
}

function identityValues(document) {
  const state = document?.state || {};
  return { aliases: state.aliases || {}, sendAsAddresses: state.sendAsAddresses || {} };
}

// ── Other writers ───────────────────────────────────────────────────────────

// Persisted stores a change from elsewhere is applied to, by persist name.
const stores = new Map();
// The main window and an original-message window follow changes in their
// stores. A settings or compose window does not: its owner relays every change
// to it, and applying it here as well would echo through that relay. An
// export window keeps choices of its own in memory that this would undo.
const followsInStores = () => !isChildWindow()
  || new URLSearchParams(window.location?.search || '').has('original');

export function registerPersistedStore(store) {
  const name = store?.persist?.getOptions?.()?.name;
  if (name) stores.set(name, store);
}

function applyToStore(name, before, after) {
  const store = stores.get(name);
  if (!store || !followsInStores()) return;
  if (!after || typeof after !== 'object' || !after.state || typeof after.state !== 'object') return;
  const version = store.persist?.getOptions?.()?.version ?? 0;
  // Written by another version of the store: it would need that migration.
  if ((after.version ?? 0) !== version) return;
  const prev = (before && typeof before === 'object' && before.state) || {};
  const patch = {};
  for (const key of new Set([...Object.keys(prev), ...Object.keys(after.state)])) {
    if (!deepEqual(prev[key], after.state[key])) patch[key] = after.state[key];
  }
  if (Object.keys(patch).length) store.setState(patch);
}

// Takes in the daemon's current values of `keys` (all keys when null):
// skips the ones this window has not written yet, and the ones it is writing.
async function refresh(keys) {
  let reply;
  try {
    reply = await rpc('settings.get', keys ? { keys } : {});
  } catch {
    return; // the next event or reconnect catches up
  }
  if (!isSnapshot(reply)) return;
  if (mode === 'pending') mode = 'daemon';
  noteVersion(reply.version);
  const names = keys || [...new Set([...cache.keys(), ...Object.keys(reply.values)])];
  for (const name of names) {
    if (dirty.has(name) || inflight.has(name)) continue;
    const has = Object.prototype.hasOwnProperty.call(reply.values, name);
    const before = cache.has(name) ? parse(cache.get(name)) : undefined;
    const after = has ? reply.values[name] : undefined;
    if (deepEqual(before, after)) continue;
    if (!has && !keys && localOnly.has(name)) continue;
    localOnly.delete(name);
    if (has) cache.set(name, JSON.stringify(after));
    else cache.delete(name);
    applyToStore(name, before, after);
  }
}

let listening = false;
function listenForChanges() {
  const listen = typeof window !== 'undefined' ? window.__TAURI__?.event?.listen : undefined;
  if (listening || typeof listen !== 'function') return;
  listening = true;
  const on = (name, cb) => Promise.resolve().then(() => listen(name, cb)).catch(() => {});
  on('settings-changed', ({ payload } = {}) => {
    const keys = Array.isArray(payload?.keys) ? payload.keys.filter(k => typeof k === 'string') : [];
    if (!keys.length) return;
    // This window's own write, or one it has already taken in.
    if (Number.isInteger(payload.version) && lastVersion != null && payload.version <= lastVersion) return;
    void refresh(keys);
  });
  // A restarted daemon, or an event stream that dropped events: compare all,
  // and send what was queued while it was gone.
  const catchUp = () => {
    void refresh(null);
    if (dirty.size && writesEnabled) void writeQueued().catch(e => console.warn('[safeStorage] Failed to write settings:', errText(e)));
  };
  on('daemon-reconnected', catchUp);
  on('daemon-events-lagged', catchUp);
}

// A change in this window: queued to write, or, in a window that cannot
// write, kept in its own memory only.
function track(name) {
  if (!writesEnabled) {
    localOnly.add(name);
    return;
  }
  dirty.add(name);
  if (!settledLoad && invoke) early.add(name);
  debouncedSave();
}

export const safeStorage = {
  // Returns a Promise — Zustand's createJSONStorage handles this via .then()
  getItem: (name) => {
    return ensureLoaded().then(() => cache.get(name) ?? null);
  },
  setItem: (name, value) => {
    cache.set(name, value);
    track(name);
  },
  removeItem: (name) => {
    cache.delete(name);
    track(name);
  },
};
