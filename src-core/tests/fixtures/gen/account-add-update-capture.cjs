const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const root = __dirname, originals = path.join(root, 'account-add-update-originals');
const blobs = { addAccount: 'e7b21ae85aedcfddbce3e7140e1846bd6a193af7', updateAccount: '170aab3494c6b14aff07027ef1672b625e84b9f6', accounts: '1b4e980f779c61bd75d94ef3cfe14097ee0f6b8b', graphConfig: 'c3ba1418c98ced06fca6e2f3fe6669ff87ec98d2' };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
for (const [name, blob] of Object.entries(blobs)) { const b = fs.readFileSync(path.join(originals, name + '.js')); if (crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex') !== blob) throw Error('Changed original ' + name); }
const base = { id: 'a', email: 'a@example.test', imapHost: 'h', password: 'synthetic-password' };
const cases = [
 ['add-first', 'add', base], ['add-second', 'add', base, [{ ...base, id: 'b', email: 'b@example.test' }]],
 ['duplicate-logical', 'add', { ...base, email: 'A@EXAMPLE.TEST', imapHost: 'H' }, [base]],
 ['same-email-other-host', 'add', { ...base, id: 'b', imapHost: 'other' }, [base]],
 ['duplicate-id-gap', 'add', { ...base, imapHost: 'other' }, [base]],
 ['no-trim', 'add', { ...base, id: 'b', email: ' a@example.test' }, [base]],
 ['security-empty', 'add', { ...base, imapSecurity: '', createdAt: 'caller-time' }],
 ['count-null', 'add', base, [], { host: 'h', messageCount: null }], ['count-missing', 'add', base, [], { host: 'h' }],
 ['count-number', 'add', base, [], { host: 'h', messageCount: 3, fromAddress: 'alias@example.test' }], ['summary-no-host', 'add', base, [], { messageCount: 3 }],
 ['graph-add', 'add', { ...base, authType: 'oauth2', oauth2Transport: 'graph', oauth2AccessToken: 'synthetic-at' }],
 ['jmap-basic', 'add', { ...base, jmapSessionUrl: 'https://jmap.example.test/session', jmapAuth: 'basic', jmapUsername: 'other-login' }],
 ['jmap-bearer', 'add', { ...base, jmapSessionUrl: 'https://jmap.example.test/session', jmapAuth: 'bearer' }],
 ['probe-string', 'add', base, [], 'string-error'], ['probe-error', 'add', base, [], 'error'], ['save-error', 'add', base, [], 'save-error'],
 ['activation-pending', 'add', base, [], 'activation-pending'], ['activation-reject', 'add', base, [], 'activation-reject'],
 ['update-missing', 'update', {}, []], ['update-collision', 'update', { imapHost: 'other' }, [base, { ...base, id: 'b', imapHost: 'other' }]],
 ['update-own', 'update', { displayName: 'new', updatedAt: 'caller-time' }, [base]], ['update-active-host', 'update', { imapHost: 'other' }, [base]],
 ['update-inactive-host', 'update', { imapHost: 'other' }, [base], 'inactive'], ['update-activation-reject', 'update', { imapHost: 'other' }, [base], 'activation-reject'],
 ['graph-exchange', 'update', { oauth2AccessToken: 'synthetic-new-at' }, [{ ...base, oauth2Transport: 'graph' }]],
 ['graph-stored', 'update', { displayName: 'new' }, [{ ...base, oauth2Transport: 'graph' }]],
];
async function capture([name, kind, input, initial = [], response = { host: 'h', messageCount: 2 }]) {
 const effects = [], persisted = []; const clone = a => JSON.parse(JSON.stringify(a));
 const state = { accounts: clone(initial), activeAccountId: response === 'inactive' ? 'other' : 'a', activeMailbox: 'Custom', activateAccount: async (...args) => { effects.push(['activate', args]); if (response === 'activation-reject') throw Error('synthetic activation'); if (response === 'activation-pending') return new Promise(() => {}); } };
 const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, crypto: { randomUUID: () => 'synthetic-uuid' }, Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-26T00:00:00.000Z'])); } } });
 const modules = new Map();
 function synthetic(key, exports) { if (!modules.has(key)) modules.set(key, new vm.SyntheticModule(Object.keys(exports), function () { for (const [k, v] of Object.entries(exports)) this.setExport(k, v); }, { context, identifier: key })); return modules.get(key); }
 function source(name) { const key = 'original:' + name; if (!modules.has(key)) modules.set(key, new vm.SourceTextModule(fs.readFileSync(path.join(originals, name + '.js'), 'utf8'), { context, identifier: key, importModuleDynamically: async spec => { const m = link(spec); if (m.status === 'unlinked') await m.link(link); if (m.status === 'linked') await m.evaluate(); return m; } })); return modules.get(key); }
 const never = () => { throw Error('Unexpected original dependency call'); };
 const external = { exists: never, mkdir: never, remove: never, send: never, parseKeychainValue: never, getAccountsFromKeychain: never, loadKeychain: never, saveCredentials: never, deleteCredentials: never, updateCredentials: never, readCurrentCredentials: never, markNativeMutationUncertain: never, assertLegacyWriteAllowed: never, beginNativeWrite: never, grantFingerprint: never };
 async function probe(branch, args) { effects.push([branch, clone(args)]); if (response === 'string-error') throw 'synthetic probe'; if (response === 'error') throw Error('synthetic probe'); return typeof response === 'object' ? response : {}; }
 function link(spec) {
  if (spec.includes('i18n')) return synthetic('i18n', { t: k => k });
  if (spec.includes('graphConfig')) return source('graphConfig');
  if (spec === '../db') return synthetic('db', { accountLogicalKey: accounts.namespace.accountLogicalKey, saveAccount: async a => { effects.push(['save', clone(a)]); if (response === 'save-error') throw Error('synthetic save'); persisted.push(clone(a)); } });
  if (spec === '../api') return synthetic('api', { testConnection: (...a) => probe('imap', a), graphProbeSignIn: (...a) => probe('graph-sign-in', a), graphListFolders: (...a) => probe('graph-stored', a) });
  if (spec.includes('stores/mailStore')) return synthetic('store', { useMailStore: { getState: () => state, setState: fn => { Object.assign(state, fn(state)); effects.push(['store', clone(state.accounts)]); } } });
  if (spec === '../aliases') return synthetic('aliases', { scheduleAliasRefresh: a => effects.push(['aliases', clone(a)]) });
  if (spec === '../keychainSession.js') return synthetic('session', {});
  if (['@tauri-apps/plugin-fs', '../transport.js', './keychain.js', '../oauthTokenSync.js'].includes(spec)) return synthetic(spec, external);
  throw Error('Unknown import ' + spec);
 }
 const accounts = source('accounts'); await accounts.link(link); await accounts.evaluate();
 const workflow = source(kind === 'add' ? 'addAccount' : 'updateAccount'); await workflow.link(link); await workflow.evaluate();
 let result, error; try { result = clone(await (kind === 'add' ? workflow.namespace.addAccount(clone(input)) : workflow.namespace.updateAccount('a', clone(input)))); } catch (e) { error = e.message || String(e); }
 await new Promise(resolve => setImmediate(resolve));
 return { name, kind, input, initial, response, result: result ?? null, error: error ?? null, effects, persisted, store: clone(state.accounts) };
}
(async () => { const output = []; for (const c of cases) output.push(await capture(c)); const bytes = Buffer.from(JSON.stringify({ originalCommit: 'd419cc73434ad25805d5ffa751be274ab3819e97', cases: output }, null, 2) + '\n'); const file = path.join(root, '..', 'account-add-update-cases.json'); if (process.env.MV_CAPTURE_ACCOUNT_WORKFLOWS === '1') { fs.writeFileSync(file, bytes); fs.writeFileSync(file.replace('.json', '.provenance.json'), JSON.stringify({ originalCommit: 'd419cc73434ad25805d5ffa751be274ab3819e97', blobs, harness: sha(fs.readFileSync(__filename)), node: process.version, lockfile: sha(fs.readFileSync('package-lock.json')), command: 'env MV_CAPTURE_ACCOUNT_WORKFLOWS=1 npx vitest run src-core/tests/fixtures/gen/account-add-update-cases.test.js', output: sha(bytes) }, null, 2) + '\n'); } else if (!fs.existsSync(file) || !bytes.equals(fs.readFileSync(file))) throw Error('Frozen corpus differs'); process.stdout.write(`Captured/verified ${output.length} original cases ${sha(bytes)}\n`); })().catch(e => { console.error(e); process.exitCode = 1; });
