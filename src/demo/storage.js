/*
 * Small, deliberately boring storage boundary for the browser demo.
 *
 * The real app owns its local files through Tauri. The website demo owns one
 * IndexedDB record instead, with a fixed lifetime and an application budget.
 * Keeping this module independent from React and the demo backend makes the
 * expiry and failure behaviour straightforward to test.
 */

export const DEMO_STORAGE_SCHEMA = 1;
export const DEMO_SEED_VERSION = 'demo-300-v1';
export const DEMO_STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEMO_STORAGE_BUDGET_BYTES = 5 * 1024 * 1024;
export const DEMO_STORAGE_DB_NAME = 'mailvault-browser-demo';
export const DEMO_STORAGE_STORE_NAME = 'workspace';
export const DEMO_STORAGE_KEY = 'current';
export const DEMO_GENERATION_KEY = 'generation';

const encodeSize = value => {
  try {
    return typeof TextEncoder === 'function'
      ? new TextEncoder().encode(value).byteLength
      : unescape(encodeURIComponent(value)).length;
  } catch {
    return String(value).length * 2;
  }
};

const asError = error => error instanceof Error ? error : new Error(String(error || 'storage error'));
const newGeneration = now => typeof globalThis.crypto?.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : `demo-${now}-${Math.random().toString(36).slice(2)}`;
// `null` means an unguarded first write, while the empty string is a real
// compare token for a legacy record that predates generation markers.
const generationMatches = (expected, actual) => expected === null || (expected === '' ? actual === null : expected === actual);

// Tests and private browsing implementations can inject this tiny async
// adapter. The production path below uses IndexedDB directly.
export function createMemoryStorageAdapter(initial = null) {
  let value = initial;
  let generation = null;
  const copy = input => typeof structuredClone === 'function'
    ? structuredClone(input)
    : JSON.parse(JSON.stringify(input));
  return {
    async get(key = DEMO_STORAGE_KEY) { const selected = key === DEMO_GENERATION_KEY ? generation : value; return selected == null ? null : copy(selected); },
    async put(next, key = DEMO_STORAGE_KEY) { if (key === DEMO_GENERATION_KEY) generation = copy(next); else value = copy(next); },
    async delete(key = DEMO_STORAGE_KEY) { if (key === DEMO_GENERATION_KEY) generation = null; else value = null; },
    async clear() { value = null; },
    async compareAndPut(next, expectedGeneration = null) {
      const existingGeneration = generation?.generation || value?.generation || null;
      if (!generationMatches(expectedGeneration, existingGeneration)) return { committed: false, generation: existingGeneration };
      value = copy(next);
      return { committed: true };
    },
    async clearAndMark(next) { value = null; generation = copy(next); },
    async invalidate(expectedGeneration, now = Date.now(), expectedExpiresAt = null) {
      const existingGeneration = generation?.generation || value?.generation || null;
      const currentExpiresAt = value && Number.isFinite(Number(value.expiresAt)) ? Number(value.expiresAt) : null;
      if (expectedGeneration !== existingGeneration) return { invalidated: false, stale: true, generation: existingGeneration };
      if (expectedExpiresAt !== null && currentExpiresAt !== expectedExpiresAt) return { invalidated: false, stale: true, generation: existingGeneration };
      generation = { generation: newGeneration(now), resetAt: now }; value = null;
      return { invalidated: true, generation: generation.generation };
    },
    get value() { return value == null ? null : copy(value); },
    get generation() { return generation == null ? null : copy(generation); },
  };
}

export class DemoWorkspaceStorage {
  constructor({
    indexedDB = globalThis.indexedDB,
    now = () => Date.now(),
    schemaVersion = DEMO_STORAGE_SCHEMA,
    seedVersion = DEMO_SEED_VERSION,
    budgetBytes = DEMO_STORAGE_BUDGET_BYTES,
    ttlMs = DEMO_STORAGE_TTL_MS,
    adapter = null,
  } = {}) {
    this.indexedDB = indexedDB;
    this.now = now;
    this.schemaVersion = schemaVersion;
    this.seedVersion = seedVersion;
    this.budgetBytes = budgetBytes;
    this.ttlMs = ttlMs;
    this.adapter = adapter;
    this.dbPromise = null;
  }

  async open() {
    if (this.adapter) return this.adapter;
    if (!this.indexedDB?.open) throw new Error('IndexedDB is unavailable');
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        let request;
        try { request = this.indexedDB.open(DEMO_STORAGE_DB_NAME, DEMO_STORAGE_SCHEMA); } catch (error) { reject(error); return; }
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(DEMO_STORAGE_STORE_NAME)) {
            database.createObjectStore(DEMO_STORAGE_STORE_NAME);
          }
        };
        request.onsuccess = () => resolve({
          async get(key = DEMO_STORAGE_KEY) {
            return new Promise((res, rej) => {
              const database = request.result;
              const tx = database.transaction(DEMO_STORAGE_STORE_NAME, 'readonly');
              const op = tx.objectStore(DEMO_STORAGE_STORE_NAME).get(key);
              let result = null;
              op.onsuccess = () => { result = op.result ?? null; };
              tx.oncomplete = () => res(result);
              tx.onerror = () => rej(tx.error || op.error || new Error('IndexedDB read failed'));
              tx.onabort = () => rej(tx.error || new Error('IndexedDB read aborted'));
            });
          },
          async put(value, key = DEMO_STORAGE_KEY) {
            return new Promise((res, rej) => {
              const database = request.result;
              const tx = database.transaction(DEMO_STORAGE_STORE_NAME, 'readwrite');
              const op = tx.objectStore(DEMO_STORAGE_STORE_NAME).put(value, key);
              tx.oncomplete = () => res();
              tx.onerror = () => rej(tx.error || op.error || new Error('IndexedDB write failed'));
              tx.onabort = () => rej(tx.error || new Error('IndexedDB write aborted'));
            });
          },
          async delete(key = DEMO_STORAGE_KEY) {
            return new Promise((res, rej) => {
              const database = request.result;
              const tx = database.transaction(DEMO_STORAGE_STORE_NAME, 'readwrite');
              const op = tx.objectStore(DEMO_STORAGE_STORE_NAME).delete(key);
              tx.oncomplete = () => res();
              tx.onerror = () => rej(tx.error || op.error || new Error('IndexedDB delete failed'));
              tx.onabort = () => rej(tx.error || new Error('IndexedDB delete aborted'));
            });
          },
          async compareAndPut(value, expectedGeneration = null) {
            return new Promise((res, rej) => {
              const database = request.result;
              const tx = database.transaction(DEMO_STORAGE_STORE_NAME, 'readwrite');
              const objectStore = tx.objectStore(DEMO_STORAGE_STORE_NAME);
              let current = null; let marker = null; let reads = 0; let stale = null; let writeStarted = false;
              const readDone = () => {
                reads += 1;
                if (reads !== 2) return;
                const existingGeneration = marker?.generation || current?.generation || null;
                if (!generationMatches(expectedGeneration, existingGeneration)) { stale = { committed: false, generation: existingGeneration }; return; }
                writeStarted = true; objectStore.put(value, DEMO_STORAGE_KEY);
              };
              const currentOp = objectStore.get(DEMO_STORAGE_KEY); currentOp.onsuccess = () => { current = currentOp.result ?? null; readDone(); };
              const markerOp = objectStore.get(DEMO_GENERATION_KEY); markerOp.onsuccess = () => { marker = markerOp.result ?? null; readDone(); };
              tx.oncomplete = () => res(stale || { committed: writeStarted });
              tx.onerror = () => rej(tx.error || new Error('IndexedDB compare-and-write failed'));
              tx.onabort = () => rej(tx.error || new Error('IndexedDB compare-and-write aborted'));
            });
          },
          async clearAndMark(value) {
            return new Promise((res, rej) => {
              const database = request.result;
              const tx = database.transaction(DEMO_STORAGE_STORE_NAME, 'readwrite');
              const objectStore = tx.objectStore(DEMO_STORAGE_STORE_NAME);
              objectStore.delete(DEMO_STORAGE_KEY); objectStore.put(value, DEMO_GENERATION_KEY);
              tx.oncomplete = () => res();
              tx.onerror = () => rej(tx.error || new Error('IndexedDB reset failed'));
              tx.onabort = () => rej(tx.error || new Error('IndexedDB reset aborted'));
            });
          },
          async invalidate(expectedGeneration, now = Date.now(), expectedExpiresAt = null) {
            return new Promise((res, rej) => {
              const database = request.result;
              const tx = database.transaction(DEMO_STORAGE_STORE_NAME, 'readwrite');
              const objectStore = tx.objectStore(DEMO_STORAGE_STORE_NAME);
              let current = null; let marker = null; let reads = 0; let result;
              const done = () => {
                reads += 1;
                if (reads !== 2) return;
                const existingGeneration = marker?.generation || current?.generation || null;
                const currentExpiresAt = current && Number.isFinite(Number(current.expiresAt)) ? Number(current.expiresAt) : null;
                if (expectedGeneration !== existingGeneration) { result = { invalidated: false, stale: true, generation: existingGeneration }; return; }
                if (expectedExpiresAt !== null && currentExpiresAt !== expectedExpiresAt) { result = { invalidated: false, stale: true, generation: existingGeneration }; return; }
                const generation = newGeneration(now);
                objectStore.delete(DEMO_STORAGE_KEY); objectStore.put({ generation, resetAt: now }, DEMO_GENERATION_KEY);
                result = { invalidated: true, generation };
              };
              const currentOp = objectStore.get(DEMO_STORAGE_KEY); currentOp.onsuccess = () => { current = currentOp.result ?? null; done(); };
              const markerOp = objectStore.get(DEMO_GENERATION_KEY); markerOp.onsuccess = () => { marker = markerOp.result ?? null; done(); };
              tx.oncomplete = () => res(result);
              tx.onerror = () => rej(tx.error || new Error('IndexedDB invalidation failed'));
              tx.onabort = () => rej(tx.error || new Error('IndexedDB invalidation aborted'));
            });
          },
        });
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
        request.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
    }
    return this.dbPromise;
  }

  async read({ includeState = true, _retry = 0 } = {}) {
    let store; let record; let generationMarker;
    try {
      store = await this.open(); record = await store.get(); generationMarker = await store.get(DEMO_GENERATION_KEY);
    } catch (error) {
      return { state: null, status: 'unavailable', degraded: true, error: asError(error) };
    }
    if (!record) return { state: null, status: generationMarker ? 'reset' : 'empty', degraded: false, generation: generationMarker?.generation ?? null };
    // Legacy records have no token at all. Preserve that fact with an empty
    // sentinel so a restored tab can guard its first write against a reset;
    // null remains reserved for a genuinely new workspace.
    const observedGeneration = typeof record.generation === 'string'
      ? record.generation
      : (generationMarker?.generation ?? '');
    const createdAt = Number(record.createdAt);
    const expiresAt = Number(record.expiresAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt || this.now() >= expiresAt) {
      const invalidated = await store.invalidate(record.generation ?? null, this.now(), Number.isFinite(expiresAt) ? expiresAt : null);
      if (invalidated.stale) return _retry ? { state: null, status: 'stale', generation: invalidated.generation } : this.read({ includeState, _retry: _retry + 1 });
      return { state: null, status: 'expired', expiredAt: expiresAt, generation: invalidated.generation };
    }
    if (record.schemaVersion !== this.schemaVersion || record.seedVersion !== this.seedVersion) {
      const invalidated = await store.invalidate(record.generation ?? null, this.now(), Number.isFinite(expiresAt) ? expiresAt : null);
      if (invalidated.stale) return _retry ? { state: null, status: 'incompatible', generation: invalidated.generation } : this.read({ includeState, _retry: _retry + 1 });
      return { state: null, status: 'incompatible', generation: invalidated.generation };
    }
    if (!includeState) return { state: null, status: 'valid', createdAt: record.createdAt, expiresAt, generation: observedGeneration };
    if (typeof record.payloadJson !== 'string' || !Number.isFinite(Number(record.bytes)) || Number(record.bytes) < 0 || Number(record.bytes) > this.budgetBytes || encodeSize(record.payloadJson) !== Number(record.bytes)) {
      const invalidated = await store.invalidate(record.generation ?? null, this.now(), Number.isFinite(expiresAt) ? expiresAt : null);
      if (invalidated.stale) return _retry ? { state: null, status: 'corrupt', generation: invalidated.generation } : this.read({ includeState, _retry: _retry + 1 });
      return { state: null, status: 'corrupt', generation: invalidated.generation };
    }
    try {
      const state = JSON.parse(record.payloadJson);
      if (!state || typeof state !== 'object') throw new Error('workspace payload is not an object');
      return { state, status: 'restored', createdAt: record.createdAt, expiresAt, bytes: record.bytes, generation: observedGeneration };
    } catch (error) {
      const invalidated = await store.invalidate(record.generation ?? null, this.now(), Number.isFinite(expiresAt) ? expiresAt : null);
      if (invalidated.stale) return _retry ? { state: null, status: 'corrupt', generation: invalidated.generation } : this.read({ includeState, _retry: _retry + 1 });
      return { state: null, status: 'corrupt', error: asError(error), generation: invalidated.generation };
    }
  }

  async write(state, { generation = null } = {}) {
    let current;
    try {
      const store = await this.open();
      current = await store.get();
      const marker = await store.get(DEMO_GENERATION_KEY);
      const existingGeneration = marker?.generation || current?.generation || null;
      if (!generationMatches(generation, existingGeneration)) return { ok: false, status: 'stale', generation: existingGeneration };
      current = { ...current, _generation: existingGeneration };
    } catch (error) {
      return { ok: false, status: 'unavailable', degraded: true, error: asError(error) };
    }
    const now = this.now();
    if (current && Number.isFinite(Number(current.expiresAt)) && now >= Number(current.expiresAt)) {
      const invalidated = await (await this.open()).invalidate(current._generation ?? null, now, Number(current.expiresAt));
      if (invalidated.stale) return { ok: false, status: 'stale', generation: invalidated.generation };
      return { ok: false, status: 'expired', expiredAt: current.expiresAt, generation: invalidated.generation };
    }
    let payloadJson;
    try { payloadJson = JSON.stringify(state); } catch (error) {
      return { ok: false, status: 'quota', error: asError(error) };
    }
    const bytes = encodeSize(payloadJson);
    if (bytes > this.budgetBytes) return { ok: false, status: 'quota', bytes, budgetBytes: this.budgetBytes };
    const currentIsCompatible = current && current.schemaVersion === this.schemaVersion && current.seedVersion === this.seedVersion
      && Number.isFinite(Number(current.createdAt)) && Number.isFinite(Number(current.expiresAt))
      && Number(current.expiresAt) > Number(current.createdAt) && now < Number(current.expiresAt);
    const createdAt = currentIsCompatible ? Number(current.createdAt) : now;
    const expiresAt = currentIsCompatible ? Number(current.expiresAt) : now + this.ttlMs;
    const nextGeneration = generation || current._generation || newGeneration(now);
    const record = { schemaVersion: this.schemaVersion, seedVersion: this.seedVersion, createdAt, expiresAt, bytes, payloadJson, generation: nextGeneration };
    try {
      // A generationless legacy record is still compare-and-written against
      // the absence of a marker. The successful write acquires a token.
      // A marker-only reset is carried through _generation and remains guarded.
      const expectedGeneration = generation !== null ? generation : (current._generation ?? null);
      const committed = await (await this.open()).compareAndPut(record, expectedGeneration);
      if (!committed.committed) return { ok: false, status: 'stale', generation: committed.generation };
      return { ok: true, status: 'saved', createdAt, expiresAt, bytes, generation: nextGeneration };
    } catch (error) {
      return { ok: false, status: 'quota', bytes, budgetBytes: this.budgetBytes, error: asError(error) };
    }
  }

  async clear() {
    try {
      const store = await this.open();
      const nextGeneration = newGeneration(this.now());
      await store.clearAndMark({ generation: nextGeneration, resetAt: this.now() });
      return { ok: true, status: 'cleared', generation: nextGeneration };
    } catch (error) {
      return { ok: false, status: 'unavailable', degraded: true, error: asError(error) };
    }
  }
}
