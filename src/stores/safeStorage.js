// Tauri filesystem-backed storage for Zustand persist.
// Completely bypasses localStorage/WKWebView storage (which throws
// "SecurityError: The operation is insecure" in App Sandbox).
//
// Uses Tauri invoke to read/write JSON files in the app data directory.
// Falls back to in-memory storage if Tauri is not available (dev browser).

const invoke = typeof window !== 'undefined' ? window.__TAURI__?.core?.invoke : undefined;

// In-memory cache — always holds the current state.
const cache = new Map();

// Promise that resolves once disk data has been loaded into cache.
let loadPromise = null;

function ensureLoaded() {
  if (loadPromise) return loadPromise;
  if (!invoke) {
    loadPromise = Promise.resolve();
    return loadPromise;
  }
  loadPromise = invoke('read_settings_json')
    .then(data => {
      if (data && data !== '{}') {
        try {
          const parsed = JSON.parse(data);
          for (const [key, value] of Object.entries(parsed)) {
            // Only set if not already in cache (in-session writes take priority)
            if (!cache.has(key)) {
              cache.set(key, JSON.stringify(value));
            }
          }
          console.log('[safeStorage] Loaded settings from disk:', Object.keys(parsed).join(', '));
        } catch (e) {
          console.warn('[safeStorage] Failed to parse settings:', e);
        }
      }
    })
    .catch(e => {
      console.warn('[safeStorage] Could not load settings from disk:', e);
    });
  return loadPromise;
}

// Save all cached data to Tauri filesystem
// Rejects when the write fails, so flushSafeStorage() can report it.
async function writeToDisk() {
  if (!writesEnabled) return;
  if (!invoke) return;
  const obj = {};
  for (const [key, value] of cache.entries()) {
    try { obj[key] = JSON.parse(value); } catch { obj[key] = value; }
  }
  await invoke('write_settings_json', { data: JSON.stringify(obj) });
}

// The debounced path: warns on failure and never rejects.
function saveToDisk() {
  return writeToDisk().catch(e => console.warn('[safeStorage] Failed to write settings:', e));
}

// Debounced save — avoids excessive disk writes
let saveTimer = null;
// The detached compose bundle imports the same persisted stores, but its
// snapshot is intentionally partial. Decide before Zustand can hydrate so it
// can never overwrite the main window's settings file during child startup.
let writesEnabled = typeof window === 'undefined'
  || !['compose', 'original', 'settings'].some(key => new URLSearchParams(window.location?.search || '').has(key));
function debouncedSave() {
  if (!writesEnabled) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDisk, 500);
}

// Detached compose receives a settings snapshot from its owner. It may read
// defaults but must never serialize its partial webview cache over main state.
export function setSafeStorageWriteEnabled(enabled) {
  writesEnabled = Boolean(enabled);
  if (!writesEnabled && saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// Write now instead of in 500ms, and resolve once the file is written: a
// caller about to reload the window (account transfer import) would otherwise
// lose whatever the debounce had not yet saved. One write covers every
// persisted store (settings and theme share this cache). A no-op in windows
// whose writes are disabled (detached compose/settings). REJECTS when the
// write fails, so the caller can tell the user their settings did not land.
export async function flushSafeStorage() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await ensureLoaded(); // never write a cache that is missing on-disk keys
  await writeToDisk();
}

export const safeStorage = {
  // Returns a Promise — Zustand's createJSONStorage handles this via .then()
  getItem: (name) => {
    return ensureLoaded().then(() => cache.get(name) ?? null);
  },
  setItem: (name, value) => {
    cache.set(name, value);
    debouncedSave();
  },
  removeItem: (name) => {
    cache.delete(name);
    debouncedSave();
  },
};
