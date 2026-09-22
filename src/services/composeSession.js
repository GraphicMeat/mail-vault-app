import { safeStorage } from '../stores/safeStorage';

const KEY = 'mailvault-compose-session';

const unfinished = (window) => Boolean(window?.initialData);

export function mergeComposeSession(current, restored) {
  let nextId = Math.max(0, ...current.map(window => window.id || 0), ...restored.map(window => window.id || 0));
  const used = new Set(current.map(window => window.id));
  return [...current, ...restored.map(window => {
    if (!used.has(window.id)) {
      used.add(window.id);
      return window;
    }
    nextId += 1;
    used.add(nextId);
    return { ...window, id: nextId };
  })];
}

export async function loadComposeSession() {
  try {
    const raw = await safeStorage.getItem(KEY);
    const windows = raw ? JSON.parse(raw) : [];
    return Array.isArray(windows)
      ? windows.filter(unfinished).map(window => ({ ...window, minimized: true, detached: false, nativeLabel: undefined }))
      : [];
  } catch { return []; }
}

export function saveComposeSession(windows) {
  const drafts = windows
    .map(window => ({ ...window, initialData: window.snapshot || window.initialData, snapshot: undefined }))
    .filter(unfinished)
    .map(window => ({ ...window, minimized: true, detached: false, nativeLabel: undefined }));
  if (!drafts.length) return clearComposeSession();
  safeStorage.setItem(KEY, JSON.stringify(drafts));
}

export function clearComposeSession() {
  safeStorage.removeItem(KEY);
}
