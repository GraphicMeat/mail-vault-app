// @vitest-environment node
// db/accounts.js and db/keychain.js through the daemon (Phase 1 step 0b):
// accounts.json and the credentials blob are the daemon's; the app sends one
// change per account and never writes either itself. The shell's old path is
// taken only for a daemon without the RPCs (for good) or one that cannot be
// reached (that call only), and nothing is ever written from a read that
// did not succeed.
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
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { setState: (fn) => { h.mailAccounts = fn({ accounts: h.mailAccounts }).accounts; } } }));
const sync = await import('../../oauthTokenSync.js');
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
let preserveLegacy;

// A daemon that knows accounts.* and credentials.*; `override(cmd, args)`
// may answer first (return undefined to let the daemon answer).
function useDaemon(override = () => undefined) {
  h.handler = async (cmd, args) => {
    calls.push([cmd, args]);
    const forced = override(cmd, args);
    if (forced !== undefined) return forced();
    if (cmd === 'get_app_data_dir') return '/data';
    if (cmd.startsWith('accounts.')) {
      if (preserveLegacy && cmd === 'accounts.remove') {
        for (const a of JSON.parse(file)) if (a.password && !blob[a.id]) blob[a.id] = JSON.stringify(a);
      }
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
    if (cmd === 'store_credentials') { blob = { ...args.credentials }; return null; }
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
  preserveLegacy = false;
  sync.__resetForTests();
  h.mailAccounts = [];
  fsWrites.length = 0;
  h.listeners.clear();
  daemon = fakeAccountsDaemon({ read: () => file, write: (text) => { file = text; } });
  accounts.__resetAccountsForTests();
  keychain.__resetKeychainForTests();
  useDaemon();
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the account list goes through the daemon', () => {
  it('saveAccount sends one credentials record and one secret-free put, and writes no file itself', async () => {
    await accounts.saveAccount({ id: 'a', email: 'a@x.test', imapHost: 'imap.x.test', password: 'pa' });
    expect(sent('credentials.save').map(([, a]) => Object.keys(a.records))).toEqual([['a']]);
    expect(JSON.parse(blob.old).password).toBe('keep');
    expect(sent('accounts.put')).toHaveLength(1);
    expect(JSON.stringify(sent('accounts.put')[0][1])).not.toMatch(/password|oauth2AccessToken|oauth2RefreshToken/);
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

  it('a daemon without accounts.* sends every later call to the shell', async () => {
    useDaemon((cmd) => (cmd.startsWith('accounts.') ? () => Promise.reject(OUTDATED()) : undefined));
    await accounts.getAccountsWithoutPasswords();
    await accounts.ensureAccountsInFile([{ id: 'b', email: 'b@x.test' }]);
    expect(sent('accounts.list')).toHaveLength(1);
    expect(sent('accounts.put')).toHaveLength(0);
    expect(sent('accounts_fallback').map(([, a]) => a.method)).toEqual(['accounts.list', 'accounts.put']);
    expect(JSON.parse(file).map(a => a.id)).toEqual(['old', 'b']);
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

  it('the duplicate cleanup replaces the list only at the version it was read at', async () => {
    file = JSON.stringify([{ id: 'x1', email: 'x@x.test', imapHost: 'h' }, { id: 'x2', email: 'x@x.test', imapHost: 'h' }]);
    blob = {};
    await accounts.getAccounts();
    const [[, args]] = sent('accounts.replace_all');
    expect(args.baseVersion).toBe(1);
    expect(JSON.parse(file).map(a => a.id)).toEqual(['x1']);
  });

  it('deleteAccount removes the record and the entry by id', async () => {
    blob.a = JSON.stringify({ id: 'a', email: 'a@x.test', password: 'pa' });
    await accounts.deleteAccount('old');
    expect(sent('credentials.delete')[0][1]).toEqual({ ids: ['old'] });
    expect(sent('accounts.remove')[0][1]).toEqual({ ids: ['old'] });
    expect(Object.keys(blob)).toEqual(['a']);
    expect(JSON.parse(file)).toEqual([]);
  });

  it('a transport repair saves the repaired records only, never a whole blob', async () => {
    blob.ms = JSON.stringify({ id: 'ms', email: 'me@outlook.test', authType: 'oauth2', oauth2Transport: 'imap', oauth2RefreshToken: 'rt' });
    file = JSON.stringify([{ id: 'fileonly', email: 'f@outlook.test', authType: 'oauth2', oauth2Transport: 'imap' }]);
    await accounts.getAccounts();
    expect(names()).not.toContain('store_credentials');
    expect(sent('credentials.save').map(([, a]) => Object.keys(a.records))).toEqual([['ms']]);
    expect(JSON.parse(blob.ms).oauth2Transport).toBe('graph');
    expect(JSON.parse(blob.old).password).toBe('keep');
  });
});

describe('the credentials go through the daemon', () => {
  it('reads the blob with the daemon and keeps the status the shell answered', async () => {
    const data = await keychain.loadKeychain();
    expect(Object.keys(data)).toEqual(['old']);
    expect(keychainSession.getStatus()).toBe('granted');
    expect(names()).not.toContain('get_credentials');
  });

  it('updateOAuth2Tokens merges only the token fields', async () => {
    blob.g = JSON.stringify({ id: 'g', email: 'g@x.test', authType: 'oauth2', oauth2RefreshToken: 'rt-1', oauth2ClientId: 'c' });
    const stored = await accounts.updateOAuth2Tokens('g', { accessToken: 'at-2', expiresAt: 5 });
    // No refresh token in the pair: the stored one is left alone, never
    // rewritten from this window's (possibly older) copy.
    expect(sent('credentials.update')[0][1]).toEqual({ id: 'g', fields: { oauth2AccessToken: 'at-2', oauth2ExpiresAt: 5 } });
    expect(stored).toMatchObject({ oauth2AccessToken: 'at-2', oauth2RefreshToken: 'rt-1', oauth2ClientId: 'c' });
    await accounts.updateOAuth2Tokens('g', { accessToken: 'at-3', refreshToken: 'rt-2', expiresAt: 6 });
    expect(sent('credentials.update')[1][1].fields.oauth2RefreshToken).toBe('rt-2');
    expect(await accounts.updateOAuth2Tokens('missing', { accessToken: 'x' })).toBeUndefined();
  });

  // Another window saved a Reconnect (a new grant) after this window cached
  // the old one: the daemon refuses the old grant's pair, and nothing here
  // treats it as saved or touches the copy.
  it('a pair for a grant the daemon no longer holds is not saved, and its chain goes with it', async () => {
    blob.g = JSON.stringify({ id: 'g', email: 'g@x.test', authType: 'oauth2', oauth2RefreshToken: 'rt-old' });
    await keychain.loadKeychain();
    useDaemon((cmd) => (cmd === 'credentials.update' ? () => ({ updated: false, staleGrant: true, version: credVersion }) : undefined));
    const stored = await accounts.updateOAuth2Tokens('g', { accessToken: 'at-old-grant', refreshToken: 'rt-old', expiresAt: 5, chain: ['fp-old'] });
    expect(stored).toBeUndefined();
    expect(sent('credentials.update')[0][1].chain).toEqual(['fp-old']);
    expect(JSON.parse((await keychain.loadKeychain()).g).oauth2AccessToken).toBeUndefined();
    expect(names()).not.toContain('store_credentials');
  });

  it('a parked daemon write answers busy: retried, then refused, never written by the shell', async () => {
    vi.useFakeTimers();
    useDaemon((cmd) => (cmd === 'credentials.save' ? () => Promise.reject(coded('RPC_ERROR', 'errors.keychainBusy')) : undefined));
    await keychain.loadKeychain();
    const saving = keychain.saveCredentials({ a: '{"id":"a"}' }).catch(e => e);
    await vi.advanceTimersByTimeAsync(3500);
    expect(String((await saving).message)).toBe('E_KEYCHAIN_WRITE: errors.keychainBusy');
    expect(sent('credentials.save')).toHaveLength(3);
    expect(names()).not.toContain('store_credentials');
  });

  it('a refused read writes nothing: E_KEYCHAIN_UNAVAILABLE, no shell write', async () => {
    useDaemon((cmd) => (cmd === 'credentials.save' ? () => Promise.reject(coded('RPC_ERROR', 'errors.keychainUnavailable')) : undefined));
    await expect(accounts.saveAccount({ id: 'a', email: 'a@x.test', password: 'pa' })).rejects.toThrow('E_KEYCHAIN_UNAVAILABLE');
    expect(names()).not.toContain('store_credentials');
    expect(sent('accounts.put')).toHaveLength(0);
  });

  it('retries a failed keychain write, then writes the whole blob from the shell only from a complete copy', async () => {
    vi.useFakeTimers();
    useDaemon((cmd) => (cmd === 'credentials.save' ? () => Promise.reject(coded('RPC_ERROR', 'errors.keychainWriteFailed')) : undefined));
    await keychain.loadKeychain();
    const saving = keychain.saveCredentials({ a: JSON.stringify({ id: 'a', email: 'a@x.test' }) });
    await vi.advanceTimersByTimeAsync(3500);
    await saving;
    expect(sent('credentials.save')).toHaveLength(3);
    expect(sent('store_credentials')).toHaveLength(1);
    expect(Object.keys(sent('store_credentials')[0][1].credentials).sort()).toEqual(['a', 'old']);
  });

  it('a failed keychain write without a complete copy is an error, never a partial whole-blob write', async () => {
    vi.useFakeTimers();
    useDaemon((cmd) => (cmd === 'credentials.save' ? () => Promise.reject(coded('RPC_ERROR', 'errors.keychainWriteFailed'))
      : cmd === 'credentials.get' || cmd === 'get_credentials' ? () => ({ status: 'unavailable', message: 'locked' }) : undefined));
    await keychain.loadKeychain();
    const saving = keychain.saveCredentials({ a: '{"id":"a"}' }).catch(e => e);
    await vi.advanceTimersByTimeAsync(3500);
    expect(String((await saving).message)).toMatch(/^E_KEYCHAIN_WRITE: errors\.keychainWriteFailed/);
    expect(names()).not.toContain('store_credentials');
  });

  // macOS: the daemon's gate is blocked (its prompt was refused) while the
  // app, the item's creator, still reads it quietly. That read is kept, and
  // a change the daemon then refuses is written by the shell from it.
  it('a failed daemon read falls back to the shell\'s quiet read, and its copy may write through the shell', async () => {
    useDaemon((cmd) => (cmd === 'credentials.get' ? () => ({ status: 'unavailable', message: 'The keychain could not be read' })
      : cmd === 'credentials.save' ? () => Promise.reject(coded('RPC_ERROR', 'errors.keychainUnavailable')) : undefined));
    const data = await keychain.loadKeychain();
    expect(Object.keys(data)).toEqual(['old']);
    expect(keychainSession.getStatus()).toBe('granted');
    await keychain.saveCredentials({ a: '{"id":"a","email":"a@x.test"}' });
    expect(sent('credentials.save')).toHaveLength(1);
    expect(Object.keys(sent('store_credentials')[0][1].credentials).sort()).toEqual(['a', 'old']);
  });

  it('a daemon without credentials.* uses the shell commands, as before', async () => {
    useDaemon((cmd) => (cmd.startsWith('credentials.') ? () => Promise.reject(OUTDATED()) : undefined));
    await keychain.loadKeychain();
    await keychain.saveCredentials({ a: JSON.stringify({ id: 'a', email: 'a@x.test' }) });
    expect(sent('get_credentials')).toHaveLength(1);
    expect(Object.keys(sent('store_credentials')[0][1].credentials).sort()).toEqual(['a', 'old']);
    expect(sent('credentials.save')).toHaveLength(0);
  });
});

describe('other windows', () => {
  it('a change another window made refreshes the copy; this window\'s own does not', async () => {
    await keychain.loadKeychain();
    await keychain.saveCredentials({ a: '{"id":"a","email":"a@x.test"}' });
    const reads = sent('credentials.get').length;
    h.listeners.get('credentials-changed')({ payload: { ids: ['a'], version: credVersion } });
    await Promise.resolve();
    expect(sent('credentials.get')).toHaveLength(reads);

    blob.w2 = '{"id":"w2","email":"w2@x.test","password":"p"}';
    credVersion += 1;
    h.listeners.get('credentials-changed')({ payload: { ids: ['w2'], version: credVersion } });
    await vi.waitFor(() => expect(sent('credentials.get')).toHaveLength(reads + 1));
    await vi.waitFor(async () => expect(Object.keys(await keychain.loadKeychain()).sort()).toEqual(['a', 'old', 'w2']));
  });

  it('a refresh read that a local write overtook does not replace the copy', async () => {
    await keychain.loadKeychain();
    let release;
    let first = true;
    useDaemon((cmd) => (cmd === 'credentials.get' && first ? () => { first = false; const snapshot = { status: 'granted', credentials: { ...blob } }; return new Promise(r => { release = () => r(snapshot); }); } : undefined));
    h.listeners.get('credentials-changed')({ payload: { ids: ['x'], version: 99 } });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await keychain.saveCredentials({ mine: '{"id":"mine","email":"m@x.test"}' });
    release();
    await vi.waitFor(() => expect(sent('credentials.get').length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(async () => expect(Object.keys(await keychain.loadKeychain())).toContain('mine'));
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

describe('qualified U outcome policy', () => {
  for (const method of ['credentials.save', 'credentials.delete', 'credentials.update']) {
    it(`${method}: a lost accepted reply cannot switch writers or commit cache`, async () => {
      const cache = await keychain.loadKeychain();
      const before = { ...cache };
      const wire = deferred();
      let admitted = false;
      useDaemon(cmd => cmd === method ? () => { admitted = true; return wire.promise; } : undefined);
      const operation = method.endsWith('save') ? keychain.saveCredentials({ a: '{"id":"a"}' })
        : method.endsWith('delete') ? keychain.deleteCredentials(['old']) : keychain.updateCredentials('old', { password: 'new' });
      const result = attempt(operation);
      await vi.waitFor(() => expect(admitted).toBe(true));
      wire.reject(UNAVAILABLE());
      expect((await result).error).toBeInstanceOf(Error);
      expect(cache).toEqual(before);
      noShellMutation();
      expect(sent(method)).toHaveLength(1);
      expect(sent('oauth2.credentials_changed')).toHaveLength(0);
    });
    it(`${method}: bare version is not an acknowledgement`, async () => {
      const cache = await keychain.loadKeychain();
      const before = { ...cache };
      useDaemon(cmd => cmd === method ? () => ({ version: 40 }) : undefined);
      const operation = method.endsWith('save') ? keychain.saveCredentials({ a: '{"id":"a"}' })
        : method.endsWith('delete') ? keychain.deleteCredentials(['old']) : keychain.updateCredentials('old', { password: 'new' });
      expect((await attempt(operation)).error).toBeInstanceOf(Error);
      expect(cache).toEqual(before);
      noShellMutation();
    });
  }
  for (const malformed of [false, true]) {
    it(`metadata put rejects ${malformed ? 'malformed' : 'lost'} completion after credential success`, async () => {
      useDaemon(cmd => cmd === 'accounts.put' ? () => malformed ? { version: 4 } : Promise.reject(UNAVAILABLE()) : undefined);
      const out = await attempt(accounts.saveAccounts([{ id: 'a', email: 'a@x.test', password: 'synthetic-a' }]));
      expect(out.error?.message).toMatch(/^E_KEYCHAIN_WRITE/);
      expect(JSON.parse(blob.a).password).toBe('synthetic-a'); // an earlier step can remain changed
      expect(JSON.parse(file).map(a => a.id)).toEqual(['old']);
      noShellMutation();
    });
  }
  it('native uncertainty survives read/cache/reconnect and refuses later old-daemon fallback', async () => {
    useDaemon(cmd => cmd === 'credentials.save' ? () => Promise.reject(UNAVAILABLE()) : undefined);
    await attempt(keychain.saveCredentials({ a: '{"id":"a"}' }));
    keychain.clearCredentialsCache();
    await keychain.loadKeychain(); // readable data does not prove earlier work was cancelled
    h.listeners.get('daemon-reconnected')?.();
    useDaemon(cmd => cmd === 'credentials.save' ? () => Promise.reject(OUTDATED()) : undefined);
    const out = await attempt(keychain.saveCredentials({ b: '{"id":"b"}' }));
    expect(out.error).toBeInstanceOf(Error);
    noShellMutation();
  });
  it('a quiet fallback read remains presentation data, never write authority', async () => {
    useDaemon(cmd => cmd === 'credentials.get' ? () => Promise.reject(UNAVAILABLE())
      : cmd === 'credentials.save' ? () => Promise.reject(UNAVAILABLE()) : undefined);
    expect(Object.keys(await keychain.loadKeychain())).toEqual(['old']);
    expect(keychainSession.getStatus()).toBe('granted');
    expect((await attempt(keychain.saveCredentials({ a: '{"id":"a"}' }))).error).toBeInstanceOf(Error);
    noShellMutation();
  });
  it('legacy mutation obtains fresh complete data and probes native again after upgrade', async () => {
    useDaemon(cmd => cmd.startsWith('credentials.') ? () => Promise.reject(OUTDATED()) : undefined);
    await keychain.loadKeychain();
    blob.other = '{"id":"other","email":"other@x.test"}';
    await keychain.saveCredentials({ a: '{"id":"a"}' });
    expect(Object.keys(blob).sort()).toEqual(['a', 'old', 'other']);
    const shellWrites = sent('store_credentials').length;
    useDaemon();
    await keychain.saveCredentials({ b: '{"id":"b"}' });
    expect(sent('credentials.save')).toHaveLength(2);
    expect(sent('store_credentials')).toHaveLength(shellWrites);
    expect(Object.keys(blob).sort()).toEqual(['a', 'b', 'old', 'other']);
  });
  for (const status of ['denied', 'unavailable', 'malformed']) {
    it(`legacy mutation refuses a fresh ${status} read even with a warm complete cache`, async () => {
      await keychain.loadKeychain();
      useDaemon(cmd => cmd === 'credentials.save' ? () => Promise.reject(OUTDATED())
        : cmd === 'get_credentials' ? () => status === 'malformed' ? { status: 'granted', credentials: [] } : { status } : undefined);
      expect((await attempt(keychain.saveCredentials({ a: '{"id":"a"}' }))).error).toBeInstanceOf(Error);
      noShellMutation();
    });
  }
  it('unknown legacy completion stops retries and subsequent native intents', async () => {
    vi.useFakeTimers();
    useDaemon(cmd => cmd === 'credentials.save' ? () => Promise.reject(OUTDATED())
      : cmd === 'store_credentials' ? () => Promise.reject(UNAVAILABLE()) : undefined);
    const pending = attempt(keychain.saveCredentials({ a: '{"id":"a"}' }));
    await vi.advanceTimersByTimeAsync(3500);
    expect((await pending).error).toBeInstanceOf(Error);
    expect(sent('store_credentials')).toHaveLength(1);
    keychain.clearCredentialsCache();
    useDaemon();
    expect((await attempt(keychain.saveCredentials({ b: '{"id":"b"}' }))).error).toBeInstanceOf(Error);
    expect(blob.b).toBeUndefined();
  });
  it('read message/error canaries never reach logs or the session message', async () => {
    const spies = ['log', 'warn', 'error'].map(k => vi.spyOn(console, k).mockImplementation(() => {}));
    useDaemon(cmd => cmd === 'credentials.get' || cmd === 'get_credentials' ? () => ({ status: 'unavailable', message: 'CANARY-password-token' }) : undefined);
    await keychain.loadKeychain();
    expect(keychainSession.getStatus()).toBe('unavailable');
    expect(keychainSession.getMessage() || '').not.toContain('CANARY');
    useDaemon(cmd => cmd === 'credentials.save' ? () => Promise.reject(new Error('CANARY-password-token')) : undefined);
    vi.useFakeTimers();
    const pending = attempt(accounts.saveAccount({ id: 'a', email: 'a@x.test', password: 'CANARY-password-token' }));
    await vi.advanceTimersByTimeAsync(3500);
    await pending;
    expect(JSON.stringify(spies.flatMap(s => s.mock.calls))).not.toContain('CANARY');
  });
});

describe('qualified U connection epochs', () => {
  it('restart after generation100 accepts new generation1/2 and another window deletion', async () => {
    await keychain.loadKeychain();
    credVersion = 100;
    await keychain.saveCredentials({ mine: '{"id":"mine"}' });
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

describe('qualified U refreshed pairs through actual adapters', () => {
  it('old daemon leaves rotated offered pair unsaved until guarded native persistence accepts original chain', async () => {
    const logs = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = { id: 'g', email: 'g@x.test', oauth2RefreshToken: 'synthetic-original', oauth2ClientId: 'c', oauth2ExpiresAt: 1 };
    blob.g = JSON.stringify(original);
    const chain = [await sync.grantFingerprint(original)];
    const pair = { accountId: 'g', accessToken: 'synthetic-access', refreshToken: 'synthetic-rotated', expiresAt: 500, chain };
    h.mailAccounts = [original];
    let supported = false;
    let offered = true;
    useDaemon((cmd, args) => {
      if (cmd === 'oauth2.take_refreshed') return () => ({ tokens: offered ? [pair] : [] });
      if (cmd === 'credentials.update') return async () => {
        if (!supported) throw OUTDATED();
        expect(args.chain).toEqual(chain);
        expect(args.chain).toContain(await sync.grantFingerprint(JSON.parse(blob.g)));
        blob.g = JSON.stringify({ ...JSON.parse(blob.g), ...args.fields });
        offered = false;
        return { updated: true, version: ++credVersion };
      };
      return undefined;
    });
    expect(await sync.saveRefreshedTokens()).toBe(0);
    expect(await sync.saveRefreshedTokens()).toBe(0);
    expect(sent('oauth2.take_refreshed')).toHaveLength(2);
    expect(offered).toBe(true);
    expect(JSON.parse((await keychain.loadKeychain()).g)).toEqual(original);
    expect(h.mailAccounts[0].oauth2AccessToken).toBeUndefined();
    expect(sent('oauth2.credentials_changed')).toHaveLength(0);
    noShellMutation();
    expect(logs.mock.calls.some(a => String(a[0]).includes('could not save'))).toBe(true);
    expect(JSON.stringify(logs.mock.calls)).not.toContain('synthetic-');
    supported = true;
    expect(await sync.saveRefreshedTokens()).toBe(1);
    expect(JSON.parse(blob.g).oauth2RefreshToken).toBe(pair.refreshToken);
    expect(h.mailAccounts[0].oauth2AccessToken).toBe(pair.accessToken);
    expect(offered).toBe(false);
  });
});

describe('qualified U deletion sequencing and outcomes', () => {
  it('receipt, metadata, credential order prevents native legacy preservation resurrection', async () => {
    preserveLegacy = true;
    file = JSON.stringify([{ id: 'old', email: 'old@x.test', password: 'legacy-A' }, { id: 'b', email: 'b@x.test' }]);
    blob.b = '{"id":"b","password":"keep-B"}';
    await accounts.deleteAccount('old');
    const effects = names().filter(n => ['compose.receipts.remove_account', 'accounts.remove', 'credentials.delete'].includes(n));
    expect(effects).toEqual(['compose.receipts.remove_account', 'accounts.remove', 'credentials.delete']);
    expect(blob.old).toBeUndefined();
    expect(JSON.parse(blob.b).password).toBe('keep-B');
    expect(JSON.parse(file).map(a => a.id)).toEqual(['b']);
  });
  it('receipt refusal precedes init legacy cleanup', async () => {
    blob.orphan = '{"id":"orphan","password":"synthetic-orphan"}';
    useDaemon(cmd => cmd === 'compose.receipts.remove_account' ? () => Promise.reject(UNAVAILABLE()) : undefined);
    expect((await attempt(accounts.deleteAccount('old'))).error).toBeInstanceOf(Error);
    expect(names()).toEqual(['compose.receipts.remove_account']);
    expect(blob.orphan).toBeDefined();
  });
  for (const error of [() => UNAVAILABLE(), () => coded('RPC_ERROR', 'errors.accountsConflict')]) {
    it('unknown/refused metadata removal stops credential and local cleanup', async () => {
      useDaemon(cmd => cmd === 'accounts.remove' ? () => Promise.reject(error()) : undefined);
      expect((await attempt(accounts.deleteAccount('old'))).error).toBeInstanceOf(Error);
      expect(blob.old).toBeDefined();
      expect(sent('credentials.delete')).toHaveLength(0);
      expect(sent('clear_email_cache')).toHaveLength(0);
      noShellMutation();
    });
  }
  it('credential deletion stays pending after list removal, then fails truthfully before local cleanup', async () => {
    const wire = deferred();
    useDaemon(cmd => cmd === 'credentials.delete' ? () => wire.promise : undefined);
    const pending = attempt(accounts.deleteAccount('old'));
    await vi.waitFor(() => expect(sent('credentials.delete')).toHaveLength(1));
    expect(JSON.parse(file)).toEqual([]);
    expect(sent('clear_email_cache')).toHaveLength(0);
    wire.reject(UNAVAILABLE());
    expect((await pending).error).toBeInstanceOf(Error);
    expect(blob.old).toBeDefined();
    expect(sent('clear_email_cache')).toHaveLength(0);
    noShellMutation();
    useDaemon();
    await accounts.deleteAccount('old'); // explicit caller retry uses idempotent native intents
    expect(blob.old).toBeUndefined();
    expect(sent('clear_email_cache')).toHaveLength(1);
  });
});
