// Tauri filesystem-backed storage for Zustand persist.
// Completely bypasses localStorage/WKWebView storage (which throws
// "SecurityError: The operation is insecure" in App Sandbox).
//
// Uses Tauri invoke to read/write JSON files in the app data directory.
// Falls back to in-memory storage if Tauri is not available (dev browser).

const invoke = window.__TAURI__?.core?.invoke;

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
function saveToDisk() {
  if (!invoke) return;
  try {
    const obj = {};
    for (const [key, value] of cache.entries()) {
      try { obj[key] = JSON.parse(value); } catch { obj[key] = value; }
    }
    invoke('write_settings_json', { data: JSON.stringify(obj) })
      .catch(e => console.warn('[safeStorage] Failed to write settings:', e));
  } catch (e) {
    console.warn('[safeStorage] Failed to serialize settings:', e);
  }
}

// Debounced save — avoids excessive disk writes
let saveTimer = null;
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDisk, 500);
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
