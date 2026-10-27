// @vitest-environment node
// db/accounts.js and db/keychain.js through the daemon (Phase 1 step 0b):
// accounts.json and the credentials blob are native-owned. Renderer writes
// are limited to one daemon-only cleanup of malformed legacy entries.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeAccountsDaemon } from './fakeAccountsDaemon.js';

const h = vi.hoisted(() => ({ handler: async (cmd) => (cmd === 'get_app_data_dir' ? '/data' : {}), listeners: new Map() }));
vi.mock('../../transport.js', () => ({ send: vi.fn((cmd, args) => h.handler(cmd, args || {})) }));
vi.mock('../../graphConfig.js', () => ({ isPersonalMicrosoftEmail: (email) => /@outlook\.test$/.test(email || '') }));
vi.mock('../../../i18n/index.js', () => ({ t: (k) => k }));
const fsWrites = [];
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  readTextFile: vi.fn(async () => { throw new Error('the app must not read accounts.json itself'); }),
  writeTextFile: vi.fn(async (...a) => { fsWrites.push(a); }),
}));

globalThis.window = { __TAURI__: { event: { listen: (name, cb) => { h.listeners.set(name, cb); return Promise.resolve(() => {}); } } } };

vi.mock('../../db', async () => await import('../accounts.js'));
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => ({ accounts: h.mailAccounts }), setState: (fn) => { h.mailAccounts = fn({ accounts: h.mailAccounts }).accounts; } } }));
const accounts = await import('../accounts.js');
const keychain = await import('../keychain.js');
const keychainSession = await import('../../keychainSession.js');

const coded = (code, message = code) => Object.assign(new Error(message), { code });
const OUTDATED = () => coded('DAEMON_OUTDATED', 'errors.daemonOutdated');
const UNAVAILABLE = () => coded('DAEMON_UNAVAILABLE', 'errors.daemonUnavailable');

let file;
let blob;
let calls;
let daemon;
let credVersion;

// A daemon that knows accounts.* and credentials.*; `override(cmd, args)`
// may answer first (return undefined to let the daemon answer).
function useDaemon(override = () => undefined) {
  h.handler = async (cmd, args) => {
    calls.push([cmd, args]);
    const forced = override(cmd, args);
    if (forced !== undefined) return forced();
    if (cmd === 'get_app_data_dir') return '/data';
    if (cmd.startsWith('accounts.')) {
      return daemon.call(cmd, args);
    }
    if (cmd === 'accounts_fallback') return daemon.call(args.method, args.params);
    if (cmd === 'credentials.get') return Object.keys(blob).length ? { status: 'granted', credentials: { ...blob } } : { status: 'empty', credentials: {} };
    if (cmd === 'credentials.save') { Object.assign(blob, args.records); return { saved: Object.keys(args.records), version: ++credVersion }; }
    if (cmd === 'credentials.update') {
      if (!blob[args.id]) return { updated: false, version: credVersion };
      blob[args.id] = JSON.stringify({ ...JSON.parse(blob[args.id]), ...args.fields });
      return { updated: true, version: ++credVersion };
    }
    if (cmd === 'credentials.delete') { args.ids.forEach(id => delete blob[id]); return { deleted: args.ids, version: ++credVersion }; }
    if (cmd === 'get_credentials') return Object.keys(blob).length ? { status: 'granted', credentials: { ...blob } } : { status: 'empty', credentials: {} };
    if (cmd === 'store_credentials') throw new Error('retired shell writer reached');
    return {};
  };
}

const sent = (name) => calls.filter(([cmd]) => cmd === name);
const names = () => calls.map(([cmd]) => cmd);

beforeEach(() => {
  file = JSON.stringify([{ id: 'old', email: 'old@x.test', imapHost: 'imap.x.test' }], null, 2);
  blob = { old: JSON.stringify({ id: 'old', email: 'old@x.test', imapHost: 'imap.x.test', password: 'keep' }) };
  calls = [];
  credVersion = 10;
  h.mailAccounts = [];
  fsWrites.length = 0;
  h.listeners.clear();
  daemon = fakeAccountsDaemon({ read: () => file, write: (text) => { file = text; }, credentials: { read: () => ({ ...blob }), write: next => { blob = next; credVersion += 1; }, version: () => credVersion } });
  accounts.__resetAccountsForTests();
  keychain.__resetKeychainForTests();
  useDaemon();
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the account list goes through the daemon', () => {
  it('strict create sends one native save and writes no file itself', async () => {
    await accounts.saveAccount({ id: 'a', email: 'a@x.test', imapHost: 'imap.x.test', password: 'pa' });
    expect(sent('accounts.save')).toHaveLength(1);
    expect(sent('credentials.save')).toHaveLength(0);
    expect(JSON.parse(blob.old).password).toBe('keep');
    expect(sent('accounts.put')).toHaveLength(0);
    expect(file).not.toMatch(/password|oauth2AccessToken|oauth2RefreshToken/);
    expect(JSON.parse(file).map(a => a.id)).toEqual(['old', 'a']);
    expect(names()).not.toContain('store_credentials');
    expect(names()).not.toContain('accounts_fallback');
    expect(fsWrites).toEqual([]);
  });

  it('never creates or rewrites accounts.json at startup, even when the list cannot be read', async () => {
    useDaemon((cmd) => (cmd === 'accounts.list' ? () => Promise.reject(UNAVAILABLE()) : cmd === 'accounts_fallback' ? () => Promise.reject('errors.accountsWriteFailed') : undefined));
    await accounts.initBasic();
    expect(await accounts.getAccountsWithoutPasswords()).toEqual([]);
    await accounts.getAccounts();
    const writes = names().filter(n => /accounts\.(put|remove|replace_all|reorder)|store_credentials|credentials\.(save|delete|update)/.test(n));
    expect(writes).toEqual([]);
    expect(fsWrites).toEqual([]);
  });

  it('clear-all listing fails closed instead of using the benign reader fallback', async () => {
    useDaemon(cmd => cmd === 'accounts.list' ? () => Promise.reject(UNAVAILABLE()) : undefined);
    await expect(accounts.listAccountsForRemoval()).rejects.toThrow('errors.accountsWriteFailed');
    expect(sent('accounts_fallback')).toHaveLength(0);
    expect(names().filter(name => name === 'accounts.remove_local')).toEqual([]);
  });

  it('clear-all listing rejects malformed IDs but preserves every authoritative distinct ID', async () => {
    file = JSON.stringify([{ id: 'x1', email: 'same@x.test', imapHost: 'h' },
      { id: 'x2', email: 'same@x.test', imapHost: 'h' }]);
    expect((await accounts.listAccountsForRemoval()).map(account => account.id)).toEqual(['x1', 'x2']);
    file = JSON.stringify([{ id: 'x1' }, { id: 'x1' }]);
    await expect(accounts.listAccountsForRemoval()).rejects.toThrow('errors.accountsWriteFailed');
    file = '[]';
    expect(await accounts.listAccountsForRemoval()).toEqual([]);
  });

  it('clear-all listing rejects an unknown response instead of retrying through a benign shell read', async () => {
    useDaemon(cmd => cmd === 'accounts.list' ? () => ({ version: 1, status: 'unknown' }) : undefined);
    await expect(accounts.listAccountsForRemoval()).rejects.toThrow('errors.accountsWriteFailed');
    expect(sent('accounts_fallback')).toHaveLength(0);
  });

  it('an unreachable daemon sends that one call through the shell, and the next one tries the daemon again', async () => {
    let down = true;
    useDaemon((cmd) => (down && cmd.startsWith('accounts.') ? () => Promise.reject(UNAVAILABLE()) : undefined));
    expect((await accounts.getAccountsWithoutPasswords()).map(a => a.id)).toEqual(['old']);
    expect(sent('accounts_fallback').map(([, a]) => a.method)).toEqual(['accounts.list']);
    down = false;
    await accounts.getAccountsWithoutPasswords();
    expect(sent('accounts.list')).toHaveLength(2);
    expect(sent('accounts_fallback')).toHaveLength(1);
  });

  it('old daemon account reads remain available but mutations refuse without fallback', async () => {
    useDaemon((cmd) => (cmd.startsWith('accounts.') ? () => Promise.reject(OUTDATED()) : undefined));
    await accounts.getAccountsWithoutPasswords();
    await expect(accounts.ensureAccountsInFile([{ id: 'b', email: 'b@x.test' }])).rejects.toThrow('errors.daemonOutdated');
    expect(sent('accounts.list')).toHaveLength(1);
    expect(sent('accounts.put')).toHaveLength(1);
    expect(sent('accounts_fallback').map(([, a]) => a.method)).toEqual(['accounts.list']);
    expect(JSON.parse(file).map(a => a.id)).toEqual(['old']);
  });

  it('a first read that takes too long is read through the shell instead', async () => {
    vi.useFakeTimers();
    useDaemon((cmd) => (cmd === 'accounts.list' ? () => new Promise(() => {}) : undefined));
    const listed = accounts.getAccountsWithoutPasswords();
    await vi.advanceTimersByTimeAsync(1600);
    expect((await listed).map(a => a.id)).toEqual(['old']);
    expect(sent('accounts_fallback')).toHaveLength(1);
  });

  it('an error the daemon answered is not retried through the shell', async () => {
    useDaemon((cmd) => (cmd === 'accounts.put' ? () => Promise.reject(coded('RPC_ERROR', 'errors.accountsWriteFailed')) : undefined));
    await expect(accounts.ensureAccountsInFile([{ id: 'b', email: 'b@x.test' }])).rejects.toThrow('errors.accountsWriteFailed');
    expect(sent('accounts_fallback')).toHaveLength(0);
  });

  it('ensureAccountsInFile is one add-if-absent change without secrets', async () => {
    await accounts.ensureAccountsInFile([
      { id: 'old', email: 'old@x.test', imapHost: 'imap.x.test', password: 'p' },
      { id: 'dup', email: 'OLD@x.test', imapHost: 'IMAP.x.test' },
      { id: 'b', email: 'b@x.test', oauth2RefreshToken: 'rt' },
    ]);
    const [[, args]] = sent('accounts.put');
    expect(args.ifAbsent).toBe(true);
    expect(JSON.stringify(args)).not.toMatch(/"p"|rt|password|oauth2RefreshToken/);
    expect(JSON.parse(file).map(a => a.id)).toEqual(['old', 'b']);
  });

  it('deduplicates the visible list without persistently retiring a duplicate ID', async () => {
    file = JSON.stringify([{ id: 'x1', email: 'x@x.test', imapHost: 'h' }, { id: 'x2', email: 'x@x.test', imapHost: 'h' }]);
    blob = {};
    expect((await accounts.getAccounts()).map(account => account.id)).toEqual(['x1']);
    expect(sent('accounts.replace_all')).toHaveLength(0);
    expect(JSON.parse(file).map(a => a.id)).toEqual(['x1', 'x2']);
  });

  it('deleteAccount uses the one native removal result for the exact ID', async () => {
    blob.a = JSON.stringify({ id: 'a', email: 'a@x.test', password: 'pa' });
    expect(await accounts.deleteAccount('old')).toEqual({ outcome: 'complete', accountId: 'old' });
    expect(sent('accounts.remove_local')[0][1]).toEqual({ accountId: 'old' });
    expect(sent('credentials.delete')).toHaveLength(0);
    expect(sent('accounts.remove')).toHaveLength(0);
    expect(Object.keys(blob)).toEqual(['a']);
    expect(JSON.parse(file)).toEqual([]);
  });

  it('a transport repair saves the repaired records only, never a whole blob', async () => {
    blob.ms = JSON.stringify({ id: 'ms', email: 'me@outlook.test', authType: 'oauth2', oauth2Transport: 'imap', oauth2RefreshToken: 'rt' });
    file = JSON.stringify([{ id: 'fileonly', email: 'f@outlook.test', authType: 'oauth2', oauth2Transport: 'imap' }]);
    await accounts.getAccounts();
    expect(names()).not.toContain('store_credentials');
    expect(sent('credentials.save')).toHaveLength(0);
    expect(sent('accounts.save').every(([,a])=>Object.keys(a.patch.fields).join(',')==='oauth2Transport'&&a.patch.expected.credentialPresent)).toBe(true);
    expect(JSON.parse(blob.ms).oauth2Transport).toBe('graph');
    expect(JSON.parse(blob.old).password).toBe('keep');
  });
});

describe('the remaining renderer credential adapter', () => {
  it('reads the blob with the daemon and keeps the status the shell answered', async () => {
    const data = await keychain.loadKeychain();
    expect(Object.keys(data)).toEqual(['old']);
    expect(keychainSession.getStatus()).toBe('granted');
    expect(names()).not.toContain('get_credentials');
  });

  it('initDB removes malformed legacy entries through one native delete', async () => {
    blob.legacy = JSON.stringify({ id: 'legacy', password: 'synthetic-old' });
    await accounts.initDB();
    expect(sent('credentials.delete')).toEqual([['credentials.delete', { ids: ['legacy'] }]]);
    expect(Object.keys(blob)).toEqual(['old']);
    expect(names()).not.toContain('store_credentials');
  });

  it('a lost native cleanup reply changes neither cache nor shell storage', async () => {
    const cache = await keychain.loadKeychain();
    useDaemon(cmd => cmd === 'credentials.delete' ? () => Promise.reject(UNAVAILABLE()) : undefined);
    await expect(keychain.deleteCredentials(['old'])).rejects.toThrow('E_KEYCHAIN_WRITE');
    expect(cache.old).toBeDefined();
    expect(blob.old).toBeDefined();
    expect(sent('credentials.delete')).toHaveLength(1);
    expect(names()).not.toContain('store_credentials');
  });

  it('METHOD_NOT_FOUND keeps quiet reads but refuses cleanup with zero fallback writes', async () => {
    useDaemon(cmd => cmd.startsWith('credentials.') ? () => Promise.reject(OUTDATED()) : undefined);
    expect(Object.keys(await keychain.loadKeychain())).toEqual(['old']);
    await expect(keychain.deleteCredentials(['old'])).rejects.toThrow('errors.daemonOutdated');
    expect(sent('get_credentials')).toHaveLength(1);
    expect(sent('credentials.delete')).toHaveLength(1);
    expect(names()).not.toContain('store_credentials');
    expect(Object.keys(blob)).toEqual(['old']);
  });

  it('a quiet shell read does not authorize a refused native cleanup', async () => {
    useDaemon(cmd => cmd === 'credentials.get' ? () => ({ status: 'unavailable' })
      : cmd === 'credentials.delete' ? () => Promise.reject(coded('RPC_ERROR', 'errors.keychainUnavailable')) : undefined);
    expect(Object.keys(await keychain.loadKeychain())).toEqual(['old']);
    await expect(keychain.deleteCredentials(['old'])).rejects.toThrow('E_KEYCHAIN_UNAVAILABLE');
    expect(sent('get_credentials')).toHaveLength(1);
    expect(names()).not.toContain('store_credentials');
    expect(blob.old).toBeDefined();
  });
});

describe('other windows', () => {
  it('native events refresh the complete copy without assuming per-record freshness', async () => {
    await keychain.loadKeychain();
    blob.a = '{"id":"a","email":"a@x.test"}';
    const reads = sent('credentials.get').length;
    h.listeners.get('credentials-changed')({ payload: { ids: ['a'], version: credVersion } });
    await vi.waitFor(() => expect(sent('credentials.get').length).toBeGreaterThan(reads));
    const afterOwn = sent('credentials.get').length;

    blob.w2 = '{"id":"w2","email":"w2@x.test","password":"p"}';
    credVersion += 1;
    h.listeners.get('credentials-changed')({ payload: { ids: ['w2'], version: credVersion } });
    await vi.waitFor(() => expect(sent('credentials.get').length).toBeGreaterThan(afterOwn));
    await vi.waitFor(async () => expect(Object.keys(await keychain.loadKeychain()).sort()).toEqual(['a', 'old', 'w2']));
  });

  it('a refresh read overtaken by native cleanup does not restore a deleted record', async () => {
    await keychain.loadKeychain();
    let release;
    let first = true;
    useDaemon((cmd) => (cmd === 'credentials.get' && first ? () => { first = false; const snapshot = { status: 'granted', credentials: { ...blob } }; return new Promise(r => { release = () => r(snapshot); }); } : undefined));
    h.listeners.get('credentials-changed')({ payload: { ids: ['x'], version: 99 } });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await keychain.deleteCredentials(['old']);
    release();
    await vi.waitFor(() => expect(sent('credentials.get').length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(async () => expect((await keychain.loadKeychain()).old).toBeUndefined());
  });
});


const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const attempt = p => p.then(value => ({ value }), error => ({ error }));
const noShellMutation = () => {
  expect(sent('store_credentials')).toHaveLength(0);
  expect(sent('accounts_fallback').filter(([, a]) => !['accounts.list', 'accounts.get'].includes(a.method))).toHaveLength(0);
};

describe('native mutation outcomes', () => {
  it('a lost accepted cleanup reply cannot switch writers or commit cache', async () => {
    const cache = await keychain.loadKeychain();
    const before = { ...cache };
    const wire = deferred();
    useDaemon(cmd => cmd === 'credentials.delete' ? () => wire.promise : undefined);
    const result = attempt(keychain.deleteCredentials(['old']));
    await vi.waitFor(() => expect(sent('credentials.delete')).toHaveLength(1));
    wire.reject(UNAVAILABLE());
    expect((await result).error).toBeInstanceOf(Error);
    expect(cache).toEqual(before);
    expect(keychainSession.getStatus()).toBe('granted');
    noShellMutation();
  });

  it('bare version is not a cleanup acknowledgement', async () => {
    const cache = await keychain.loadKeychain();
    useDaemon(cmd => cmd === 'credentials.delete' ? () => ({ version: 40 }) : undefined);
    expect((await attempt(keychain.deleteCredentials(['old']))).error).toBeInstanceOf(Error);
    expect(cache.old).toBeDefined();
    noShellMutation();
  });

  for (const malformed of [false, true]) {
    it(`metadata save rejects ${malformed ? 'malformed' : 'lost'} completion after credential success`, async () => {
      useDaemon((cmd, args) => cmd === 'accounts.save' ? () => {
        blob.a = JSON.stringify(args.entries[0]);
        return malformed ? { version: 4 } : Promise.reject(UNAVAILABLE());
      } : undefined);
      const out = await attempt(accounts.saveAccounts([{ id: 'a', email: 'a@x.test', password: 'synthetic-a' }]));
      expect(out.error?.message).toMatch(/^E_KEYCHAIN_WRITE/);
      expect(() => keychain.assertAccountCreateOutcomeKnown()).toThrow('errors.accountsWriteFailed');
      expect(JSON.parse(blob.a).password).toBe('synthetic-a');
      expect(JSON.parse(file).map(a => a.id)).toEqual(['old']);
      noShellMutation();
    });
  }

  it('a quiet fallback read remains presentation data, never cleanup write authority', async () => {
    useDaemon(cmd => cmd === 'credentials.get' ? () => Promise.reject(UNAVAILABLE())
      : cmd === 'credentials.delete' ? () => Promise.reject(UNAVAILABLE()) : undefined);
    expect(Object.keys(await keychain.loadKeychain())).toEqual(['old']);
    expect(keychainSession.getStatus()).toBe('granted');
    expect((await attempt(keychain.deleteCredentials(['old']))).error).toBeInstanceOf(Error);
    expect(blob.old).toBeDefined();
    noShellMutation();
  });

  it('definite old-daemon refusal preserves native data and a later compatible delete succeeds', async () => {
    useDaemon(cmd => cmd.startsWith('credentials.') ? () => Promise.reject(OUTDATED()) : undefined);
    await keychain.loadKeychain();
    blob.other = '{"id":"other","email":"other@x.test"}';
    await expect(keychain.deleteCredentials(['old'])).rejects.toThrow('errors.daemonOutdated');
    expect(Object.keys(blob).sort()).toEqual(['old', 'other']);
    noShellMutation();
    useDaemon();
    await keychain.deleteCredentials(['old']);
    expect(Object.keys(blob)).toEqual(['other']);
  });

  it('read message and mutation error canaries never reach logs or session text', async () => {
    const spies = ['log', 'warn', 'error'].map(k => vi.spyOn(console, k).mockImplementation(() => {}));
    useDaemon(cmd => cmd === 'credentials.get' || cmd === 'get_credentials'
      ? () => ({ status: 'unavailable', message: 'CANARY-password-token' }) : undefined);
    await keychain.loadKeychain();
    expect(keychainSession.getStatus()).toBe('unavailable');
    expect(keychainSession.getMessage() || '').not.toContain('CANARY');
    useDaemon(cmd => cmd === 'accounts.save' ? () => Promise.reject(new Error('CANARY-password-token')) : undefined);
    const out = await attempt(accounts.saveAccount({ id: 'a', email: 'a@x.test', password: 'CANARY-password-token' }));
    expect(out.error).toBeInstanceOf(Error);
    expect(JSON.stringify(spies.flatMap(spy => spy.mock.calls))).not.toContain('CANARY');
  });
});

describe('qualified U connection epochs', () => {
  it('a native cleanup overtaking the first load obtains a fresh usable cache', async () => {
    const old = deferred();
    const stale = blob.old;
    let first = true;
    useDaemon(cmd => cmd === 'credentials.get' && first ? () => { first = false; return old.promise; } : undefined);
    const loading = keychain.loadKeychain();
    await vi.waitFor(() => expect(first).toBe(false));
    await keychain.deleteCredentials(['old']);
    old.resolve({ status: 'granted', credentials: { old: stale } });
    expect(Object.keys(await loading)).toEqual([]);
    expect(Object.keys(await keychain.loadKeychain())).toEqual([]);
    expect(keychainSession.getStatus()).toBe('empty');
  });
  it('restart after generation100 accepts new generation1/2 and another window deletion', async () => {
    await keychain.loadKeychain();
    credVersion = 100;
    blob.mine = '{"id":"mine"}';
    h.listeners.get('credentials-changed')({ payload: { ids: ['mine'], version: 100 } });
    await vi.waitFor(async () => expect((await keychain.loadKeychain()).mine).toBeDefined());
    h.listeners.get('daemon-reconnected')();
    await vi.waitFor(() => expect(sent('credentials.get').length).toBeGreaterThan(1));
    delete blob.old;
    blob.fresh = '{"id":"fresh"}';
    h.listeners.get('credentials-changed')({ payload: { ids: ['old', 'fresh'], version: 1 } });
    await vi.waitFor(async () => expect((await keychain.loadKeychain()).fresh).toBeDefined());
    expect((await keychain.loadKeychain()).old).toBeUndefined();
    blob.next = '{"id":"next"}';
    h.listeners.get('credentials-changed')({ payload: { ids: ['next'], version: 2 } });
    await vi.waitFor(async () => expect((await keychain.loadKeychain()).next).toBeDefined());
  });
  it('an old connection read cannot overwrite a completed new connection read', async () => {
    await keychain.loadKeychain();
    const old = deferred();
    let first = true;
    useDaemon(cmd => cmd === 'credentials.get' && first ? () => { first = false; return old.promise; } : undefined);
    h.listeners.get('credentials-changed')({ payload: { version: 100 } });
    await vi.waitFor(() => expect(first).toBe(false));
    blob.new = '{"id":"new"}';
    h.listeners.get('daemon-reconnected')();
    await vi.waitFor(async () => expect((await keychain.loadKeychain()).new).toBeDefined());
    old.resolve({ status: 'granted', credentials: { stale: '{"id":"stale"}' } });
    await Promise.resolve(); await Promise.resolve();
    expect((await keychain.loadKeychain()).stale).toBeUndefined();
    expect((await keychain.loadKeychain()).new).toBeDefined();
  });
});

describe('public credential clear detaches obsolete full refresh work', () => {
  it('an obsolete initial load cannot consume the current refresh reread', async () => {
    const oldLoad = deferred(), currentReply = deferred(), latestReply = deferred();
    const oldEntered = deferred(), currentEntered = deferred(), rereadEntered = deferred();
    const initial = { initial: '{"id":"initial"}', removed: '{"id":"removed"}' };
    let reads = 0;
    useDaemon(cmd => cmd === 'credentials.get' ? () => {
      reads += 1;
      if (reads === 1) { oldEntered.resolve(); return oldLoad.promise; }
      if (reads === 2) return { status: 'granted', credentials: { ...initial } };
      if (reads === 3) { currentEntered.resolve(); return currentReply.promise; }
      if (reads === 4) { rereadEntered.resolve(); return latestReply.promise; }
      throw new Error('unexpected extra credential read');
    } : undefined);
    let joined;
    // Start with the actual cache unloaded: this task suspends in loadKeychain.
    const obsolete = keychain.readCurrentCredentials();
    await oldEntered.promise;
    try {
      keychain.clearCredentialsCache();
      expect(await keychain.loadKeychain()).toEqual(initial);
      h.listeners.get('credentials-changed')({ payload: { ids: ['before-later'], version: 11 } });
      await currentEntered.promise;
      joined = keychain.readCurrentCredentials();
      h.listeners.get('credentials-changed')({ payload: { ids: ['newest', 'removed'], version: 12 } });
      oldLoad.resolve({ status: 'granted', credentials: { obsolete: '{"id":"obsolete"}' } });
      expect(await obsolete).toBeNull();
      expect(reads).toBe(3);
      expect(await keychain.loadKeychain()).toEqual(initial);
      currentReply.resolve({ status: 'granted', credentials: { ...initial, beforeLater: '{"id":"before-later"}' } });
      // The held next read wins this race only when the queued event survived
      // the obsolete continuation; no polling or wall-clock delay is needed.
      const next = await Promise.race([
        rereadEntered.promise.then(() => 'reread'),
        joined.then(() => 'settled without reread'),
      ]);
      expect(next).toBe('reread');
      expect(reads).toBe(4);
      latestReply.resolve({ status: 'granted', credentials: { newest: '{"id":"newest"}' } });
      expect(await joined).toEqual({ newest: '{"id":"newest"}' });
      expect(await keychain.loadKeychain()).toEqual({ newest: '{"id":"newest"}' });
    } finally {
      oldLoad.resolve({ status: 'empty', credentials: {} });
      currentReply.resolve({ status: 'empty', credentials: {} });
      latestReply.resolve({ status: 'empty', credentials: {} });
      await Promise.all([obsolete, joined].filter(Boolean));
    }
  });

  for (const oldFirst of [true, false]) {
    it(`keeps post-clear events and current readers when old work settles ${oldFirst ? 'before' : 'after'} current work`, async () => {
      await keychain.loadKeychain();
      const old = deferred(), current = deferred(), again = deferred();
      const replies = [old, current, again];
      useDaemon(cmd => cmd === 'credentials.get' && replies.length ? () => replies.shift().promise : undefined);
      let joined;
      const oldRead = keychain.readCurrentCredentials();
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      try {
        keychain.clearCredentialsCache();
        // The new initial load is independent of the held full refresh.
        blob = { initial: '{"id":"initial"}', removed: '{"id":"removed"}' };
        let initial = true;
        const heldHandler = h.handler;
        h.handler = async (cmd, args) => {
          if (cmd === 'credentials.get' && initial) { initial = false; calls.push([cmd, args]); return { status: 'granted', credentials: { ...blob } }; }
          return heldHandler(cmd, args);
        };
        expect(Object.keys(await keychain.loadKeychain()).sort()).toEqual(['initial', 'removed']);
        h.listeners.get('credentials-changed')({ payload: { ids: ['latest', 'removed'], version: 11 } });
        await Promise.resolve(); await Promise.resolve();
        expect(replies).toHaveLength(1); // current epoch issued its own read
        joined = keychain.readCurrentCredentials();
        h.listeners.get('credentials-changed')({ payload: { ids: ['newest'], version: 12 } });
        if (oldFirst) {
          old.resolve({ status: 'granted', credentials: { obsolete: '{"id":"obsolete"}' } });
          expect(await oldRead).toBeNull();
          h.listeners.get('credentials-changed')({ payload: { ids: ['after-old'], version: 13 } });
          await Promise.resolve(); await Promise.resolve();
          expect(replies).toHaveLength(1); // old finally did not detach current work
        }
        current.resolve({ status: 'granted', credentials: { latest: '{"id":"latest"}' } });
        await vi.waitFor(() => expect(replies).toHaveLength(0));
        again.resolve({ status: 'granted', credentials: { newest: '{"id":"newest"}' } });
        expect(Object.keys(await joined)).toEqual(['newest']);
        if (!oldFirst) { old.resolve({ status: 'granted', credentials: { obsolete: '{"id":"obsolete"}' } }); expect(await oldRead).toBeNull(); }
        expect(Object.keys(await keychain.loadKeychain())).toEqual(['newest']);
        useDaemon(cmd => cmd === 'credentials.get' ? () => Promise.reject(UNAVAILABLE()) : undefined);
        expect(await keychain.readCurrentCredentials()).toBeNull();
      } finally {
        old.resolve({ status: 'empty', credentials: {} });
        current.resolve({ status: 'empty', credentials: {} });
        again.resolve({ status: 'empty', credentials: {} });
        await Promise.all([oldRead, joined].filter(Boolean));
      }
    });
  }
});

describe('qualified native removal outcomes', () => {
  it('one native result removes the exact account without a renderer persistence chain', async () => {
    file = JSON.stringify([{ id: 'old', email: 'old@x.test', password: 'legacy-A' }, { id: 'b', email: 'b@x.test' }]);
    blob.b = '{"id":"b","email":"b@x.test","password":"keep-B"}';
    await accounts.deleteAccount('old');
    const effects = names().filter(n => ['accounts.remove_local', 'compose.receipts.remove_account', 'accounts.remove', 'credentials.delete'].includes(n));
    expect(effects).toEqual(['accounts.remove_local']);
    expect(blob.old).toBeUndefined();
    expect(JSON.parse(blob.b).password).toBe('keep-B');
    expect(JSON.parse(file).map(a => a.id)).toEqual(['b']);
  });
  it('native refusal leaves unrelated legacy credentials untouched', async () => {
    blob.orphan = '{"id":"orphan","password":"synthetic-orphan"}';
    useDaemon(cmd => cmd === 'accounts.remove_local' ? () => Promise.reject(UNAVAILABLE()) : undefined);
    expect((await attempt(accounts.deleteAccount('old'))).error).toBeInstanceOf(Error);
    expect(names()).toEqual(['accounts.remove_local']);
    expect(blob.orphan).toBeDefined();
  });
  for (const [cause, error] of [
    ['unavailable', () => UNAVAILABLE()],
    ['conflict', () => coded('RPC_ERROR', 'errors.accountsConflict')],
  ]) {
    it(`${cause} native removal starts no renderer credential or local cleanup`, async () => {
      useDaemon(cmd => cmd === 'accounts.remove_local' ? () => Promise.reject(error()) : undefined);
      expect((await attempt(accounts.deleteAccount('old'))).error).toBeInstanceOf(Error);
      expect(blob.old).toBeDefined();
      expect(sent('credentials.delete')).toHaveLength(0);
      expect(sent('clear_email_cache')).toHaveLength(0);
      noShellMutation();
    });
  }
  it('a pending native reply cannot trigger a renderer deletion, and explicit retry may complete', async () => {
    const wire = deferred();
    useDaemon(cmd => cmd === 'accounts.remove_local' ? () => wire.promise : undefined);
    const pending = attempt(accounts.deleteAccount('old'));
    await vi.waitFor(() => expect(sent('accounts.remove_local')).toHaveLength(1));
    expect(JSON.parse(file).map(account => account.id)).toEqual(['old']);
    expect(sent('clear_email_cache')).toHaveLength(0);
    wire.reject(UNAVAILABLE());
    expect((await pending).error).toBeInstanceOf(Error);
    expect(blob.old).toBeDefined();
    expect(sent('clear_email_cache')).toHaveLength(0);
    noShellMutation();
    useDaemon();
    await accounts.deleteAccount('old');
    expect(blob.old).toBeUndefined();
    expect(sent('clear_email_cache')).toHaveLength(0);
  });
});


describe('late backend completion is not cancelled by a read', () => {
  it('a lost metadata reply can complete after a read; only a new named native intent continues', async () => {
    const backend = deferred();
    let parked = true;
    let first = true;
    const late = backend.promise.then(() => { daemon.call('accounts.put', { entries: [{ id: 'a', email: 'a@x.test' }] }); parked = false; });
    useDaemon((cmd, args) => cmd === 'accounts.put' ? () => {
      if (first) { first = false; return Promise.reject(UNAVAILABLE()); }
      if (parked) return Promise.reject(coded('RPC_ERROR', 'errors.accountsWriteFailed'));
      return daemon.call(cmd, args);
    } : undefined);
    expect((await attempt(accounts.ensureAccountsInFile([{ id: 'a', email: 'a@x.test' }]))).error).toBeInstanceOf(Error);
    expect((await accounts.getAccountsWithoutPasswords()).map(a => a.id)).toEqual(['old']);
    expect((await attempt(accounts.ensureAccountsInFile([{ id: 'b', email: 'b@x.test' }]))).error).toBeInstanceOf(Error);
    backend.resolve(); await late;
    await accounts.ensureAccountsInFile([{ id: 'b', email: 'b@x.test' }]);
    expect(JSON.parse(file).map(a => a.id)).toEqual(['old', 'a', 'b']);
    useDaemon(cmd => cmd === 'accounts.put' ? () => Promise.reject(OUTDATED()) : undefined);
    expect((await attempt(accounts.ensureAccountsInFile([{ id: 'c', email: 'c@x.test' }]))).error).toBeInstanceOf(Error);
    noShellMutation();
  });
});


describe('native cleanup and event interleavings', () => {
  it('an old epoch delete reply does not patch the reconnected cache', async () => {
    await keychain.loadKeychain();
    const wire = deferred();
    useDaemon(cmd => cmd === 'credentials.delete' ? () => wire.promise : undefined);
    const pending = attempt(keychain.deleteCredentials(['old']));
    await vi.waitFor(() => expect(sent('credentials.delete')).toHaveLength(1));
    blob.old = '{"id":"old","email":"old@x.test","password":"current"}';
    h.listeners.get('daemon-reconnected')();
    await vi.waitFor(async () => expect(JSON.parse((await keychain.loadKeychain()).old).password).toBe('current'));
    wire.resolve({ deleted: ['old'], version: 100 });
    expect((await pending).error).toBeUndefined();
    expect(JSON.parse((await keychain.loadKeychain()).old).password).toBe('current');
    noShellMutation();
  });

  it('a delayed foreign deletion event is not hidden by a later local cleanup reply', async () => {
    await keychain.loadKeychain();
    delete blob.old;
    blob.foreign = '{"id":"foreign","email":"foreign@x.test"}';
    await keychain.deleteCredentials(['old']);
    h.listeners.get('credentials-changed')({ payload: { version: 10, ids: ['old', 'foreign'] } });
    await vi.waitFor(async () => expect(Object.keys(await keychain.loadKeychain())).toEqual(['foreign']));
    noShellMutation();
  });

  it('an older delete success reply cannot overwrite a newer same-connection read', async () => {
    await keychain.loadKeychain();
    const wire = deferred();
    useDaemon(cmd => cmd === 'credentials.delete' ? () => wire.promise : undefined);
    const pending = attempt(keychain.deleteCredentials(['old']));
    await vi.waitFor(() => expect(sent('credentials.delete')).toHaveLength(1));
    blob.old = '{"id":"old","email":"old@x.test","password":"current"}';
    h.listeners.get('credentials-changed')({ payload: { version: 12, ids: ['old'] } });
    await vi.waitFor(async () => expect(JSON.parse((await keychain.loadKeychain()).old).password).toBe('current'));
    wire.resolve({ deleted: ['old'], version: 11 });
    expect((await pending).error).toBeUndefined();
    expect(JSON.parse((await keychain.loadKeychain()).old).password).toBe('current');
    noShellMutation();
  });
});

// The native owner can rotate a pair after a renderer read but before a
// metadata-only account edit. The adapter must preserve the native pair.
describe('account intent persistence regressions', () => {
  it('a Sent metadata edit preserves a newer native rotated pair', async () => {
    const stale = { id: 'g', email: 'g@x.test', imapHost: 'h', authType: 'oauth2', oauth2Provider: 'google', oauth2AccessToken: 'synthetic-old-at', oauth2RefreshToken: 'synthetic-old-rt', oauth2ExpiresAt: 1 };
    blob.g = JSON.stringify(stale);
    await accounts.getAccount('g');
    await h.handler('credentials.update', { id: 'g', fields: { oauth2AccessToken: 'synthetic-new-at',
      oauth2RefreshToken: 'synthetic-new-rt', oauth2ExpiresAt: 9 } });
    await accounts.patchAccount(stale.id, { sentFolderOverride: 'Sent custom' });
    const saved = JSON.parse(blob.g);
    expect(saved.oauth2AccessToken === 'synthetic-new-at' && saved.oauth2RefreshToken === 'synthetic-new-rt' && saved.oauth2ExpiresAt === 9, 'new native pair must survive stale caller').toBe(true);
    expect(JSON.parse(file).find(a => a.id === 'g').sentFolderOverride).toBe('Sent custom');
  });

  it('Microsoft repair preserves a rotation committed after its cached read', async () => {
    const stale = { id: 'ms', email: 'me@outlook.test', imapHost: 'h', authType: 'oauth2', oauth2Transport: 'imap', oauth2RefreshToken: 'synthetic-old-rt', oauth2AccessToken: 'synthetic-old-at', oauth2ExpiresAt: 1 };
    blob.ms = JSON.stringify(stale);
    await keychain.loadKeychain();
    useDaemon();
    const real = h.handler;
    h.handler = async (cmd, args) => {
      if (cmd === 'accounts.save') {
        blob.ms = JSON.stringify({ ...stale, oauth2RefreshToken: 'synthetic-new-rt', oauth2AccessToken: 'synthetic-new-at', oauth2ExpiresAt: 9 });
        useDaemon();
        return h.handler(cmd, args);
      }
      return real(cmd, args);
    };
    await accounts.getAccounts();
    const saved = JSON.parse(blob.ms);
    expect(saved.oauth2AccessToken === 'synthetic-new-at' && saved.oauth2RefreshToken === 'synthetic-new-rt' && saved.oauth2ExpiresAt === 9, 'new native pair must survive stale caller').toBe(true);
    expect(saved.oauth2Transport).toBe('graph');
  });
});


const fix1Reply=(accepted,skipped={})=>({accounts:accepted.map(id=>({id,email:`${id}@example.test`,imapHost:'h'})),accepted,skipped,version:1,credentialVersion:1,hostChanged:false});
for(const [kind,reply] of [
  ['missing',fix1Reply([])],['overlap',fix1Reply(['a'],{a:'old'})],['unknown accepted',fix1Reply(['alien'])],['unknown skipped',fix1Reply([],{alien:'old'})],
])it(`fix1 import rejects ${kind} completion and retains uncertainty`,async()=>{
  useDaemon(cmd=>cmd==='accounts.save'?()=>reply:undefined);
  await expect(accounts.saveAccounts([{id:'a',email:'a@example.test',imapHost:'h'}])).rejects.toThrow('E_KEYCHAIN_WRITE');
  expect(()=>keychain.assertAccountCreateOutcomeKnown()).toThrow('errors.accountsWriteFailed');
  expect(sent('accounts.save')).toHaveLength(1);expect(names()).not.toContain('accounts_fallback');
});
for(const [kind,entries,reply] of [
  ['empty',[],fix1Reply([])],
  ['accepted',[{id:'a'}],fix1Reply(['a'])],
  ['skipped shared target',[{id:'a'},{id:'b'}],fix1Reply([],{a:'old',b:'old'})],
  ['mixed',[{id:'a'},{id:'b'},{id:'c'}],fix1Reply(['a'],{b:'old',c:'old'})],
])it(`fix1 accepts complete ${kind} request partition`,async()=>{
  useDaemon(cmd=>cmd==='accounts.save'?()=>reply:undefined);expect(await accounts.saveAccounts(entries.map(e=>({...e,email:`${e.id}@example.test`,imapHost:'h'})))).toEqual(reply);
});

for(const [kind,entries] of [['empty id',[{id:''}]],['duplicate ids',[{id:'a'},{id:'a'}]],['non-string id',[{id:9}]],['missing record',[null]]])it(`fix1 refuses ${kind} before import dispatch`,async()=>{
  await expect(accounts.saveAccounts(entries)).rejects.toThrow('errors.accountsInvalid');
  expect(sent('accounts.save')).toHaveLength(0);expect(()=>keychain.assertAccountCreateOutcomeKnown()).not.toThrow();
});
