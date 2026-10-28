const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '../../../../');
const BASE = '043969de0ccfaaf822e1740ea4483c7043163bad';
const CLOCK_MS = 1_700_000_000_000;
const OUT = path.join(ROOT, 'src-core/tests/fixtures/refresh-orchestration-cases.json');
const PROVENANCE = OUT.replace('.json', '.provenance.json');
const ORIGINALS = {
  refresh: ['src/services/workflows/refreshAccounts.js', 'src__services__workflows__refreshAccounts.js.base64', '21c348ac76a050b874598c0cc7c54c29f6790c231ee0c22324d0360e038e7066'],
  hook: ['src/hooks/useEmailScheduler.js', 'src__hooks__useEmailScheduler.js.base64', 'b9668a5bfe721dea5ee3a1f9fb4b03a05530c4732c6c2b2822f24f676c0f5318'],
  auth: ['src/services/authUtils.js', 'src__services__authUtils.js.base64', '28673eb0ae99b6ccfafa67ca348f68cfd5033de14f92db799abd5e25073c4786'],
  graph: ['src/services/graphConfig.js', 'src__services__graphConfig.js.base64', '55633f6b732b86a010f3b3ff8ad86cb1c328d88a668ac2b9842104446cc90799'],
  adoption: ['src/services/workflows/adoptGraphFolderKeys.js', 'src__services__workflows__adoptGraphFolderKeys.js.base64', '94431416cf4b5964b07d7ea14a051ee83d8bca6f6f58e47c6ac5c7ac1d1771c6'],
  cache: ['src/services/cacheManager.js', 'src__services__cacheManager.js.base64', 'a88665b29d2f5d1d246f48c3b2f194e3c186ada3a3131338bbb5516b62909f19'],
  identity: ['src/services/headerIdentity.js', 'src__services__headerIdentity.js.base64', 'fd1a1289a47ae5f7a0def02effd4bbd1437b992698f76d03e9debc8d72d7fd1e'],
  unified: ['src/stores/slices/unifiedHelpers.js', 'src__stores__slices__unifiedHelpers.js.base64', 'fcb80eace56c834974cc6825870d4a44004afdf1a8d2a4974a40be0cba28c41a'],
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const archivePath = key => path.join(__dirname, 'refresh-orchestration-originals', ORIGINALS[key][1]);
const originalBytes = key => Buffer.from(fs.readFileSync(archivePath(key), 'ascii').trim(), 'base64');
const capturing = process.env.MV_CAPTURE_REFRESH_ORCHESTRATION === '1';
for (const [key, [source, , hash]] of Object.entries(ORIGINALS)) {
  const bytes = originalBytes(key);
  if (sha(bytes) !== hash) throw Error('Changed archived source: ' + source);
  if (capturing) {
    const base = cp.execFileSync('git', ['show', BASE + ':' + source], { cwd: ROOT });
    if (!bytes.equals(base) || !bytes.equals(fs.readFileSync(path.join(ROOT, source)))) {
      throw Error('Archived/live source differs from accepted head: ' + source);
    }
  }
}
if (capturing && !/^[a-f0-9]{64}$/.test(process.env.MV_REFRESH_ORCHESTRATION_RUNNER_SHA256 || '')) {
  throw Error('Capture requires the evidence runner SHA-256');
}
const snap = value => {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'function') return { $function: true };
  if (value && typeof value === 'object' && typeof value.name === 'string'
      && typeof value.message === 'string') return { name: value.name, message: value.message };
  if (value instanceof Set) return [...value].map(snap);
  if (Array.isArray(value)) return value.map(snap);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      ['password', 'oauth2AccessToken', 'oauth2RefreshToken'].includes(k)
        ? [k + 'Present', !!v] : [k, snap(v)]));
  }
  return value;
};
const errorOf = error => error ? { name: error.name || 'ThrownValue', message: error.message || String(error) } : null;
const row = (uid, subject, from) => ({ uid, subject: subject || 'subject-' + uid,
  from: from || { name: 'Sender ' + uid, address: 'sender' + uid + '@example.test' },
  messageId: '<m' + uid + '@example.test>', flags: [] });
const A = { id: 'account-a', email: 'a@example.test', password: true };
const B = { id: 'account-b', email: 'b@example.test', password: true };
const C = { id: 'account-c', email: 'c@example.test', password: true };
const G = { id: 'account-g', email: 'g@example.test', authType: 'oauth2',
  oauth2AccessToken: 'synthetic-access-g', oauth2Transport: 'graph' };
const J = { id: 'account-j', email: 'j@example.test', authType: 'oauth2',
  oauth2AccessToken: 'synthetic-access-j', oauth2Transport: 'jmap' };
const N = { id: 'account-n', email: 'n@example.test' };
const R = { id: 'account-r', email: 'r@example.test', authType: 'oauth2',
  oauth2RefreshToken: true };
const O = { id: 'account-o', email: 'o@example.test', authType: 'oauth2',
  oauth2AccessToken: 'synthetic-access-o' };
const inbox = [row(1), row(2), row(3)];
const higher = [row(5, 'Newest', { name: 'New Person', address: 'new@example.test' }), row(4), ...inbox];
const fullMeta = { totalEmails: 3, totalCached: 3 };
const folderSent = [{ path: '[Gmail]/Sent Mail', name: 'Sent', specialUse: '\\Sent' },
  { path: 'Sent', name: 'Sent copy' }];
const graphSent = { id: 'folder-sent', displayName: 'Gesendete Elemente', storageKey: 'Sent',
  wellKnownName: 'sentitems', totalItemCount: 3 };
const graphInbox = { id: 'folder-inbox', displayName: 'Inbox', storageKey: 'INBOX',
  wellKnownName: 'inbox', totalItemCount: 3 };
const graphCustom = { id: 'folder-custom', displayName: 'Projects', storageKey: 'Projects',
  wellKnownName: null, totalItemCount: 3 };

const refreshCases = [
  { name: 'empty-accounts', accounts: [] },
  { name: 'one-visible-imap', accounts: [A], pages: { 'account-a/INBOX/1': { emails: inbox, total: 3, hasMore: false } } },
  { name: 'hidden-first', accounts: [A, B, C], hidden: ['account-a'] },
  { name: 'hidden-middle', accounts: [A, B, C], hidden: ['account-b'] },
  { name: 'hidden-all', accounts: [A, B], hidden: ['account-a', 'account-b'] },
  { name: 'missing-password-and-token', accounts: [N, A] },
  { name: 'oauth-access-token-present', accounts: [O] },
  { name: 'oauth-refresh-only-skipped', accounts: [R] },
  { name: 'retry-b-while-a-active', accounts: [A, B], activeAccountId: 'account-a', options: { accountId: 'account-b' } },
  { name: 'retry-active-a', accounts: [A, B], activeAccountId: 'account-a', options: { accountId: 'account-a' },
    loadedEmails: higher },
  { name: 'retry-hidden-a', accounts: [A, B], activeAccountId: 'account-a', hidden: ['account-a'],
    options: { accountId: 'account-a' } },
  { name: 'retry-missing-id', accounts: [A, B], activeAccountId: 'missing',
    options: { accountId: 'missing' } },
  { name: 'retry-active-fetch-fails', accounts: [A], activeAccountId: 'account-a',
    options: { accountId: 'account-a' }, loadError: 'synthetic-active-load-failure' },
  { name: 'active-ordinary-inbox', accounts: [A, B], activeAccountId: 'account-a',
    activeMailbox: 'INBOX', loadedEmails: higher },
  { name: 'active-ordinary-sent', accounts: [A, B], activeAccountId: 'account-a',
    activeMailbox: 'Sent', loadedEmails: higher },
  { name: 'inactive-inbox', accounts: [A, B], activeAccountId: 'account-a',
    activeMailbox: 'Sent' },
  { name: 'explicit-all-account-sent', accounts: [A, B], options: { mailbox: 'Sent' },
    cachedMailboxes: folderSent },
  { name: 'unified-inbox', accounts: [A, B], unifiedInbox: true, activeMailbox: 'UNIFIED',
    unifiedFolder: 'INBOX' },
  { name: 'unified-sent', accounts: [A, B], unifiedInbox: true, activeMailbox: 'UNIFIED',
    unifiedFolder: 'Sent', cachedMailboxes: folderSent },
  { name: 'unified-literal-sentinel', accounts: [A], activeMailbox: 'UNIFIED',
    options: { mailbox: 'UNIFIED' } },
  { name: 'imap-one-page', accounts: [A], pages: { 'account-a/INBOX/1': { emails: inbox, total: 3, hasMore: false } } },
  { name: 'imap-two-pages', accounts: [A], pages: { 'account-a/INBOX/1': { emails: [row(3), row(2)], total: 3, hasMore: true },
    'account-a/INBOX/2': { emails: [row(1)], total: 3, hasMore: false } } },
  { name: 'imap-empty-last-page', accounts: [A], pages: { 'account-a/INBOX/1': { emails: [row(2), row(1)], total: 2, hasMore: true },
    'account-a/INBOX/2': { emails: [], total: 2, hasMore: false } } },
  { name: 'imap-page-two-refusal', accounts: [A], pages: { 'account-a/INBOX/1': { emails: [row(2)], total: 2, hasMore: true } },
    pageErrors: { 'account-a/INBOX/2': 'synthetic-page-two-refusal' } },
  { name: 'cached-alias-mailbox-list', accounts: [A], options: { mailbox: 'Sent' },
    descriptorMailboxes: folderSent },
  { name: 'db-fallback-mailbox-list', accounts: [A], options: { mailbox: 'Sent' },
    cachedMailboxes: folderSent },
  { name: 'graph-well-known-localized-sent', accounts: [G], options: { mailbox: 'Sent' },
    graphFolders: [graphSent], graphResult: { headers: [row(1)], graphMessageIds: ['g-id-1'] } },
  { name: 'graph-well-known-inbox', accounts: [G], graphFolders: [graphInbox],
    graphResult: { headers: [row(1)], graphMessageIds: ['g-id-1'] } },
  { name: 'graph-custom-folder', accounts: [G], options: { mailbox: 'Projects' },
    graphFolders: [graphCustom], graphResult: { headers: [row(1)], graphMessageIds: ['g-id-1'] } },
  { name: 'graph-target-absent', accounts: [G], graphFolders: [graphSent] },
  { name: 'graph-one-page-next-link', accounts: [G], graphFolders: [graphInbox],
    graphResult: { headers: [row(1)], graphMessageIds: ['g-id-1'], nextLink: 'synthetic-next-link' } },
  { name: 'graph-zero-rows', accounts: [G], graphFolders: [graphInbox],
    graphResult: { headers: [], graphMessageIds: [] } },
  { name: 'graph-folder-list-failure', accounts: [G, A], graphFolderError: 'synthetic-folder-failure' },
  { name: 'graph-message-list-failure', accounts: [G, A], graphFolders: [graphInbox],
    graphMessageError: 'synthetic-message-failure' },
  { name: 'graph-adoption-failed-report-continues', accounts: [G, A], graphFolders: [graphSent],
    options: { mailbox: 'Sent' }, adoptionReport: { failed: [{ from: 'Gesendete Elemente', to: 'Sent' }] },
    graphResult: { headers: [row(1)], graphMessageIds: ['g-id-1'] } },
  { name: 'graph-adoption-rejection-continues', accounts: [G, A], graphFolders: [graphSent],
    options: { mailbox: 'Sent' }, adoptionError: 'synthetic-adoption-rejection',
    graphResult: { headers: [row(1)], graphMessageIds: ['g-id-1'] } },
  { name: 'cache-absent', accounts: [A], pages: { 'account-a/INBOX/1': { emails: higher, total: 5, hasMore: false } } },
  { name: 'cache-meta-read-failure', accounts: [A], metaError: 'synthetic-meta-failure',
    pages: { 'account-a/INBOX/1': { emails: higher, total: 5, hasMore: false } } },
  { name: 'cache-zero-total', accounts: [A], meta: { totalEmails: 0, totalCached: 0 },
    pages: { 'account-a/INBOX/1': { emails: higher, total: 5, hasMore: false } } },
  { name: 'cache-partial-500-of-1634', accounts: [A], meta: { totalEmails: 1634, totalCached: 500 },
    pages: { 'account-a/INBOX/1': { emails: higher, total: 5, hasMore: false } } },
  { name: 'cache-complete-three-of-three', accounts: [A], meta: fullMeta, cachedUids: [1, 2, 3],
    pages: { 'account-a/INBOX/1': { emails: higher, total: 5, hasMore: false } } },
  { name: 'cache-uid-list-failure', accounts: [A], meta: fullMeta, uidListError: 'synthetic-uid-list-failure',
    pages: { 'account-a/INBOX/1': { emails: higher, total: 5, hasMore: false } } },
  { name: 'cache-duplicate-count', accounts: [A], meta: fullMeta, cachedUids: [1, 1, 2],
    pages: { 'account-a/INBOX/1': { emails: higher, total: 5, hasMore: false } } },
  { name: 'cache-hole-count', accounts: [A], meta: fullMeta, cachedUids: [1, 3, 5],
    pages: { 'account-a/INBOX/1': { emails: [row(6), row(5), row(3), row(1)], total: 4, hasMore: false } } },
  { name: 'one-higher-arrival', accounts: [A], meta: fullMeta, cachedUids: [1, 2, 3],
    pages: { 'account-a/INBOX/1': { emails: [row(4), ...inbox], total: 4, hasMore: false } } },
  { name: 'two-higher-arrivals', accounts: [A], meta: fullMeta, cachedUids: [1, 2, 3],
    pages: { 'account-a/INBOX/1': { emails: higher, total: 5, hasMore: false } } },
  { name: 'count-neutral-delete-delivery', accounts: [A], meta: fullMeta, cachedUids: [1, 2, 3],
    pages: { 'account-a/INBOX/1': { emails: [row(4), row(3), row(2)], total: 3, hasMore: false } } },
  { name: 'lower-uid-hole-fill', accounts: [A], meta: fullMeta, cachedUids: [1, 3, 5],
    pages: { 'account-a/INBOX/1': { emails: [row(5), row(4), row(3), row(1)], total: 4, hasMore: false } } },
  { name: 'rollover-to-lower-uid-space', accounts: [A], meta: fullMeta, cachedUids: [100, 101, 102],
    pages: { 'account-a/INBOX/1': { emails: inbox, total: 3, hasMore: false } } },
  { name: 'wide-range-backfill', accounts: [A], meta: { totalEmails: 1000, totalCached: 1000 },
    cachedUids: Array.from({ length: 1000 }, (_, i) => i + 1),
    pages: { 'account-a/INBOX/1': { emails: [row(1002), row(1001), row(1000)], total: 1002, hasMore: false } } },
  { name: 'string-uid-edge', accounts: [A], meta: fullMeta, cachedUids: ['1', '2', '3'],
    pages: { 'account-a/INBOX/1': { emails: [{ ...row(4), uid: '4' }, { ...row(3), uid: '3' }], total: 4, hasMore: false } } },
  { name: 'a-provider-fails-b-succeeds', accounts: [A, B],
    pageErrors: { 'account-a/INBOX/1': 'synthetic-a-failure' } },
  { name: 'active-loader-throws-b-succeeds', accounts: [A, B], activeAccountId: 'account-a',
    loadError: 'synthetic-active-load-failure' },
  { name: 'all-providers-fail', accounts: [A, B], pageErrors: {
    'account-a/INBOX/1': 'synthetic-a-failure', 'account-b/INBOX/1': 'synthetic-b-failure' } },
  { name: 'premium-classifies-all-visible-after-retry', accounts: [A, B, C], premium: true,
    activeAccountId: 'account-b', options: { accountId: 'account-b' } },
  { name: 'nonpremium-does-not-classify', accounts: [A, B], premium: false },
  { name: 'hidden-changes-before-classification', accounts: [A, B, C], premium: true,
    hideBeforeClassify: ['account-b'] },
  { name: 'active-view-account-switch-while-held', accounts: [A, B], activeAccountId: 'account-a',
    loadedEmails: higher, holdLoad: true, switchDuring: { activeAccountId: 'account-b', emails: [row(50)] } },
  { name: 'active-view-folder-switch-while-held', accounts: [A], activeAccountId: 'account-a',
    loadedEmails: higher, holdLoad: true, switchDuring: { activeMailbox: 'Sent', emails: [row(50)] } },
  { name: 'active-view-unified-switch-while-held', accounts: [A], activeAccountId: 'account-a',
    loadedEmails: higher, holdLoad: true, switchDuring: { activeMailbox: 'UNIFIED', unifiedInbox: true,
      unifiedFolder: 'Sent', emails: [row(50)] } },
  { name: 'active-view-subtree-switch-while-held', accounts: [A], activeAccountId: 'account-a',
    loadedEmails: higher, holdLoad: true, switchDuring: { mailboxScope: {
      root: 'Projects', paths: ['Projects', 'Projects/Child'] }, emails: [row(50)] } },
];
const currentViewCases = [
  { name: 'current-no-account', view: { activeAccountId: null, activeMailbox: null } },
  { name: 'current-ordinary-inbox', view: { activeAccountId: 'account-a', activeMailbox: 'INBOX' } },
  { name: 'current-ordinary-sent', view: { activeAccountId: 'account-a', activeMailbox: 'Sent' } },
  { name: 'current-unified-inbox-stays-open', view: { activeAccountId: 'account-a',
    activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'INBOX' } },
  { name: 'current-unified-sent-stays-open', view: { activeAccountId: 'account-a',
    activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'Sent' } },
  { name: 'current-unified-changed-during-await', view: { activeAccountId: 'account-a',
    activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'INBOX' },
    holdRefresh: true, switchDuring: { unifiedFolder: 'Sent' } },
  { name: 'current-subtree-root-with-child-paths', view: { activeAccountId: 'account-a',
    activeMailbox: 'Projects', mailboxScope: { root: 'Projects', paths: ['Projects', 'Projects/Child'] } } },
];
const adoptionCases = [
  { name: 'static-imap-no-op', kind: 'static', accounts: [A] },
  { name: 'static-success', kind: 'static', accounts: [G], report: { adopted: [{ from: 'Gesendet', to: 'Sent' }], failed: [] },
    lastMailbox: 'Gesendet' },
  { name: 'static-failed-report', kind: 'static', accounts: [G], report: { failed: [{ from: 'Gesendet', to: 'Sent' }] } },
  { name: 'static-rejection', kind: 'static', accounts: [G], adoptionError: 'synthetic-adoption-rejection' },
  { name: 'static-skipped-both-exist', kind: 'static', accounts: [G], report: { skipped_both_exist: [{ from: 'Gesendet', to: 'Sent' }], failed: [] } },
  { name: 'static-already-acknowledged', kind: 'static', accounts: [G], staticReady: true },
  { name: 'listing-empty-pairs', kind: 'listing', account: G, folders: [graphInbox] },
  { name: 'listing-localized-pair-success', kind: 'listing', account: G, folders: [graphSent],
    report: { adopted: [{ from: 'Gesendete Elemente', to: 'Sent' }], failed: [] },
    lastMailbox: 'Gesendete Elemente' },
  { name: 'listing-failed-report', kind: 'listing', account: G, folders: [graphSent],
    report: { failed: [{ from: 'Gesendete Elemente', to: 'Sent' }] } },
  { name: 'listing-rejection', kind: 'listing', account: G, folders: [graphSent],
    adoptionError: 'synthetic-listing-rejection' },
  { name: 'listing-skipped-both-exist', kind: 'listing', account: G, folders: [graphSent],
    report: { skipped_both_exist: [{ from: 'Gesendete Elemente', to: 'Sent' }], failed: [] } },
  { name: 'listing-already-acknowledged', kind: 'listing', account: G,
    folders: [graphSent], listingReady: true },
  { name: 'listing-custom-no-pair', kind: 'listing', account: G, folders: [graphCustom] },
];
function synthetic(context, identifier, exports) {
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier });
}
function source(context, key, dynamic) {
  return new vm.SourceTextModule(originalBytes(key).toString('utf8'), {
    context, identifier: 'frozen:' + key, importModuleDynamically: dynamic,
  });
}
async function evaluate(root, modules) {
  const link = spec => {
    const module = modules.get(spec);
    if (!module) throw Error('Unexpected frozen source import: ' + spec);
    return module;
  };
  await root.link(link);
  await root.evaluate();
}
function makeContext(trace) {
  return vm.createContext({
    Date: class FrozenDate extends Date { static now() { return Date.now(); } },
    setTimeout: (callback, delay) => {
      trace.push({ op: 'clock.timeout', delayMs: delay, at: Date.now() });
      return setTimeout(callback, delay);
    },
    clearTimeout: id => {
      trace.push({ op: 'clock.clearTimeout', at: Date.now() });
      clearTimeout(id);
    },
    setInterval: (callback, delay) => {
      trace.push({ op: 'clock.interval', delayMs: delay, at: Date.now() });
      return setInterval(callback, delay);
    },
    clearInterval: id => {
      trace.push({ op: 'clock.clearInterval', at: Date.now() });
      clearInterval(id);
    },
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => {
      trace.push({ op: 'console.' + level, args: snap(args) });
    }])),
    window: { __TAURI__: null },
  });
}
function summaryRows(rows) {
  return (rows || []).map(e => ({
    uid: snap(e.uid), subject: snap(e.subject), from: snap(e.from), messageId: snap(e.messageId),
    graphId: snap(e._graphId), nativeIdentity: snap(e._nativeIdentity),
  }));
}
async function settle(promise, vi) {
  let done = false;
  let value;
  let failure;
  promise.then(v => { done = true; value = v; }, e => { done = true; failure = e; });
  for (let i = 0; i < 20 && !done; i++) {
    await Promise.resolve();
    await Promise.resolve();
    if (!done) await vi.advanceTimersByTimeAsync(1000);
  }
  if (!done) throw Error('Synthetic fixture did not settle within bounded fake clock');
  return { result: snap(value), error: errorOf(failure) };
}
async function observeRefresh(testCase, vi) {
  const c = structuredClone(testCase);
  const input = snap(c);
  const trace = [];
  const context = makeContext(trace);
  const settings = {
    hiddenAccounts: Object.fromEntries((c.hidden || []).map(id => [id, true])),
    unreadPerAccount: { ...(c.initialUnread || {}) },
    billingProfile: c.premium ? { tier: 'premium' } : null,
    graphFolderKeysAdopted: {},
    graphFolderKeysAdoptedFromListing: {},
    isAccountHidden(id) { return !!this.hiddenAccounts[id]; },
    getLastMailbox() { return null; },
    setLastMailbox() {},
    markGraphFolderKeysAdopted(id) { this.graphFolderKeysAdopted[id] = true; },
    markGraphFolderKeysAdoptedFromListing(id) { this.graphFolderKeysAdoptedFromListing[id] = true; },
  };
  const settingsStore = function () { return settings; };
  settingsStore.getState = () => settings;
  settingsStore.persist = { hasHydrated: () => true };
  const state = {
    accounts: c.accounts,
    activeAccountId: c.view ? c.view.activeAccountId : (c.activeAccountId || null),
    activeMailbox: c.view ? c.view.activeMailbox : (c.activeMailbox || 'INBOX'),
    unifiedInbox: c.view ? !!c.view.unifiedInbox : !!c.unifiedInbox,
    unifiedFolder: c.view ? (c.view.unifiedFolder || 'INBOX') : (c.unifiedFolder || 'INBOX'),
    mailboxScope: c.view ? (c.view.mailboxScope || null) : (c.mailboxScope || null),
    emails: c.initialEmails || [],
    connectionStatus: 'error',
    connectionError: 'synthetic-old-error',
    connectionErrorType: 'network',
    async loadEmails() {
      trace.push({ op: 'store.loadEmails', accountId: state.activeAccountId,
        mailbox: state.activeMailbox, scope: snap(state.mailboxScope) });
      if (c.holdLoad) {
        await new Promise(resolve => { gate = { release: resolve }; });
      }
      if (c.loadError) throw Error(c.loadError);
      if (!c.switchDuring) state.emails = structuredClone(c.loadedEmails || state.emails);
      trace.push({ op: 'store.loadEmails.done', emails: summaryRows(state.emails) });
    },
    async loadUnifiedInbox(accountId, mailbox) {
      trace.push({ op: 'store.loadUnifiedInbox', accountId: snap(accountId), mailbox });
    },
    async activateAccount(accountId, mailbox) {
      trace.push({ op: 'store.activateAccount', accountId, mailbox });
    },
    async loadSubtree(accountId, root) {
      trace.push({ op: 'store.loadSubtree', accountId, root });
    },
  };
  const mailStore = {
    getState: () => state,
    setState(patch) {
      const change = typeof patch === 'function' ? patch(state) : patch;
      Object.assign(state, change);
      trace.push({ op: 'store.setState', patch: snap(change) });
    },
  };
  let gate = null;
  const api = {
    async fetchEmails(account, mailbox, page) {
      const key = account.id + '/' + mailbox + '/' + page;
      trace.push({ op: 'api.fetchEmails', accountId: account.id, mailbox, page });
      if (c.pageErrors?.[key]) throw Error(c.pageErrors[key]);
      return structuredClone(c.pages?.[key] || { emails: [], total: 0, hasMore: false });
    },
    async graphListFolders(account) {
      trace.push({ op: 'api.graphListFolders', accountId: account.id });
      if (c.graphFolderError) throw Error(c.graphFolderError);
      return structuredClone(c.graphFolders || []);
    },
    async graphListMessages(account, folderId, top, skip, mailbox) {
      trace.push({ op: 'api.graphListMessages', accountId: account.id, folderId, top, skip, mailbox });
      if (c.graphMessageError) throw Error(c.graphMessageError);
      return structuredClone(c.graphResult || { headers: [], graphMessageIds: [] });
    },
    async graphAllocateUids(accountId, mailbox, pairs) {
      trace.push({ op: 'api.graphAllocateUids', accountId, mailbox, pairs: snap(pairs) });
      return pairs.map(([id]) => {
        if (!graphIds.has(id)) graphIds.set(id, graphIds.size + 101);
        return graphIds.get(id);
      });
    },
    async vaultAdoptMailboxDirs(accountId, email, pairs) {
      trace.push({ op: 'api.vaultAdoptMailboxDirs', accountId, email, pairs: snap(pairs) });
      if (c.adoptionError) throw Error(c.adoptionError);
      return c.adoptionReport || { adopted: [], failed: [] };
    },
  };
  const graphIds = new Map();
  const db = {
    async getEmailHeadersMeta(accountId, mailbox) {
      trace.push({ op: 'db.getEmailHeadersMeta', accountId, mailbox });
      if (c.metaError) throw Error(c.metaError);
      return c.meta === undefined ? null : structuredClone(c.meta);
    },
    async listCachedUids(accountId, mailbox) {
      trace.push({ op: 'db.listCachedUids', accountId, mailbox });
      if (c.uidListError) throw Error(c.uidListError);
      return { uids: structuredClone(c.cachedUids || []) };
    },
    async getCachedMailboxes(accountId) {
      trace.push({ op: 'db.getCachedMailboxes', accountId });
      return structuredClone(c.cachedMailboxes || []);
    },
    async saveEmailHeaders(accountId, mailbox, headers, total) {
      trace.push({ op: 'db.saveEmailHeaders', accountId, mailbox, total,
        headers: summaryRows(headers) });
    },
    async loadGraphIdMap(accountId, mailbox) {
      trace.push({ op: 'db.loadGraphIdMap', accountId, mailbox });
      return structuredClone(c.graphMap || null);
    },
  };
  const noOp = {};
  const t = synthetic(context, 'i18n', { t: key => key });
  const auth = source(context, 'auth', dynamic);
  const graph = source(context, 'graph', dynamic);
  const adoption = source(context, 'adoption', dynamic);
  const identity = source(context, 'identity', dynamic);
  const cache = source(context, 'cache', dynamic);
  const unified = source(context, 'unified', dynamic);
  const classification = synthetic(context, 'classification', { run: async id => {
    trace.push({ op: 'classification.run', accountId: id });
    if (c.classificationErrorFor === id) throw Error('synthetic-classification-failure');
  } });
  const moduleMap = new Map([
    ['../db', synthetic(context, 'db', db)],
    ['./db.js', synthetic(context, 'db-js', db)],
    ['../api', synthetic(context, 'api', api)],
    ['./api.js', synthetic(context, 'api-js', api)],
    ['../../stores/settingsStore', synthetic(context, 'settings', {
      useSettingsStore: settingsStore,
    })],
    ['../../stores/settingsStore.js', synthetic(context, 'settings-js', {
      useSettingsStore: settingsStore, hasPremiumAccess: profile => !!profile && c.premium === true,
    })],
    ['../../stores/unreadCounts', synthetic(context, 'unread', {
      inboxCount: (accountId, payload) => {
        trace.push({ op: 'unread.inboxCount', accountId, totalEmails: payload.totalEmails,
          headerUids: payload.emails.map(e => e.uid) });
        return payload.emails.length >= payload.totalEmails
          ? payload.emails.filter(e => !(e.flags || []).includes('\\Seen')).length : null;
      },
      applyRecounts: rows => {
        trace.push({ op: 'unread.applyRecounts', rows: snap(rows) });
        Object.assign(settings.unreadPerAccount, rows);
      },
      selectTotalUnread: (_s, accounts) => {
        trace.push({ op: 'unread.selectTotalUnread', accountIds: accounts.map(a => a.id) });
        return accounts.filter(a => !settings.hiddenAccounts[a.id])
          .reduce((sum, a) => sum + (settings.unreadPerAccount[a.id] || 0), 0);
      },
    })],
    ['../authUtils', auth],
    ['../graphConfig', graph],
    ['./adoptGraphFolderKeys', adoption],
    ['../cacheManager', cache],
    ['../syncProbe', synthetic(context, 'probe', { invalidate: (id, mailbox) => {
      trace.push({ op: 'probe.invalidate', accountId: id, mailbox: snap(mailbox) });
      return Promise.resolve();
    } })],
    ['./helpers/mailboxRefetch', synthetic(context, 'refetch', { forceMailboxRefetch: id => {
      trace.push({ op: 'folder.forceMailboxRefetch', accountId: id });
    } })],
    ['./folderStatus', synthetic(context, 'folder-status', { invalidateFolderStatus: async id => {
      trace.push({ op: 'folder.invalidateStatus', accountId: id });
    } })],
    ['./folderOps', synthetic(context, 'folder-ops', { loadLocalFolders: id => {
      trace.push({ op: 'folder.loadLocalFolders', accountId: id });
    } })],
    ['../../stores/slices/unifiedHelpers', unified],
    ['../../stores/mailStore', synthetic(context, 'mail-store', { useMailStore: mailStore })],
    ['../classificationService.js', classification],
    ['../i18n/index.js', t],
    ['../../i18n/index.js', t],
    ['./headerIdentity.js', identity],
    ['../stores/messageRows', synthetic(context, 'message-rows', {
      registerRows() {}, mapList: rows => rows, locationState: () => ({}),
    })],
    ['../../utils/emailParser.js', synthetic(context, 'email-parser', {
      normalizeMessageId: value => value,
    })],
    ['../../services/workflows/mailboxTree.js', synthetic(context, 'mailbox-tree', {
      isLocalMailbox: () => false,
    })],
    ['../../utils/ownAddresses.js', synthetic(context, 'own-addresses', {
      ownAddresses: () => [],
    })],
  ]);
  function link(spec) {
    const found = moduleMap.get(spec);
    if (!found) throw Error('Unexpected refresh import: ' + spec);
    return found;
  }
  async function dynamic(spec) {
    if (spec === '../classificationService.js' && c.hideBeforeClassify) {
      for (const id of c.hideBeforeClassify) settings.hiddenAccounts[id] = true;
      trace.push({ op: 'settings.hideBeforeClassification', ids: c.hideBeforeClassify });
    }
    const found = link(spec);
    if (found.status === 'unlinked') await found.link(link);
    if (found.status === 'linked') await found.evaluate();
    return found;
  }
  const module = source(context, 'refresh', dynamic);
  await evaluate(module, moduleMap);
  if (c.descriptorMailboxes) {
    cache.namespace.saveRestoreDescriptor({ accountId: 'account-a', mailbox: 'INBOX',
      viewMode: 'all', mailboxes: structuredClone(c.descriptorMailboxes) });
  }
  state.refreshAllAccounts = c.currentViewMode ? async options => {
    trace.push({ op: 'store.refreshAllAccounts', options: snap(options) });
    if (c.holdRefresh) await new Promise(resolve => { gate = { release: resolve }; });
    return { newEmails: 0, totalUnread: 0 };
  } : options => module.namespace.refreshAllAccounts(options);
  const pending = c.currentViewMode
    ? module.namespace.refreshCurrentView()
    : module.namespace.refreshAllAccounts(c.options || {});
  if (c.holdLoad || c.holdRefresh) {
    for (let i = 0; i < 30 && !gate; i++) await Promise.resolve();
    if (!gate) throw Error('Expected active load did not enter held IO');
    Object.assign(state, structuredClone(c.switchDuring || {}));
    trace.push({ op: 'view.switchWhileHeld', state: snap({
      activeAccountId: state.activeAccountId, activeMailbox: state.activeMailbox,
      unifiedInbox: state.unifiedInbox, unifiedFolder: state.unifiedFolder,
      mailboxScope: state.mailboxScope, emails: summaryRows(state.emails),
    }) });
    gate.release();
  }
  const observed = await settle(pending, vi);
  for (let i = 0; i < 100; i++) await Promise.resolve();
  return { name: c.name, input, observed: { ...observed, calls: snap(trace),
    store: snap({ accounts: state.accounts.map(a => a.id), activeAccountId: state.activeAccountId,
      activeMailbox: state.activeMailbox, unifiedInbox: state.unifiedInbox,
      unifiedFolder: state.unifiedFolder, mailboxScope: state.mailboxScope,
      emails: summaryRows(state.emails), connectionStatus: state.connectionStatus,
      connectionError: state.connectionError, connectionErrorType: state.connectionErrorType,
      unreadPerAccount: settings.unreadPerAccount }) } };
}
async function observeAdoption(testCase) {
  const c = structuredClone(testCase);
  const trace = [];
  const context = makeContext(trace);
  let lastMailbox = c.lastMailbox || null;
  const settings = {
    graphFolderKeysAdopted: c.staticReady ? { 'account-g': true } : {},
    graphFolderKeysAdoptedFromListing: c.listingReady ? { 'account-g': true } : {},
    getLastMailbox(id) {
      trace.push({ op: 'settings.getLastMailbox', accountId: id });
      return lastMailbox;
    },
    setLastMailbox(id, mailbox) {
      lastMailbox = mailbox;
      trace.push({ op: 'settings.setLastMailbox', accountId: id, mailbox });
    },
    markGraphFolderKeysAdopted(id) {
      this.graphFolderKeysAdopted[id] = true;
      trace.push({ op: 'settings.markGraphFolderKeysAdopted', accountId: id });
    },
    markGraphFolderKeysAdoptedFromListing(id) {
      this.graphFolderKeysAdoptedFromListing[id] = true;
      trace.push({ op: 'settings.markGraphFolderKeysAdoptedFromListing', accountId: id });
    },
  };
  const store = { getState: () => settings,
    persist: { hasHydrated: () => true } };
  const api = synthetic(context, 'adoption:api', { vaultAdoptMailboxDirs: async (id, email, pairs) => {
    trace.push({ op: 'api.vaultAdoptMailboxDirs', accountId: id, email, pairs: snap(pairs) });
    if (c.adoptionError) throw Error(c.adoptionError);
    return structuredClone(c.report || { adopted: [], failed: [] });
  } });
  const graph = source(context, 'graph', dynamic);
  const adoption = source(context, 'adoption', dynamic);
  const map = new Map([
    ['../api', api],
    ['../graphConfig', graph],
    ['../../stores/settingsStore', synthetic(context, 'adoption:settings', { useSettingsStore: store })],
    ['../i18n/index.js', synthetic(context, 'adoption:i18n', { t: key => key })],
  ]);
  const link = spec => {
    const found = map.get(spec);
    if (!found) throw Error('Unexpected adoption import: ' + spec);
    return found;
  };
  async function dynamic(spec) {
    const found = link(spec);
    if (found.status === 'unlinked') await found.link(link);
    if (found.status === 'linked') await found.evaluate();
    return found;
  }
  await evaluate(adoption, map);
  let result;
  let error = null;
  try {
    result = c.kind === 'static'
      ? await adoption.namespace.adoptGraphFolderKeys(c.accounts)
      : await adoption.namespace.adoptGraphFolderKeysFromListing(c.account, c.folders);
  } catch (thrown) { error = errorOf(thrown); }
  return { name: c.name, input: snap(c), observed: { result: snap(result), error,
    calls: snap(trace), settings: snap({ graphFolderKeysAdopted: settings.graphFolderKeysAdopted,
      graphFolderKeysAdoptedFromListing: settings.graphFolderKeysAdoptedFromListing,
      lastMailbox }) } };
}

const schedulerCases = [
  { name: 'launch-on-one-account', accounts: [A], refreshOnLaunch: true, steps: [] },
  { name: 'launch-off-one-account', accounts: [A], refreshOnLaunch: false, steps: [] },
  { name: 'launch-empty-then-account', accounts: [], refreshOnLaunch: true,
    steps: [{ op: 'accounts', accounts: [A] }] },
  { name: 'launch-remount', accounts: [A], refreshOnLaunch: true,
    steps: [{ op: 'remount' }] },
  { name: 'launch-repeat-renders', accounts: [A], refreshOnLaunch: true,
    steps: [{ op: 'rerender' }, { op: 'rerender' }] },
  { name: 'launch-enable-after-initial-off', accounts: [A], refreshOnLaunch: false,
    steps: [{ op: 'settings', patch: { refreshOnLaunch: true } }] },
  { name: 'interval-zero', accounts: [A], refreshInterval: 0, steps: [{ op: 'tick', ms: 120000 }] },
  { name: 'interval-negative', accounts: [A], refreshInterval: -1, steps: [{ op: 'tick', ms: 120000 }] },
  { name: 'interval-default-five', accounts: [A], refreshInterval: 5,
    steps: [{ op: 'tick', ms: 299999 }, { op: 'tick', ms: 1 }] },
  { name: 'interval-change-resets', accounts: [A], refreshInterval: 5,
    steps: [{ op: 'tick', ms: 60000 }, { op: 'settings', patch: { refreshInterval: 2 } },
      { op: 'tick', ms: 119999 }, { op: 'tick', ms: 1 }] },
  { name: 'interval-account-count-change', accounts: [A], refreshInterval: 2,
    steps: [{ op: 'tick', ms: 60000 }, { op: 'accounts', accounts: [A, B] },
      { op: 'tick', ms: 119999 }, { op: 'tick', ms: 1 }] },
  { name: 'interval-held-first-tick', accounts: [A], refreshInterval: 1,
    refreshOutcome: 'held', steps: [{ op: 'tick', ms: 60000 }, { op: 'tick', ms: 60000 },
      { op: 'resolve' }] },
  { name: 'interval-held-two-more-ticks', accounts: [A], refreshInterval: 1,
    refreshOutcome: 'held', steps: [{ op: 'tick', ms: 60000 }, { op: 'tick', ms: 120000 },
      { op: 'resolve' }] },
  { name: 'interval-refresh-rejects', accounts: [A], refreshInterval: 1,
    refreshOutcome: 'reject', steps: [{ op: 'tick', ms: 60000 }] },
  { name: 'interval-per-account-failure-resolves', accounts: [A], refreshInterval: 1,
    refreshResult: { newEmails: 0, totalUnread: 0, perAccountResults: [], failed: ['account-a'] },
    steps: [{ op: 'tick', ms: 60000 }] },
  { name: 'interval-no-accounts-then-present', accounts: [], refreshInterval: 1,
    steps: [{ op: 'tick', ms: 120000 }, { op: 'accounts', accounts: [A] },
      { op: 'tick', ms: 60000 }] },
];
const watchCases = [
  { name: 'watch-imap-and-graph', accounts: [A, G] },
  { name: 'watch-jmap-and-imap', accounts: [J, A] },
  { name: 'watch-hidden-imap', accounts: [A, B], hidden: ['account-a'] },
  { name: 'watch-missing-credentials', accounts: [N, R, A] },
  { name: 'watch-token-only-change', accounts: [O],
    steps: [{ op: 'accounts', accounts: [{ ...O, oauth2AccessToken: 'synthetic-new-zzzz9999' }] }] },
  { name: 'watch-same-length-account-replacement', accounts: [A],
    steps: [{ op: 'accounts', accounts: [B] }] },
  { name: 'watch-token-prefix-change-same-suffix', accounts: [O],
    steps: [{ op: 'accounts', accounts: [{ ...O, oauth2AccessToken: 'new-prefix-access-o' }] }] },
  { name: 'watch-password-presence-unchanged', accounts: [A],
    steps: [{ op: 'accounts', accounts: [{ ...A, password: 'synthetic-password-change' }] }] },
  { name: 'watch-graph-only', accounts: [G] },
  { name: 'watch-hidden-token-change', accounts: [O], hidden: ['account-o'],
    steps: [{ op: 'accounts', accounts: [{ ...O, oauth2AccessToken: 'synthetic-new-zzzz9999' }] }] },
];
async function observeHook(testCase, tools, category) {
  const { vi, renderHook, act, cleanup } = tools;
  vi.clearAllTimers();
  vi.setSystemTime(CLOCK_MS);
  const c = structuredClone(testCase);
  const trace = [];
  const context = makeContext(trace);
  const React = require('react');
  const { create } = require('zustand');
  const held = [];
  const refreshAllAccounts = async () => {
    trace.push({ op: 'store.refreshAllAccounts', at: Date.now() });
    if (c.refreshOutcome === 'held') {
      return new Promise(resolve => held.push(resolve));
    }
    if (c.refreshOutcome === 'reject') throw Error('synthetic-refresh-rejection');
    return structuredClone(c.refreshResult || { newEmails: 0, totalUnread: 0, perAccountResults: [] });
  };
  const mail = create(() => ({
    accounts: structuredClone(c.accounts || []),
    activeAccountId: null,
    activeMailbox: 'INBOX',
    unifiedInbox: false,
    unifiedFolder: 'INBOX',
    mailboxScope: null,
    emails: [],
    refreshAllAccounts,
  }));
  const settings = create(set => ({
    refreshInterval: c.refreshInterval === undefined ? 0 : c.refreshInterval,
    refreshOnLaunch: !!c.refreshOnLaunch,
    setLastRefreshTime: time => {
      trace.push({ op: 'settings.setLastRefreshTime', at: Date.now(), value: time });
      set({ lastRefreshTime: time });
    },
    notificationSettings: { showPreview: false, sound: 'none' },
    badgeEnabled: false,
    badgeMode: 'unread',
    unreadPerAccount: {},
    hiddenAccounts: Object.fromEntries((c.hidden || []).map(id => [id, true])),
    displayNames: {},
    accountOrder: [],
    billingProfile: null,
  }));
  const mailFacade = Object.assign(selector => mail(selector), {
    getState: mail.getState, setState: mail.setState, subscribe: mail.subscribe,
  });
  const settingsFacade = Object.assign(selector => settings(selector), {
    getState: settings.getState, setState: settings.setState, subscribe: settings.subscribe,
  });
  const noChangeStore = { subscribe: () => () => {} };
  const auth = source(context, 'auth', dynamic);
  const graph = source(context, 'graph', dynamic);
  const hook = source(context, 'hook', dynamic);
  const modules = new Map([
    ['react', synthetic(context, 'react', { useEffect: React.useEffect, useRef: React.useRef })],
    ['../stores/mailStore', synthetic(context, 'hook:mail', { useMailStore: mailFacade })],
    ['../stores/accountStore', synthetic(context, 'hook:account', { useAccountStore: mailFacade })],
    ['../stores/messageListStore', synthetic(context, 'hook:messages', { useMessageListStore: mailFacade })],
    ['../stores/settingsStore', synthetic(context, 'hook:settings', {
      useSettingsStore: settingsFacade, selectOwnAddresses: () => [],
    })],
    ['../stores/snoozeStore', synthetic(context, 'hook:snooze', {
      localSnoozeKeys: () => new Set(), useSnoozeStore: noChangeStore,
    })],
    ['../stores/viewHideStore', synthetic(context, 'hook:view-hide', {
      useViewHideStore: noChangeStore,
    })],
    ['../stores/unreadCounts', synthetic(context, 'hook:unread', {
      recountInbox: () => false, addArrivals() {}, isCompleteCache: () => false,
      selectTotalUnread: () => 0, unreadRows: () => [],
    })],
    ['../stores/focusStore', synthetic(context, 'hook:focus', { notify() {} })],
    ['../services/db', synthetic(context, 'hook:db', {
      getEmailHeaders: async () => null, getEmailHeadersPartial: async () => null,
    })],
    ['../services/cacheManager', synthetic(context, 'hook:cache', {
      invalidateRestoreDescriptors() {},
    })],
    ['../services/syncService', synthetic(context, 'hook:sync', {
      watchAccount: account => {
        trace.push({ op: 'sync.watchAccount', accountId: account.id,
          transport: account.oauth2Transport || 'imap',
          passwordPresent: !!account.password,
          accessTokenSuffix: typeof account.oauth2AccessToken === 'string'
            ? account.oauth2AccessToken.slice(-8) : null });
      },
      waitForSyncChanges: (since, timeoutMs) => {
        trace.push({ op: 'sync.waitForSyncChanges', since: snap(since), timeoutMs });
        return new Promise(() => {});
      },
    })],
    ['../services/searchIndex', synthetic(context, 'hook:search', {
      onDaemonReconnected: () => {
        trace.push({ op: 'search.onDaemonReconnected' });
        return Promise.resolve(() => {});
      },
    })],
    ['../services/authUtils', auth],
    ['../services/graphConfig', graph],
    ['../utils/notificationSounds', synthetic(context, 'hook:sounds', {
      normalizeNotificationSound: sound => sound,
    })],
    ['../utils/ownAddresses', synthetic(context, 'hook:own', {
      isOwnAddress: () => false,
    })],
    ['../utils/sentFolder', synthetic(context, 'hook:sent', {
      isOutgoingMailboxName: () => false, sentMailboxPathFor: () => 'Sent',
    })],
    ['../services/codeBubble', synthetic(context, 'hook:code', {
      offerCodeFromArrival: async () => null,
    })],
    ['../i18n/index.js', synthetic(context, 'hook:i18n', { t: key => key })],
    ['../services/workflows/replayOps', synthetic(context, 'hook:replay', {
      replayOps: async () => {
        trace.push({ op: 'replay.replayOps' });
      },
      wireReplayOnReconnect: () => {
        trace.push({ op: 'replay.wireReplayOnReconnect' });
      },
    })],
  ]);
  function link(spec) {
    const found = modules.get(spec);
    if (!found) throw Error('Unexpected hook import: ' + spec);
    return found;
  }
  async function dynamic(spec) {
    const found = link(spec);
    if (found.status === 'unlinked') await found.link(link);
    if (found.status === 'linked') await found.evaluate();
    return found;
  }
  await evaluate(hook, modules);
  const flush = async () => act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  let mounted = renderHook(() => hook.namespace.useEmailScheduler());
  await flush();
  for (const step of c.steps || []) {
    trace.push({ op: 'scenario.step', step: snap(step), at: Date.now() });
    if (step.op === 'tick') {
      await act(async () => { await vi.advanceTimersByTimeAsync(step.ms); });
    } else if (step.op === 'settings') {
      act(() => settings.setState(step.patch));
    } else if (step.op === 'accounts') {
      act(() => mail.setState({ accounts: structuredClone(step.accounts) }));
    } else if (step.op === 'rerender') {
      mounted.rerender();
    } else if (step.op === 'remount') {
      mounted.unmount();
      mounted = renderHook(() => hook.namespace.useEmailScheduler());
    } else if (step.op === 'resolve') {
      await act(async () => {
        const pending = held.splice(0);
        trace.push({ op: 'scenario.resolveHeld', count: pending.length, at: Date.now() });
        for (const resolve of pending) resolve({ newEmails: 0, totalUnread: 0, perAccountResults: [] });
        await Promise.resolve();
      });
    } else {
      throw Error('Unknown hook scenario step: ' + step.op);
    }
    await flush();
  }
  if (held.length) {
    await act(async () => {
      const pending = held.splice(0);
      trace.push({ op: 'scenario.cleanupHeld', count: pending.length, at: Date.now() });
      for (const resolve of pending) resolve({ newEmails: 0, totalUnread: 0, perAccountResults: [] });
      await Promise.resolve();
    });
  }
  const beforeUnmount = trace.length;
  const unmountAt = Date.now();
  mounted.unmount();
  cleanup();
  vi.clearAllTimers();
  trace.push({ op: 'scenario.unmount', beforeTraceEntries: beforeUnmount, at: unmountAt });
  return { name: c.name, input: snap(c), observed: {
    calls: snap(trace), settings: snap({ lastRefreshTime: settings.getState().lastRefreshTime,
      refreshInterval: settings.getState().refreshInterval,
      refreshOnLaunch: settings.getState().refreshOnLaunch }),
    finalAccounts: mail.getState().accounts.map(a => a.id), category,
  } };
}

const groupedCases = {
  refresh: refreshCases,
  currentView: currentViewCases,
  adoption: adoptionCases,
  scheduler: schedulerCases,
  watch: watchCases,
};
const caseManifest = Object.fromEntries(Object.entries(groupedCases).map(([group, cases]) =>
  [group, { count: cases.length, names: cases.map(item => item.name) }]));
for (const [group, entry] of Object.entries(caseManifest)) {
  if (new Set(entry.names).size !== entry.count) throw Error('Duplicate case names in ' + group);
}
async function capture(tools) {
  const { vi } = tools;
  vi.useFakeTimers();
  vi.setSystemTime(CLOCK_MS);
  try {
    const observed = {
      refresh: [],
      currentView: [],
      adoption: [],
      scheduler: [],
      watch: [],
    };
    for (const testCase of refreshCases) {
      vi.clearAllTimers();
      vi.setSystemTime(CLOCK_MS);
      observed.refresh.push(await observeRefresh(testCase, vi));
    }
    for (const testCase of currentViewCases) {
      vi.clearAllTimers();
      vi.setSystemTime(CLOCK_MS);
      observed.currentView.push(await observeRefresh({
        ...testCase, currentViewMode: true, accounts: [A],
      }, vi));
    }
    for (const testCase of adoptionCases) {
      vi.clearAllTimers();
      vi.setSystemTime(CLOCK_MS);
      observed.adoption.push(await observeAdoption(testCase));
    }
    for (const testCase of schedulerCases) {
      observed.scheduler.push(await observeHook(testCase, tools, 'scheduler'));
    }
    for (const testCase of watchCases) {
      observed.watch.push(await observeHook(testCase, tools, 'watch'));
    }
    const fixture = {
      originalCommit: BASE, clockMs: CLOCK_MS, manifest: caseManifest,
      cases: observed,
    };
    const bytes = Buffer.from(JSON.stringify(fixture, null, 2) + '\n');
    if (capturing) {
      if (fs.existsSync(OUT) || fs.existsSync(PROVENANCE)) {
        throw Error('Refusing to overwrite an existing oracle output');
      }
      fs.writeFileSync(OUT, bytes);
      const provenance = {
        originalCommit: BASE,
        originalSources: Object.fromEntries(Object.entries(ORIGINALS).map(([key, [sourcePath, archive, hash]]) =>
          [key, { path: sourcePath,
            archive: 'src-core/tests/fixtures/gen/refresh-orchestration-originals/' + archive,
            sha256: hash, archiveSha256: sha(fs.readFileSync(archivePath(key))) }])),
        generator: { path: 'src-core/tests/fixtures/gen/refresh-orchestration-capture.cjs',
          sha256: sha(fs.readFileSync(__filename)) },
        wrapper: { path: 'src-core/tests/fixtures/gen/refresh-orchestration-cases.test.js',
          sha256: sha(fs.readFileSync(path.join(__dirname, 'refresh-orchestration-cases.test.js'))) },
        runner: { path: 'blitz-wave4-s2-oracle-v2-runner.cjs',
          sha256: process.env.MV_REFRESH_ORCHESTRATION_RUNNER_SHA256 },
        packageLockSha256: sha(fs.readFileSync(path.join(ROOT, 'package-lock.json'))),
        command: 'MV_CAPTURE_REFRESH_ORCHESTRATION=1 node --experimental-vm-modules node_modules/vitest/vitest.mjs run src-core/tests/fixtures/gen/refresh-orchestration-cases.test.js',
        clock: { epochMs: CLOCK_MS, fakeTimers: 'Vitest vi.useFakeTimers / vi.advanceTimersByTimeAsync' },
        renderer: '@testing-library/react renderHook with installed React',
        manifest: caseManifest,
        fixtureSha256: sha(bytes),
      };
      fs.writeFileSync(PROVENANCE, JSON.stringify(provenance, null, 2) + '\n');
    } else {
      if (!fs.existsSync(OUT)) throw Error('Frozen refresh orchestration corpus absent');
      const previous = fs.readFileSync(OUT);
      if (!bytes.equals(previous)) {
        const destination = process.env.MV_REFRESH_ORACLE_DIAGNOSTIC_BYTES;
        if (destination) fs.writeFileSync(destination, bytes, { flag: 'wx' });
        let first = 0;
        while (first < Math.min(bytes.length, previous.length)
          && bytes[first] === previous[first]) first++;
        process.stdout.write('W4S2_ORACLE_REPLAY_DIFFERENCE ' + JSON.stringify({
          capturedSha256: sha(previous), candidateSha256: sha(bytes),
          capturedBytes: previous.length, candidateBytes: bytes.length,
          firstByte: first === bytes.length && first === previous.length ? null : first,
        }) + '\n');
        throw Error('Frozen refresh orchestration corpus differs');
      }
      const provenance = JSON.parse(fs.readFileSync(PROVENANCE, 'utf8'));
      if (provenance.fixtureSha256 !== sha(bytes)) {
        throw Error('Refresh orchestration provenance fixture hash differs');
      }
    }
    return { manifest: caseManifest, sha256: sha(bytes) };
  } finally {
    vi.useRealTimers();
  }
}
module.exports = { capture, caseManifest };
