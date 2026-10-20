import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Phase 1 step 0a: safeStorage reads and writes the settings document through
 * the daemon (`settings.get` / `settings.replace`), and keeps the shell's
 * read/write_settings_json as the fallback for a daemon that lacks them.
 *
 * `host()` is the shell plus a daemon: `daemon` is 'new' (knows settings.*),
 * 'old' (METHOD_NOT_FOUND, which the shell turns into errors.daemonOutdated)
 * or 'down' (errors.daemonUnavailable), and can be changed mid-test.
 */
function host({ daemon = 'new', disk = {}, search = '' } = {}) {
  const h = {
    daemon,
    disk: structuredClone(disk),
    version: 7,
    calls: [],
    listeners: new Map(),
    failNextReplace: null,
    holdReplace: null,
    // settings.get: 'ok', 'hang' (never answers), or an error to throw.
    get: 'ok',
    // read_settings_json: 'ok' or 'reject'.
    shellRead: 'ok',
  };
  const daemonRpc = async ({ method, params }) => {
    if (h.daemon === 'down') throw 'errors.daemonUnavailable';
    if (h.daemon === 'old') throw 'errors.daemonOutdated';
    if (method === 'settings.get') {
      if (h.get === 'hang') return new Promise(() => {});
      if (h.get !== 'ok') throw h.get;
      const keys = params?.keys;
      const values = Object.fromEntries(Object.entries(h.disk).filter(([k]) => !keys || keys.includes(k)));
      return structuredClone({ values, version: h.version });
    }
    if (method === 'settings.replace') {
      if (h.failNextReplace) { const e = h.failNextReplace; h.failNextReplace = null; throw e; }
      if (h.holdReplace) await h.holdReplace();
      const changed = [];
      for (const [k, v] of Object.entries(params.values)) {
        if (JSON.stringify(h.disk[k]) === JSON.stringify(v ?? undefined)) continue;
        if (v === null) delete h.disk[k]; else h.disk[k] = structuredClone(v);
        changed.push(k);
      }
      if (changed.length) h.version += 1;
      return { version: h.version, changed };
    }
    throw new Error(`unexpected daemon method ${method}`);
  };
  const invoke = vi.fn(async (cmd, args) => {
    h.calls.push(cmd === 'daemon_rpc' ? `daemon_rpc:${args.method}` : cmd);
    if (cmd === 'daemon_rpc') return daemonRpc(args);
    if (cmd === 'read_settings_json') {
      if (h.shellRead === 'reject') throw 'Failed to read settings: Permission denied (os error 13)';
      return JSON.stringify(h.disk);
    }
    if (cmd === 'write_settings_json') { h.disk = JSON.parse(args.data); return null; }
    return undefined;
  });
  h.invoke = invoke;
  h.emit = (name, payload) => { for (const cb of h.listeners.get(name) || []) cb({ payload }); };
  // Another writer (a second window's write through the daemon).
  h.externalWrite = (key, value) => {
    h.disk[key] = structuredClone(value);
    h.version += 1;
    h.emit('settings-changed', { keys: [key], version: h.version });
  };
  globalThis.window = {
    location: { search },
    __TAURI__: {
      core: { invoke },
      event: {
        listen: vi.fn(async (name, cb) => {
          if (!h.listeners.has(name)) h.listeners.set(name, []);
          h.listeners.get(name).push(cb);
          return () => {};
        }),
      },
    },
  };
  return h;
}

const SETTINGS = 'mailvault-settings';
const THEME = 'mailvault-theme';
const blob = (state, version = 3) => ({ state, version });
const settled = () => new Promise(r => setTimeout(r, 0));

async function load() {
  vi.resetModules();
  return import('../../src/stores/safeStorage.js');
}

describe('safeStorage through the daemon', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('hydrates from settings.get and never reads the file itself', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ language: 'de', listPaneSize: 470 }) } });
    const { safeStorage } = await load();
    const raw = await safeStorage.getItem(SETTINGS);
    expect(JSON.parse(raw).state).toEqual({ language: 'de', listPaneSize: 470 });
    expect(h.calls).toContain('daemon_rpc:settings.get');
    expect(h.calls).not.toContain('read_settings_json');
  });

  it('keeps the saved document over a write made before it loaded, and never writes that write over it', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ language: 'de', listPaneSize: 470, onboardingComplete: true }), [THEME]: blob({ theme: 'dark' }, 0) } });
    // A cold daemon: settings.get takes a while, and persist writes a store's
    // defaults on any setState meanwhile.
    let answer;
    const slow = h.invoke.getMockImplementation();
    h.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'daemon_rpc' && args.method === 'settings.get' && !answer) {
        await new Promise(r => { answer = r; });
      }
      return slow(cmd, args);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { safeStorage, flushSafeStorage } = await load();
    const hydrated = safeStorage.getItem(SETTINGS);
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ language: 'en' })));
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    answer();
    expect(JSON.parse(await hydrated).state).toEqual({ language: 'de', listPaneSize: 470, onboardingComplete: true });
    await flushSafeStorage();
    expect(h.disk[SETTINGS]).toEqual(blob({ language: 'de', listPaneSize: 470, onboardingComplete: true }));
    expect(h.calls).not.toContain('daemon_rpc:settings.replace');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/before they loaded: mailvault-settings/);
    // After the load, a write is the user's and wins as always.
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ language: 'en' })));
    await flushSafeStorage();
    expect(h.disk[SETTINGS]).toEqual(blob({ language: 'en' }));
    expect(h.disk[THEME]).toEqual(blob({ theme: 'dark' }, 0));
  });

  it('writes a key written before the load when the document does not have it yet', async () => {
    const h = host({ disk: { [THEME]: blob({ theme: 'dark' }, 0) } });
    const { safeStorage, flushSafeStorage } = await load();
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ language: 'en' })));
    await flushSafeStorage();
    expect(h.disk[SETTINGS]).toEqual(blob({ language: 'en' }));
  });

  it('writes only the changed store, whole, with settings.replace', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ hiddenAccounts: { a: true, b: true } }), [THEME]: blob({ theme: 'dark' }, 0) } });
    const { safeStorage, flushSafeStorage } = await load();
    await safeStorage.getItem(SETTINGS);
    // The store dropped account `a`: the key is replaced whole, so `a` is gone.
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ hiddenAccounts: { b: true } })));
    await flushSafeStorage();
    expect(h.disk[SETTINGS]).toEqual(blob({ hiddenAccounts: { b: true } }));
    expect(h.disk[THEME]).toEqual(blob({ theme: 'dark' }, 0));
    const replace = h.invoke.mock.calls.find(([c, a]) => c === 'daemon_rpc' && a.method === 'settings.replace');
    expect(Object.keys(replace[1].params.values)).toEqual([SETTINGS]);
    expect(replace[1].params.baseVersion).toBeUndefined();
    expect(h.calls).not.toContain('write_settings_json');
  });

  it('removeItem deletes the key in the document', async () => {
    const h = host({ disk: { [SETTINGS]: blob({}), 'mailvault-compose-session': [1] } });
    const { safeStorage, flushSafeStorage } = await load();
    await safeStorage.getItem(SETTINGS);
    safeStorage.removeItem('mailvault-compose-session');
    await flushSafeStorage();
    expect(h.disk).toEqual({ [SETTINGS]: blob({}) });
  });

  it('debounces writes by 500ms and sends one write for a burst', async () => {
    vi.useFakeTimers();
    const h = host({ disk: { [SETTINGS]: blob({ n: 0 }) } });
    const { safeStorage } = await load();
    await safeStorage.getItem(SETTINGS);
    for (let n = 1; n <= 5; n++) safeStorage.setItem(SETTINGS, JSON.stringify(blob({ n })));
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls.filter(c => c === 'daemon_rpc:settings.replace')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls.filter(c => c === 'daemon_rpc:settings.replace')).toHaveLength(1);
    expect(h.disk[SETTINGS]).toEqual(blob({ n: 5 }));
  });

  it('runs one write at a time, so an older value can never land last', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ n: 0 }) } });
    const { safeStorage, flushSafeStorage } = await load();
    await safeStorage.getItem(SETTINGS);
    let release;
    h.holdReplace = () => new Promise(r => { release = r; });
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ n: 1 })));
    const first = flushSafeStorage();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    h.holdReplace = null;
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ n: 2 })));
    const second = flushSafeStorage();
    await settled();
    expect(h.calls.filter(c => c === 'daemon_rpc:settings.replace')).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(h.disk[SETTINGS]).toEqual(blob({ n: 2 }));
  });

  it('keeps a failed write queued: flush rejects, and the change lands on the next write', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ n: 0 }), [THEME]: blob({ theme: 'dark' }, 0) } });
    const { safeStorage, flushSafeStorage } = await load();
    await safeStorage.getItem(SETTINGS);
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ n: 1 })));
    h.failNextReplace = 'errors.settingsWriteFailed';
    await expect(flushSafeStorage()).rejects.toBe('errors.settingsWriteFailed');
    expect(h.disk[SETTINGS]).toEqual(blob({ n: 0 }));
    safeStorage.setItem(THEME, JSON.stringify(blob({ theme: 'light' }, 0)));
    await flushSafeStorage();
    expect(h.disk[SETTINGS]).toEqual(blob({ n: 1 }));
    expect(h.disk[THEME]).toEqual(blob({ theme: 'light' }, 0));
  });

  it('retries a failed debounced write by itself and only warns', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = host({ disk: { [SETTINGS]: blob({ n: 0 }) } });
    const { safeStorage } = await load();
    await safeStorage.getItem(SETTINGS);
    h.failNextReplace = 'errors.settingsWriteFailed';
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ n: 1 })));
    await vi.advanceTimersByTimeAsync(600);
    expect(warn).toHaveBeenCalledWith('[safeStorage] Failed to write settings:', 'errors.settingsWriteFailed');
    expect(h.disk[SETTINGS]).toEqual(blob({ n: 0 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.disk[SETTINGS]).toEqual(blob({ n: 1 }));
  });

  it('writes through the shell when the daemon is unreachable, keeping the keys it did not change', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ n: 0 }), [THEME]: blob({ theme: 'dark' }, 0) } });
    const { safeStorage, flushSafeStorage } = await load();
    await safeStorage.getItem(SETTINGS);
    h.daemon = 'down';
    // Something else changed the theme on disk since this window loaded.
    h.disk[THEME] = blob({ theme: 'light' }, 0);
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ n: 1 })));
    await flushSafeStorage();
    expect(h.calls).toContain('write_settings_json');
    expect(h.disk).toEqual({ [SETTINGS]: blob({ n: 1 }), [THEME]: blob({ theme: 'light' }, 0) });
  });
});

describe('safeStorage with a daemon that lacks settings.*', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads and writes through read/write_settings_json after errors.daemonOutdated', async () => {
    const h = host({ daemon: 'old', disk: { [SETTINGS]: blob({ language: 'fr' }), [THEME]: blob({ theme: 'dark' }, 0) } });
    const { safeStorage, flushSafeStorage } = await load();
    expect(JSON.parse(await safeStorage.getItem(SETTINGS)).state.language).toBe('fr');
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ language: 'it' })));
    await flushSafeStorage();
    expect(h.disk).toEqual({ [SETTINGS]: blob({ language: 'it' }), [THEME]: blob({ theme: 'dark' }, 0) });
    // Detected once: the next write does not ask the daemon again.
    const asked = h.calls.filter(c => c.startsWith('daemon_rpc')).length;
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ language: 'es' })));
    await flushSafeStorage();
    expect(h.calls.filter(c => c.startsWith('daemon_rpc')).length).toBe(asked);
    expect(h.disk[SETTINGS]).toEqual(blob({ language: 'es' }));
  });

  it.each([
    ['undefined', undefined],
    ['an empty object', {}],
    ['values without a version', { values: {} }],
  ])('treats a daemon_rpc reply of %s as no settings.* and reads the file', async (_, reply) => {
    const disk = { [SETTINGS]: blob({ language: 'ja' }) };
    globalThis.window = {
      location: { search: '' },
      __TAURI__: { core: { invoke: vi.fn(async (cmd) => (cmd === 'daemon_rpc' ? reply : cmd === 'read_settings_json' ? JSON.stringify(disk) : undefined)) } },
    };
    const { safeStorage } = await load();
    expect(JSON.parse(await safeStorage.getItem(SETTINGS)).state.language).toBe('ja');
  });

  it('reads the file once when the daemon is unreachable at startup, then writes through it when it is back', async () => {
    const h = host({ daemon: 'down', disk: { [SETTINGS]: blob({ language: 'ko' }) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { safeStorage, flushSafeStorage } = await load();
    expect(JSON.parse(await safeStorage.getItem(SETTINGS)).state.language).toBe('ko');
    expect(h.calls.filter(c => c === 'read_settings_json')).toHaveLength(1);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/read the settings file through the shell/);
    h.daemon = 'new';
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ language: 'de' })));
    await flushSafeStorage();
    expect(h.calls).toContain('daemon_rpc:settings.replace');
    expect(h.calls).not.toContain('write_settings_json');
    expect(h.disk[SETTINGS]).toEqual(blob({ language: 'de' }));
  });
});

describe('safeStorage across windows', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  function fakeStore(name, version = 3) {
    return { persist: { getOptions: () => ({ name, version }) }, setState: vi.fn() };
  }

  it('applies another writer\'s change to a registered store: only the fields that changed', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ a: 1, b: { x: 1 } }) } });
    const { safeStorage, registerPersistedStore } = await load();
    const store = fakeStore(SETTINGS);
    registerPersistedStore(store);
    await safeStorage.getItem(SETTINGS);
    h.externalWrite(SETTINGS, blob({ a: 1, b: { x: 2 } }));
    await vi.waitFor(() => expect(store.setState).toHaveBeenCalledWith({ b: { x: 2 } }));
    expect(JSON.parse(await safeStorage.getItem(SETTINGS)).state.b).toEqual({ x: 2 });
  });

  it('ignores the echo of its own write and never overwrites a change it has not sent yet', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ a: 1 }) } });
    const { safeStorage, flushSafeStorage, registerPersistedStore } = await load();
    const store = fakeStore(SETTINGS);
    registerPersistedStore(store);
    await safeStorage.getItem(SETTINGS);
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ a: 2 })));
    await flushSafeStorage();
    h.emit('settings-changed', { keys: [SETTINGS], version: h.version });
    // A pending local change wins over an incoming one for the same key.
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ a: 3 })));
    h.externalWrite(SETTINGS, blob({ a: 9 }));
    await settled(); await settled();
    expect(store.setState).not.toHaveBeenCalled();
    expect(JSON.parse(await safeStorage.getItem(SETTINGS)).state.a).toBe(3);
  });

  it('skips a change written by another store version (it needs that version\'s migration)', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ a: 1 }) } });
    const { safeStorage, registerPersistedStore } = await load();
    const store = fakeStore(SETTINGS, 4);
    registerPersistedStore(store);
    await safeStorage.getItem(SETTINGS);
    h.externalWrite(SETTINGS, blob({ a: 2 }, 3));
    await settled(); await settled();
    expect(store.setState).not.toHaveBeenCalled();
  });

  it.each(['original', 'export', 'compose', 'settings'])('a %s window hydrates through the daemon and never writes', async (kind) => {
    const h = host({ search: `?${kind}=1`, disk: { [SETTINGS]: blob({ language: 'pt-BR' }) } });
    const { safeStorage, flushSafeStorage } = await load();
    expect(JSON.parse(await safeStorage.getItem(SETTINGS)).state.language).toBe('pt-BR');
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ language: 'en' })));
    await flushSafeStorage();
    expect(h.calls).not.toContain('daemon_rpc:settings.replace');
    expect(h.calls).not.toContain('write_settings_json');
    expect(h.disk[SETTINGS]).toEqual(blob({ language: 'pt-BR' }));
  });

  it('a settings or compose window takes a change into its cache but leaves its stores to the owner relay', async () => {
    for (const kind of ['settings', 'compose']) {
      const h = host({ search: `?${kind}=1`, disk: { [THEME]: blob({ theme: 'dark' }, 0) } });
      const { safeStorage, registerPersistedStore } = await load();
      const store = fakeStore(THEME, 0);
      registerPersistedStore(store);
      await safeStorage.getItem(THEME);
      h.externalWrite(THEME, blob({ theme: 'light' }, 0));
      await vi.waitFor(async () => expect(JSON.parse(await safeStorage.getItem(THEME)).state.theme).toBe('light'));
      expect(store.setState).not.toHaveBeenCalled();
    }
  });

  it('an original window applies the change to its stores', async () => {
    const h = host({ search: '?original=1', disk: { [THEME]: blob({ theme: 'dark' }, 0) } });
    const { safeStorage, registerPersistedStore } = await load();
    const store = fakeStore(THEME, 0);
    registerPersistedStore(store);
    await safeStorage.getItem(THEME);
    h.externalWrite(THEME, blob({ theme: 'light' }, 0));
    await vi.waitFor(() => expect(store.setState).toHaveBeenCalledWith({ theme: 'light' }));
  });

  it('catches up after the daemon restarts: refreshes what changed and sends what is queued', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ a: 1 }), [THEME]: blob({ theme: 'dark' }, 0) } });
    const { safeStorage, registerPersistedStore } = await load();
    const theme = fakeStore(THEME, 0);
    registerPersistedStore(theme);
    await safeStorage.getItem(SETTINGS);
    h.daemon = 'down';
    h.failNextReplace = null;
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ a: 2 })));
    // While it was down, the theme changed and the event was lost.
    h.disk[THEME] = blob({ theme: 'light' }, 0);
    h.version += 1;
    h.daemon = 'new';
    h.emit('daemon-reconnected', {});
    await vi.waitFor(() => expect(theme.setState).toHaveBeenCalledWith({ theme: 'light' }));
    await vi.waitFor(() => expect(h.disk[SETTINGS]).toEqual(blob({ a: 2 })));
  });
});

describe('safeStorage never writes before it has seen the document', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  function storeWithDefaults(name, defaults, version = 3) {
    return {
      persist: { getOptions: () => ({ name, version }), rehydrate: vi.fn(async () => {}) },
      getInitialState: () => ({ ...defaults, act: () => {} }),
      setState: vi.fn(),
    };
  }

  it('a cold daemon and a failed shell read: the defaults a store writes never reach the file', async () => {
    const saved = { [SETTINGS]: blob({ a: 5, b: 5, onboardingComplete: true }), [THEME]: blob({ theme: 'dark' }, 0) };
    const h = host({ disk: saved });
    h.get = 'hang';
    h.shellRead = 'reject';
    const { safeStorage, flushSafeStorage } = await load();
    expect(await safeStorage.getItem(SETTINGS)).toBeNull();
    // The daemon is up now, but its read fails; the store writes defaults plus one change.
    h.get = 'errors.settingsWriteFailed';
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ a: 1, b: 9 })));
    await expect(flushSafeStorage()).rejects.toThrow('errors.settingsNotLoaded');
    expect(h.calls).not.toContain('daemon_rpc:settings.replace');
    expect(h.calls).not.toContain('write_settings_json');
    expect(h.disk).toEqual(saved);
  }, 10000);

  it('once the document is read, the queued change lands on top of it, never instead of it', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ a: 5, b: 5, c: 5 }) } });
    h.get = 'hang';
    h.shellRead = 'reject';
    const { safeStorage, flushSafeStorage, registerPersistedStore } = await load();
    const store = storeWithDefaults(SETTINGS, { a: 1, b: 1, c: 1 });
    registerPersistedStore(store);
    expect(await safeStorage.getItem(SETTINGS)).toBeNull();
    // Hydrated from nothing: the store holds its defaults; the user changes b.
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ a: 1, b: 9, c: 1 })));
    h.get = 'ok';
    h.shellRead = 'ok';
    await flushSafeStorage();
    expect(h.disk[SETTINGS]).toEqual(blob({ a: 5, b: 9, c: 5 }));
    // And the store takes the document in, through its own hydration.
    expect(store.persist.rehydrate).toHaveBeenCalled();
    expect(JSON.parse(await safeStorage.getItem(SETTINGS))).toEqual(blob({ a: 5, b: 9, c: 5 }));
  }, 10000);

  it('a queued change it cannot place over the document is dropped, the document kept', async () => {
    const h = host({ disk: { 'mailvault-compose-session': [{ id: 'kept' }] } });
    h.get = 'hang';
    h.shellRead = 'reject';
    const { safeStorage, flushSafeStorage } = await load();
    expect(await safeStorage.getItem('mailvault-compose-session')).toBeNull();
    safeStorage.setItem('mailvault-compose-session', JSON.stringify([]));
    h.get = 'ok';
    await flushSafeStorage();
    expect(h.disk['mailvault-compose-session']).toEqual([{ id: 'kept' }]);
  }, 10000);
});

describe('a transient first-read error does not pin the window to the shell', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('hydrates through the shell, then writes and follows through the daemon', async () => {
    const h = host({ disk: { [SETTINGS]: blob({ a: 1 }), [THEME]: blob({ theme: 'dark' }, 0) } });
    h.get = 'errors.settingsWriteFailed';
    const { safeStorage, flushSafeStorage, registerPersistedStore } = await load();
    const theme = { persist: { getOptions: () => ({ name: THEME, version: 0 }) }, setState: vi.fn() };
    registerPersistedStore(theme);
    expect(JSON.parse(await safeStorage.getItem(SETTINGS)).state.a).toBe(1);
    h.get = 'ok';
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ a: 2 })));
    await flushSafeStorage();
    expect(h.calls).toContain('daemon_rpc:settings.replace');
    expect(h.calls).not.toContain('write_settings_json');
    h.externalWrite(THEME, blob({ theme: 'light' }, 0));
    await vi.waitFor(() => expect(theme.setState).toHaveBeenCalledWith({ theme: 'light' }));
  });
});

describe('a window that cannot write still follows changes', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('an original window that set state itself (onRehydrateStorage) still takes later changes in', async () => {
    const h = host({ search: '?original=1', disk: { [SETTINGS]: blob({ a: 1, cacheLimitMB: 512 }) } });
    const { safeStorage, registerPersistedStore } = await load();
    const store = { persist: { getOptions: () => ({ name: SETTINGS, version: 3 }) }, setState: vi.fn() };
    registerPersistedStore(store);
    await safeStorage.getItem(SETTINGS);
    // What settingsStore's onRehydrateStorage does: a setState, so persist writes.
    safeStorage.setItem(SETTINGS, JSON.stringify(blob({ a: 1, cacheLimitMB: 128 })));
    h.externalWrite(SETTINGS, blob({ a: 2, cacheLimitMB: 128 }));
    await vi.waitFor(() => expect(store.setState).toHaveBeenCalledWith({ a: 2 }));
  });
});
