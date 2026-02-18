// Safe localStorage wrapper for Zustand persist.
// Falls back to in-memory storage if localStorage is unavailable
// (e.g. WKWebView in App Sandbox throwing "SecurityError: The operation is insecure").

let storageAvailable = null;

function isLocalStorageAvailable() {
  if (storageAvailable !== null) return storageAvailable;
  try {
    const key = '__mailvault_storage_test__';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    storageAvailable = true;
  } catch {
    console.warn('[safeStorage] localStorage is not available, using in-memory fallback');
    storageAvailable = false;
  }
  return storageAvailable;
}

// In-memory fallback store
const memoryStore = new Map();

export const safeStorage = {
  getItem: (name) => {
    if (isLocalStorageAvailable()) {
      return localStorage.getItem(name);
    }
    return memoryStore.get(name) ?? null;
  },
  setItem: (name, value) => {
    if (isLocalStorageAvailable()) {
      localStorage.setItem(name, value);
    } else {
      memoryStore.set(name, value);
    }
  },
  removeItem: (name) => {
    if (isLocalStorageAvailable()) {
      localStorage.removeItem(name);
    } else {
      memoryStore.delete(name);
    }
  },
};
