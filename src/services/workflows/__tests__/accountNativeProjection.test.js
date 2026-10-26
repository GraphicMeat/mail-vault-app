import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ state: {}, calls: [], reply: null, responder: null }));
vi.mock('../../db', async () => await import('../../db/accounts.js'));
vi.mock('../../transport.js', () => ({ send: async (method, params) => {
  h.calls.push([method, params]);
  if (method === 'get_app_data_dir') return '/synthetic';
  if (method === 'accounts.save') return { accounts: [h.reply.account], accepted: [h.reply.account.id], skipped: {}, version: 1, credentialVersion: 1, hostChanged: false };
  if (method === 'accounts.add' || method === 'accounts.update') return h.responder ? h.responder(method, params) : h.reply;
  throw new Error(`unexpected boundary ${method}`);
} }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: async () => true, mkdir: async () => {}, remove: async () => {} }));
vi.mock('../../api', () => ({ testConnection: async a => { h.calls.push(['legacyProbe', a]); return { host: 'h', messageCount: 3 }; }, graphProbeSignIn: async () => {}, graphListFolders: async () => [] }));
vi.mock('../../aliases', () => ({ scheduleAliasRefresh: a => h.calls.push(['aliases', a]) }));
vi.mock('../../../stores/mailStore.js', () => ({ useMailStore: { getState: () => h.state, setState: fn => Object.assign(h.state, fn(h.state)) } }));
const { useMailStore: mockedMailStore } = await import('../../../stores/mailStore.js');
const { addAccount } = await import('../addAccount.js');
const { updateAccount } = await import('../updateAccount.js');
const db = await import('../../db/accounts.js');
const keychain = await import('../../db/keychain.js');
beforeEach(() => {
  db.__resetAccountsForTests(); keychain.__resetKeychainForTests(); h.calls = []; h.responder = null;
  h.state = { accounts: [], activateAccount: async (...args) => { h.calls.push(['activate', args]); } };
  h.reply = { ok: true, account: { id: 'a', email: 'a@example.test', imapHost: 'h', authType: 'password', displayName: 'native' }, connectionCheck: { host: 'h', messageCount: 3, fromAddress: null }, hostChanged: false, version: 1, credentialVersion: 1 };
});
it('native add publishes authoritative metadata without submitted secrets', async () => {
  const result = await addAccount({ id: 'a', email: 'a@example.test', imapHost: 'h', password: 'synthetic-secret', displayName: 'stale' });
  expect(h.state.accounts).toEqual([h.reply.account]);
  expect(result).toEqual({ ...h.reply.account, connectionCheck: h.reply.connectionCheck });
});
it('native update publishes authoritative metadata without reintroducing a replacement pair', async () => {
  h.state.accounts = [{ ...h.reply.account, password: 'synthetic-old', oauth2ExpiresAt: 99 }]; h.reply.connectionCheck = null;
  const result = await updateAccount('a', { password: 'synthetic-new', oauth2AccessToken: 'synthetic-at', oauth2RefreshToken: 'synthetic-rt', oauth2ExpiresAt: 2 });
  expect(h.state.accounts).toEqual([h.reply.account]); expect(result).toEqual(h.reply.account);
});
it('native malformed completion cannot publish store state', async () => {
  h.reply = { ...h.reply, ok: true, version: -1 };
  await expect(addAccount({ id: 'a', email: 'a@example.test', imapHost: 'h', password: 'synthetic-secret' })).rejects.toThrow();
  expect(h.state.accounts).toEqual([]); expect(h.calls.filter(([name]) => ['aliases', 'activate'].includes(name))).toEqual([]);
});
const { describeConnectionError } = await import('../../../utils/connectionError.js');
it('validated versionless probe failure retains classification and releases native admission', async () => {
  h.reply = { ok: false, stage: 'probe', error: 'errors.conn.couldReachMailServerCheck', errorCode: 'blocked_or_timeout', host: 'mail.example.test', port: 993 };
  let failure; try { await addAccount({ id: 'a', email: 'a@example.test' }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ errorCode: 'blocked_or_timeout', host: 'mail.example.test', port: 993 });
  expect(failure.message).not.toBe(h.reply.error); expect(describeConnectionError(failure).message).toContain('mail.example.test');
  expect(h.state.accounts).toEqual([]); expect(() => keychain.assertLegacyWriteAllowed()).not.toThrow();
  expect(h.calls.filter(([name]) => name === 'legacyProbe')).toEqual([]);
});
for (const [name, change] of [
  ['wrong id', r => ({ ...r, account: { ...r.account, id: 'alien' } })],
  ['secret metadata', r => ({ ...r, account: { ...r.account, password: 'synthetic-secret' } })],
  ['bad credential version', r => ({ ...r, credentialVersion: -1 })],
  ['bad hostChanged', r => ({ ...r, hostChanged: 'yes' })],
  ['bad summary', r => ({ ...r, connectionCheck: { host: 'h', messageCount: '3', fromAddress: null } })],
  ['unknown catalog key', () => ({ ok: false, stage: 'probe', error: 'errors.syntheticUnknown', errorCode: null, host: null, port: null })],
  ['raw provider body', () => ({ ok: false, stage: 'probe', error: 'synthetic-secret provider body', errorCode: 'auth', host: 'h', port: 993 })],
]) it(`rejects dispatched ${name} without publishing or clearing uncertainty`, async () => {
  h.reply = change(h.reply);
  await expect(addAccount({ id: 'a', email: 'a@example.test' })).rejects.toThrow();
  expect(h.state.accounts).toEqual([]); expect(h.calls.filter(([name]) => ['aliases', 'activate', 'legacyProbe'].includes(name))).toEqual([]);
  expect(() => keychain.assertLegacyWriteAllowed()).toThrow();
  keychain.clearCredentialsCache(); expect(() => keychain.assertLegacyWriteAllowed()).toThrow();
});
it('a successful update forwards supported unsets and full expected context', async () => {
  h.state.accounts = [{ ...h.reply.account, oauth2ClientId: 'old-client', jmapUsername: 'old-login' }];
  h.reply.connectionCheck = null;
  await updateAccount('a', { oauth2ClientId: undefined, jmapUsername: undefined, displayName: 'new' });
  const request = h.calls.find(([name]) => name === 'accounts.update')[1];
  expect(request.fields).toEqual({ displayName: 'new' }); expect(request.unset).toEqual(['oauth2ClientId', 'jmapUsername']);
  expect(request.expected.fields).toMatchObject({ email: 'a@example.test', oauth2ClientId: 'old-client', jmapUsername: 'old-login' });
  expect(request.expected.absent).toContain('oauth2Transport'); expect(() => keychain.assertLegacyWriteAllowed()).not.toThrow();
});
it('an unknown add cannot mint a fresh id and resubmit on retry', async () => {
  h.reply = null;
  await expect(addAccount({ email: 'a@example.test' })).rejects.toThrow();
  await expect(addAccount({ email: 'a@example.test' })).rejects.toThrow();
  expect(h.calls.filter(([name]) => name === 'accounts.add')).toHaveLength(1);
});
it('mismatched native identity latches uncertainty before native admission is released', async () => {
  const begin=keychain.beginNativeWrite;let allowedAtRelease=null;
  vi.spyOn(keychain,'beginNativeWrite').mockImplementation(()=>{const release=begin();return()=>{release();try{keychain.assertLegacyWriteAllowed();allowedAtRelease=true;}catch{allowedAtRelease=false;}};});
  h.reply={...h.reply,account:{...h.reply.account,id:'alien'}};
  try {await expect(addAccount({id:'a',email:'a@example.test'})).rejects.toThrow();expect(allowedAtRelease).toBe(false);}
  finally {vi.restoreAllMocks();}
});

it('known pre-effect refusal permits corrected intent without an uncertainty latch', async () => {
  h.responder=async()=>{throw new Error('errors.duplicateAccount');};
  await expect(addAccount({id:'a',email:'a@example.test'})).rejects.toThrow();expect(()=>keychain.assertLegacyWriteAllowed()).not.toThrow();
  h.responder=null;await expect(addAccount({id:'a',email:'a@example.test'})).resolves.toMatchObject({id:'a'});
});
it('independent native additions retain concurrent admission until each completes', async () => {
  const pending=new Map();h.responder=(_method,params)=>new Promise(resolve=>pending.set(params.account.id,resolve));
  const operations = ['a', 'b'].map(id => db.addAccountNative({ id, email: `${id}@example.test` }));
  try {
    await vi.waitFor(() => expect([...pending.keys()], JSON.stringify(h.calls.filter(([name]) => name === 'accounts.add'))).toEqual(['a', 'b']));
    expect(() => keychain.assertLegacyWriteAllowed()).toThrow();
  } finally {
    for (const [id, resolve] of pending) resolve({ ...h.reply, account: { ...h.reply.account, id, email: `${id}@example.test` } });
    await Promise.allSettled(operations);
  }
  expect(await Promise.all(operations)).toHaveLength(2);
  expect(() => keychain.assertLegacyWriteAllowed()).not.toThrow();
});

it('overlapping workflows enter transport before either response settles with controlled fixture import entry', async () => {
  const pending = new Map(), dispatches = [], outcomes = [], started = performance.now(), operations = [];
  let timer, draining = false, settled = 0;
  const arrival = {};
  for (const id of ['a', 'b']) { let notify; const promise = new Promise(resolve => { notify = resolve; }); arrival[id] = { promise, resolve: notify }; }
  const response = id => ({ ...h.reply, account: { ...h.reply.account, id, email: `${id}@example.test` } });
  h.responder = (_method, params) => {
    const id = params.account.id;
    dispatches.push({ id, elapsedMs: performance.now() - started });
    if (draining) return response(id);
    return new Promise(resolve => { pending.set(id, resolve); arrival[id].resolve(); });
  };
  const start = id => {
    const operation = addAccount({ id, email: `${id}@example.test` }).then(value => { settled += 1; return value; }, error => {
      settled += 1; outcomes.push({ id, error: error?.stack || String(error) }); throw error;
    });
    operation.catch(() => {}); // Observe immediately, including before readiness.
    operations.push(operation);
    return operation;
  };
  const beforeReply = (operation, id) => operation.then(() => { throw new Error(`${id} settled before its held reply`); }, error => { throw new Error(`${id} failed before transport: ${error?.stack || error}`); });
  const cutoff = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`workflow transport readiness: ${JSON.stringify({ dispatches, outcomes })}`)), 5000); });
  try {
    expect(mockedMailStore.getState()).toBe(h.state);
    const first = start('a');
    await Promise.race([arrival.a.promise, beforeReply(first, 'a'), cutoff]);
    // Vitest manual mocks share an import callstack and do not support two
    // simultaneous dynamic imports. A remains unresolved while B enters.
    const second = start('b');
    await Promise.race([arrival.b.promise, beforeReply(second, 'b'), cutoff]);
    expect([...pending.keys()].sort()).toEqual(['a', 'b']);
    expect(settled).toBe(0);
    expect(() => keychain.assertLegacyWriteAllowed()).toThrow();
    console.info('S23_WORKFLOW_CONCURRENCY', JSON.stringify({ entry: 'B starts after unresolved A transport arrival', dispatches, readinessMs: performance.now() - started }));
  } finally {
    clearTimeout(timer); draining = true;
    for (const [id, resolve] of pending) resolve(response(id));
    await Promise.allSettled(operations);
    if (outcomes.length) console.error('S23_WORKFLOW_OUTCOMES', JSON.stringify(outcomes));
  }
  await Promise.all(operations);
  expect(h.state.accounts.map(a => a.id).sort()).toEqual(['a', 'b']);
  expect(() => keychain.assertLegacyWriteAllowed()).not.toThrow();
});
