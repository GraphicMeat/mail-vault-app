import { createDemoBackend, ACCOUNTS } from './backend.js';
import { DemoWorkspaceStorage, DEMO_STORAGE_SCHEMA, DEMO_SEED_VERSION } from './storage.js';

// Defaults are installed into the backend before any React/store module is
// imported. A restored workspace replaces them during initialization.
const settingsState = {
  onboardingComplete: true, appearanceOnboardingPromptSeen: true, language: 'en',
  sidebarLayout: 'split', sidebarDensity: 'comfortable', sidebarStyle: 'list',
  emailListView: 'list', threadMode: 'grouped', cacheLimitMB: 128,
  linkSafetyEnabled: true, linkSafetyClickConfirm: true, trackerBlockingEnabled: true,
  trackerAlerts: {}, cleanupRules: [], cleanupRulesDisarmed: false, backupGlobalEnabled: true,
  billingProfile: { customerId: 'demo-customer', hasSubscription: true, premiumAccess: true, status: 'active', interval: 'year', clientLimit: 3, activeClientCount: 3, demo: true },
  billingLastChecked: Date.now(), premiumPricing: null,
  insightsPreferences: { defaultPeriod: 'year', defaultMetric: 'volume' },
};

export function demoSettings() {
  return {
    'mailvault-settings': { state: settingsState, version: 5 },
    'mailvault-theme': { state: { theme: 'dark', palette: 'graphite' }, version: 0 },
  };
}

export const demoBackend = createDemoBackend({ initialSettings: demoSettings() });
const files = new Map([['accounts.json', JSON.stringify(ACCOUNTS)]]);
const storage = new DemoWorkspaceStorage();
let initialized = false;
let initializationPromise = null;
let resetPromise = null;
let persistTimer = null;
let persistQueue = Promise.resolve();
let generation = 0;
let workspaceGeneration = null;
let persistenceBlocked = false;
let expiryTimer = null;
let settingsUnsubscribe = null;
let themeUnsubscribe = null;
let settingsWriteQueue = Promise.resolve();
let expiredNoticeVisible = false;
let storageStatus = { status: 'starting', mode: 'memory', schemaVersion: DEMO_STORAGE_SCHEMA, seedVersion: DEMO_SEED_VERSION };
const EXPIRED_NOTICE_KEY = 'mailvault-demo-expired-notice';

const notifyExpiry = () => {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage?.setItem(EXPIRED_NOTICE_KEY, JSON.stringify({ at: Date.now() })); } catch { /* sessionStorage can be blocked */ }
  if (typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('mailvault-demo-expired', { detail: storageStatus }));
  // Mounted stores own transient compose/outbox state. Reloading after the
  // reset gives every store a clean seed and cannot replay pending work.
  if (typeof window.location?.reload === 'function') window.setTimeout(() => window.location.reload(), 0);
};

const emitStorageStatus = (status, details = {}) => {
  const visibleStatus = expiredNoticeVisible && status === 'saved' ? 'expired' : status;
  storageStatus = { ...storageStatus, status: visibleStatus, mode: status === 'unavailable' || status === 'quota' ? 'memory' : 'indexeddb', ...details, ...(expiredNoticeVisible ? { expiredNotice: true } : {}) };
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
  if (Number.isFinite(Number(storageStatus.expiresAt)) && !persistenceBlocked && Number(storageStatus.expiresAt) > Date.now()) {
    expiryTimer = setTimeout(() => { expiryTimer = null; checkDemoExpiry().catch(() => emitStorageStatus('unavailable')); }, Math.max(0, Number(storageStatus.expiresAt) - Date.now()));
  }
  demoBackend.invoke('demo_emit_event', { event: 'demo:state', payload: { type: 'storage-status', ...storageStatus } }).catch(() => {});
};

const workspaceState = () => ({ backend: demoBackend.exportState(), files: [...files.entries()].map(([path, data]) => [path, String(data)]) });

const restoreFiles = entries => {
  files.clear();
  for (const [path, data] of entries || []) if (typeof path === 'string' && typeof data === 'string') files.set(path, data);
  if (!files.has('accounts.json')) files.set('accounts.json', JSON.stringify(ACCOUNTS));
};

const persistNow = async expectedGeneration => {
  if (!initialized || persistenceBlocked || expectedGeneration !== generation) return { ok: false, status: 'skipped' };
  let result;
  try { result = await storage.write(workspaceState(), { generation: workspaceGeneration }); } catch (error) { result = { ok: false, status: 'unavailable', error }; }
  if (expectedGeneration !== generation) return { ok: false, status: 'stale' };
  if (result.status === 'stale') {
    persistenceBlocked = true; generation += 1; emitStorageStatus('stale', { generation: result.generation });
    if (typeof window !== 'undefined') {
      if (typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('mailvault-demo-workspace-conflict', { detail: storageStatus }));
      if (typeof window.location?.reload === 'function') window.setTimeout(() => window.location.reload(), 0);
    }
  } else if (result.status === 'expired') {
    persistenceBlocked = true; generation += 1; demoBackend.reset(); restoreFiles([]); emitStorageStatus('expired', { expiresAt: result.expiredAt });
    notifyExpiry();
  } else if (result.ok) { workspaceGeneration = result.generation ?? workspaceGeneration; emitStorageStatus('saved', { createdAt: result.createdAt, expiresAt: result.expiresAt, bytes: result.bytes, generation: workspaceGeneration }); }
  else emitStorageStatus(result.status || 'unavailable', { bytes: result.bytes, budgetBytes: result.budgetBytes });
  return result;
};

const flushPersistence = async () => {
  if (persistTimer) {
    clearTimeout(persistTimer); persistTimer = null;
    const expectedGeneration = generation;
    if (initialized && !persistenceBlocked) persistQueue = persistQueue.then(() => persistNow(expectedGeneration));
  }
  await persistQueue;
  return persistQueue;
};

const schedulePersist = ({ immediate = false } = {}) => {
  if (!initialized || persistenceBlocked) return;
  if (persistTimer) clearTimeout(persistTimer);
  const expectedGeneration = generation;
  const enqueue = () => { persistTimer = null; persistQueue = persistQueue.then(() => persistNow(expectedGeneration)); };
  if (immediate) enqueue(); else persistTimer = setTimeout(enqueue, 250);
};

const checkDemoExpiry = async () => {
  if (!initialized || persistenceBlocked) return storageStatus;
  const result = await storage.read({ includeState: false });
  if (result.status === 'expired') {
    persistenceBlocked = true; generation += 1;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    demoBackend.reset(); restoreFiles([]); emitStorageStatus('expired', { expiresAt: result.expiredAt });
    notifyExpiry();
  } else if (result.status === 'unavailable') emitStorageStatus('unavailable');
  else if (workspaceGeneration !== null && result.generation !== workspaceGeneration) {
    // A reset or replacement in another tab changes the marker even when the
    // current record is still readable. Do not let this tab write its stale
    // stores back over the fresh workspace on resume.
    persistenceBlocked = true; generation += 1;
    emitStorageStatus('stale', { generation: result.generation });
    if (typeof window !== 'undefined') {
      if (typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('mailvault-demo-workspace-conflict', { detail: storageStatus }));
      if (typeof window.location?.reload === 'function') window.setTimeout(() => window.location.reload(), 0);
    }
  }
  return storageStatus;
};

export const demoFiles = {
  read(path) { return files.get(path) ?? null; },
  write(path, data) { files.set(path, String(data)); schedulePersist(); },
  exists(path) { return path === 'accounts.json' || files.has(path); },
  list(path) {
    const prefix = path ? `${path.replace(/\/$/, '')}/` : '';
    return [...files.keys()].filter(file => file.startsWith(prefix)).map(file => ({ path: file.slice(prefix.length), name: file.slice(prefix.length), isFile: true, isDirectory: false }));
  },
};

demoBackend.on('demo:state', ({ payload }) => { if (payload?.type !== 'storage-status') schedulePersist(); });

export async function initializeDemoSession() {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    const result = await storage.read();
    let hadExpiredNotice = false;
    if (typeof window !== 'undefined') {
      try {
        hadExpiredNotice = !!window.sessionStorage?.getItem(EXPIRED_NOTICE_KEY);
        if (hadExpiredNotice) window.sessionStorage.removeItem(EXPIRED_NOTICE_KEY);
      } catch { hadExpiredNotice = false; }
    }
    expiredNoticeVisible = hadExpiredNotice || result.status === 'expired';
    if (result.status === 'restored') {
      try { demoBackend.restoreState(result.state.backend); restoreFiles(result.state.files); workspaceGeneration = result.generation ?? null; initialized = true; emitStorageStatus('restored', { createdAt: result.createdAt, expiresAt: result.expiresAt, bytes: result.bytes, generation: workspaceGeneration }); }
      catch (error) { await storage.clear(); demoBackend.reset(); restoreFiles([]); initialized = true; emitStorageStatus('corrupt', { error: String(error?.message || error) }); schedulePersist({ immediate: true }); }
    } else {
      initialized = true; workspaceGeneration = result.generation ?? null; demoBackend.reset(); restoreFiles([]); emitStorageStatus(hadExpiredNotice ? 'expired' : result.status === 'empty' ? 'new' : result.status, { expiresAt: result.expiredAt, generation: workspaceGeneration });
    }
    // Establish the fixed seven-day record on first entry. Later mutations
    // are debounced, and a reset/expiry can never revive an old record.
    if (result.status === 'empty' || result.status === 'reset' || result.status === 'incompatible' || result.status === 'expired' || result.status === 'corrupt') schedulePersist({ immediate: true });
    if (typeof window !== 'undefined') {
      const resume = () => { checkDemoExpiry().catch(() => emitStorageStatus('unavailable')); };
      window.addEventListener('focus', resume); window.addEventListener('pageshow', resume);
      window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
      window.addEventListener('pagehide', () => { flushDemoPersistence().catch(() => {}); });
    }
    return storageStatus;
  })().catch(error => { initialized = true; emitStorageStatus('unavailable', { error: String(error?.message || error) }); return storageStatus; });
  return initializationPromise;
}

export function getDemoStorageStatus() { return { ...storageStatus }; }

export async function resetDemoSession() {
  if (resetPromise) return resetPromise;
  resetPromise = (async () => {
    generation += 1; persistenceBlocked = true;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    // Finish a settings mirror already queued by a control change before
    // clearing the record. Otherwise that old write could land after reset.
    await settingsWriteQueue;
    await flushPersistence();
    const cleared = await storage.clear();
    demoBackend.reset(); restoreFiles([]); workspaceGeneration = cleared.generation ?? workspaceGeneration; persistenceBlocked = false; expiredNoticeVisible = false;
    emitStorageStatus(cleared.ok ? 'reset' : 'unavailable');
    return cleared;
  })().finally(() => { resetPromise = null; });
  return resetPromise;
}

// safeStorage intentionally debounces its Tauri write by 500ms. The demo
// mirrors the hydrated Zustand state into the backend immediately as well, so
// a tab closed during that debounce still has a current workspace snapshot.
export function bindDemoSettingsStore(store) {
  settingsUnsubscribe?.();
  if (!store?.subscribe) return () => {};
  const persistSettings = state => {
    const snapshot = { ...state };
    settingsWriteQueue = settingsWriteQueue.then(async () => {
      let current = {};
      try { current = JSON.parse(await demoBackend.invoke('read_settings_json')) || {}; } catch { /* defaults remain valid */ }
      current['mailvault-settings'] = { state: snapshot, version: 5 };
      await demoBackend.invoke('write_settings_json', { data: JSON.stringify(current) });
      schedulePersist({ immediate: true });
    }).catch(() => {});
  };
  settingsUnsubscribe = store.subscribe(persistSettings);
  persistSettings(store.getState?.() || {});
  return settingsUnsubscribe;
}

export function bindDemoThemeStore(store) {
  themeUnsubscribe?.();
  if (!store?.subscribe) return () => {};
  const persistTheme = state => {
    const snapshot = { ...state };
    settingsWriteQueue = settingsWriteQueue.then(async () => {
      let current = {};
      try { current = JSON.parse(await demoBackend.invoke('read_settings_json')) || {}; } catch { /* defaults remain valid */ }
      current['mailvault-theme'] = { state: snapshot, version: 0 };
      await demoBackend.invoke('write_settings_json', { data: JSON.stringify(current) });
      schedulePersist({ immediate: true });
    }).catch(() => {});
  };
  themeUnsubscribe = store.subscribe(persistTheme);
  persistTheme(store.getState?.() || {});
  return themeUnsubscribe;
}

export async function flushDemoPersistence() {
  await settingsWriteQueue;
  await flushPersistence();
}

export function installDemoGlobals() {
  if (typeof window === 'undefined') return;
  document.body.dataset.mailvaultDemo = 'true';
  window.__MAILVAULT_DEMO__ = { backend: demoBackend, accounts: ACCOUNTS, reset: resetDemoSession, flush: flushDemoPersistence, storage: getDemoStorageStatus };
  window.__TAURI__ = { core: { invoke: demoBackend.invoke }, invoke: demoBackend.invoke };
  if (!window.__MAILVAULT_DEMO_GUARDS__) {
    const originalFetch = window.fetch?.bind(window);
    const normalizeUrl = input => { const raw = typeof input === 'string' ? input : input?.url || input?.href || String(input || ''); try { return new URL(raw, window.location.href); } catch { return null; } };
    const isBlocked = input => { const url = normalizeUrl(input); if (!url) return true; return !['http:', 'https:'].includes(url.protocol) || url.origin !== window.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/'); };
    const announceBlocked = () => demoBackend.invoke('demo_emit_event', { event: 'demo:state', payload: { type: 'unsupported-network' } }).catch(() => {});
    if (originalFetch) window.fetch = (input, init) => { if (isBlocked(input)) { announceBlocked(); return Promise.reject(new demoBackend.DemoUnsupportedError('external_network_request')); } return originalFetch(input, init); };
    const originalOpen = window.open?.bind(window);
    if (originalOpen) window.open = (url, ...rest) => { if (isBlocked(url)) { announceBlocked(); return null; } return originalOpen(url, ...rest); };
    window.__MAILVAULT_DEMO_GUARDS__ = true;
  }
}
