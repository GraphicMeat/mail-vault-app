const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../../../');
const BASE = '373b9006e64ce9085287ca715169e717812608bc';
const CLOCK_MS = 1_700_000_000_000;
const OUT = path.join(ROOT, 'src-core/tests/fixtures/sync-observation-cases.json');
const PROVENANCE = OUT.replace('.json', '.provenance.json');
const ORIGINALS = {
  probe: {
    source: 'src/services/syncProbe.js',
    archive: 'sync-observation-originals/syncProbe.js.base64',
    sha256: 'ded013d61241e8ed63b040581cc26dade40402aea547b8c092aff629a0636110',
  },
  folder: {
    source: 'src/services/workflows/folderStatus.js',
    archive: 'sync-observation-originals/folderStatus.js.base64',
    sha256: '65b0fbf1db73e8a0cf9d5c8f643322ae53feaa9093e1d0aa79dbb387d12f170d',
  },
  graph: {
    source: 'src/services/graphConfig.js',
    archive: 'sync-observation-originals/graphConfig.js.base64',
    sha256: '55633f6b732b86a010f3b3ff8ad86cb1c328d88a668ac2b9842104446cc90799',
  },
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const snapshot = value => {
  if (value === undefined) return { $undefined: true };
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]));
  }
  return value;
};
const originalBytes = key => Buffer.from(
  fs.readFileSync(path.join(__dirname, ORIGINALS[key].archive), 'ascii').trim(), 'base64');

for (const [key, entry] of Object.entries(ORIGINALS)) {
  const archived = originalBytes(key);
  if (sha(archived) !== entry.sha256) throw Error(`Changed archived ${key} source`);
  const base = cp.execFileSync('git', ['show', `${BASE}:${entry.source}`], { cwd: ROOT });
  if (!archived.equals(base)) throw Error(`Archived ${key} source differs from ${BASE}`);
}
if (process.env.MV_CAPTURE_SYNC_OBSERVATION === '1') {
  for (const [key, entry] of Object.entries(ORIGINALS)) {
    if (!originalBytes(key).equals(fs.readFileSync(path.join(ROOT, entry.source)))) {
      throw Error(`Live ${key} source changed before first oracle capture`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(process.env.MV_SYNC_OBSERVATION_RUNNER_SHA256 || '')) {
    throw Error('Capture requires the evidence runner SHA-256');
  }
}

const ACCOUNT_A = { id: 'account-a', email: 'a@example.test' };
const ACCOUNT_B = { id: 'account-b', email: 'b@example.test' };
const FULL_META = { totalEmails: 100, totalCached: 100, uidValidity: 42, uidNext: 501, highestModseq: 900 };
const FULL_STATUS = { exists: 100, uidValidity: 42, uidNext: 501, highestModseq: 900 };
const probeCheck = (overrides = {}) => ({ op: 'check', at: CLOCK_MS, account: ACCOUNT_A,
  accountId: ACCOUNT_A.id, mailbox: 'INBOX', meta: FULL_META, status: FULL_STATUS, ...overrides });
const probeMark = (overrides = {}) => ({ op: 'mark', at: CLOCK_MS, accountId: ACCOUNT_A.id,
  mailbox: 'INBOX', ...overrides });
const probeInvalidate = (overrides = {}) => ({ op: 'invalidate', at: CLOCK_MS,
  accountId: ACCOUNT_A.id, mailbox: 'INBOX', ...overrides });

const probeCases = [
  { name: 'equal-modseq-and-repeat-without-mark', steps: [probeCheck(), probeCheck({ at: CLOCK_MS + 1 })] },
  { name: 'time-zero-unmarked-and-marked', steps: [probeCheck({ at: 0 }), probeMark({ at: 0 }), probeCheck({ at: 1 })] },
  { name: 'marker-before-and-at-ten-seconds', steps: [probeMark(), probeCheck({ at: CLOCK_MS + 9_999 }), probeCheck({ at: CLOCK_MS + 10_000 })] },
  { name: 'marker-mailbox-isolation', steps: [probeMark(), probeCheck({ mailbox: 'Sent', at: CLOCK_MS + 1 }), probeCheck({ at: CLOCK_MS + 1 })] },
  { name: 'marker-account-isolation', steps: [probeMark(), probeCheck({ account: ACCOUNT_B, accountId: ACCOUNT_B.id, at: CLOCK_MS + 1 }), probeCheck({ at: CLOCK_MS + 1 })] },
  { name: 'invalidate-one-mailbox', steps: [probeMark(), probeMark({ mailbox: 'Sent' }), probeInvalidate(), probeCheck({ at: CLOCK_MS + 1 }), probeCheck({ mailbox: 'Sent', at: CLOCK_MS + 1 })] },
  { name: 'invalidate-whole-account', steps: [probeMark(), probeMark({ mailbox: 'Sent' }), probeInvalidate({ mailbox: undefined }), probeCheck({ at: CLOCK_MS + 1 }), probeCheck({ mailbox: 'Sent', at: CLOCK_MS + 1 })] },
  { name: 'invalidate-empty-mailbox-is-whole-account', steps: [probeMark(), probeInvalidate({ mailbox: '' }), probeCheck({ at: CLOCK_MS + 1 })] },
  { name: 'metadata-error', steps: [probeCheck({ metaError: 'synthetic-meta-error' })] },
  { name: 'missing-meta', steps: [probeCheck({ meta: null })] },
  { name: 'zero-total', steps: [probeCheck({ meta: { ...FULL_META, totalEmails: 0 } })] },
  { name: 'null-total', steps: [probeCheck({ meta: { ...FULL_META, totalEmails: null } })] },
  { name: 'negative-total-is-truthy', steps: [probeCheck({ meta: { ...FULL_META, totalEmails: -1 }, status: { ...FULL_STATUS, exists: -1 } })] },
  { name: 'partial-cache', steps: [probeCheck({ meta: { ...FULL_META, totalEmails: 101, totalCached: 100 } })] },
  { name: 'negative-cached-count', steps: [probeCheck({ meta: { ...FULL_META, totalCached: -1 } })] },
  { name: 'null-cached-count', steps: [probeCheck({ meta: { ...FULL_META, totalCached: null } })] },
  { name: 'status-error', steps: [probeCheck({ statusError: 'synthetic-status-error' })] },
  { name: 'status-null', steps: [probeCheck({ status: null })] },
  { name: 'status-undefined', steps: [probeCheck({ status: undefined })] },
  { name: 'uidvalidity-rollover', steps: [probeCheck({ status: { ...FULL_STATUS, uidValidity: 43 } })] },
  { name: 'uidvalidity-string-versus-number', steps: [probeCheck({ status: { ...FULL_STATUS, uidValidity: '42' } })] },
  { name: 'uidvalidity-null-uses-modseq', steps: [probeCheck({ status: { ...FULL_STATUS, uidValidity: null } })] },
  { name: 'modseq-advanced-with-level-count', steps: [probeCheck({ status: { ...FULL_STATUS, highestModseq: 901 } })] },
  { name: 'modseq-string-versus-number', steps: [probeCheck({ status: { ...FULL_STATUS, highestModseq: '900' } })] },
  { name: 'non-condstore-equal', steps: [probeCheck({ meta: { ...FULL_META, highestModseq: null }, status: { ...FULL_STATUS, highestModseq: null } })] },
  { name: 'non-condstore-numeric-exists-string', steps: [probeCheck({ meta: { ...FULL_META, highestModseq: null }, status: { ...FULL_STATUS, exists: '100', highestModseq: null } })] },
  { name: 'non-condstore-arrival-and-expunge', steps: [probeCheck({ meta: { ...FULL_META, highestModseq: null }, status: { ...FULL_STATUS, uidNext: 502, highestModseq: null } })] },
  { name: 'non-condstore-expunge-only', steps: [probeCheck({ meta: { ...FULL_META, highestModseq: null }, status: { ...FULL_STATUS, exists: 99, highestModseq: null } })] },
  { name: 'non-condstore-uidnext-string-versus-number', steps: [probeCheck({ meta: { ...FULL_META, highestModseq: null }, status: { ...FULL_STATUS, uidNext: '501', highestModseq: null } })] },
  { name: 'non-condstore-null-uidnext', steps: [probeCheck({ meta: { ...FULL_META, highestModseq: null }, status: { ...FULL_STATUS, uidNext: null, highestModseq: null } })] },
  { name: 'non-condstore-uidnext-reason-precedes-exists', steps: [probeCheck({ meta: { ...FULL_META, highestModseq: null }, status: { ...FULL_STATUS, uidNext: 502, exists: 99, highestModseq: null } })] },
];

const tree = [
  { path: 'INBOX', noselect: false, children: [] },
  { path: 'Parent', noselect: true, children: [
    { path: 'Parent/Child', noselect: false, children: [
      { path: 'Parent/Child/Leaf', children: [] },
    ] },
  ] },
  { path: 'Archive', noselect: false, children: [] },
];
const folderRefresh = (overrides = {}) => ({ op: 'refresh', at: CLOCK_MS, account: ACCOUNT_A,
  mailboxes: tree, activeMailbox: 'INBOX', rows: [
    { path: 'Parent/Child', messages: 5, unseen: 2, uidNext: 7, uidValidity: 42 },
    { path: 'Archive', messages: 3, unseen: 1, uidNext: 4, uidValidity: 42 },
  ], ...overrides });
const folderInvalidate = (overrides = {}) => ({ op: 'invalidate', at: CLOCK_MS,
  accountId: ACCOUNT_A.id, ...overrides });
const folderCases = [
  { name: 'preorder-and-noselect-child', steps: [{ op: 'flatten', at: CLOCK_MS, mailboxes: tree, activeMailbox: 'Archive' }, folderRefresh()] },
  { name: 'fifty-path-cap-after-active-exclusion', steps: [folderRefresh({ mailboxes: Array.from({ length: 52 }, (_, i) => ({ path: `F${i}` })), activeMailbox: 'F0', rows: [] })] },
  { name: 'merge-keeps-prior-paths-and-other-account', initialStore: { folderStatus: {
    [ACCOUNT_A.id]: { Old: { path: 'Old', messages: 9, unseen: 9 } },
    [ACCOUNT_B.id]: { INBOX: { path: 'INBOX', messages: 4, unseen: 4 } },
  } }, steps: [folderRefresh()] },
  { name: 'provider-omits-refused-folder', steps: [folderRefresh({ rows: [{ path: 'Archive', messages: 3, unseen: 0, uidNext: 4, uidValidity: 42 }] })] },
  { name: 'empty-success-is-object', steps: [folderRefresh({ rows: [] })] },
  { name: 'null-provider-rows-is-empty-object', steps: [folderRefresh({ rows: null })] },
  { name: 'negative-and-zero-status-values-pass-through', steps: [folderRefresh({ rows: [{ path: 'Archive', messages: -1, unseen: 0, uidNext: 0, uidValidity: null }] })] },
  { name: 'null-account-skips-without-throttle', steps: [folderRefresh({ account: null }), folderRefresh({ at: CLOCK_MS + 1 })] },
  { name: 'graph-skips-without-throttle', steps: [folderRefresh({ account: { ...ACCOUNT_A, oauth2Transport: 'graph' } }), folderRefresh({ at: CLOCK_MS + 1 })] },
  { name: 'empty-selection-skips-without-throttle', steps: [folderRefresh({ mailboxes: [{ path: 'INBOX' }], rows: [] }), folderRefresh({ at: CLOCK_MS + 1 })] },
  { name: 'repeated-before-and-at-sixty-seconds', steps: [folderRefresh(), folderRefresh({ at: CLOCK_MS + 59_999 }), folderRefresh({ at: CLOCK_MS + 60_000 })] },
  { name: 'time-zero-first-call', steps: [folderRefresh({ at: 0 }), folderRefresh({ at: 60_000 })] },
  { name: 'failed-sweep-consumes-throttle', steps: [folderRefresh({ providerError: 'synthetic-folder-status-error' }), folderRefresh({ at: CLOCK_MS + 1 }), folderInvalidate(), folderRefresh({ at: CLOCK_MS + 2 })] },
  { name: 'invalidation-is-per-account', steps: [folderRefresh(), folderRefresh({ account: ACCOUNT_B }), folderInvalidate(), folderRefresh({ account: ACCOUNT_B, at: CLOCK_MS + 1 }), folderRefresh({ at: CLOCK_MS + 1 })] },
  { name: 'null-active-path-excludes-nothing', steps: [folderRefresh({ activeMailbox: null, rows: [] })] },
];

function synthetic(context, key, exports) {
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  }, { context, identifier: key });
}

function sourceModule(context, key, importModuleDynamically) {
  return new vm.SourceTextModule(originalBytes(key).toString('utf8'), {
    context, identifier: `original:${key}`, importModuleDynamically,
  });
}

async function observeProbe(testCase) {
  let now = CLOCK_MS;
  let current;
  const calls = [];
  const context = vm.createContext({ Date: class extends Date { static now() { return now; } },
    console: { log() {}, warn() {}, error() {} } });
  const api = synthetic(context, 'probe:api', { checkMailboxStatus: async (account, mailbox) => {
    calls.push({ method: 'checkMailboxStatus', account: snapshot(account), mailbox: snapshot(mailbox) });
    if (current.statusError) throw Error(current.statusError);
    return current.status;
  } });
  const db = synthetic(context, 'probe:db', { getEmailHeadersMeta: async (accountId, mailbox) => {
    calls.push({ method: 'getEmailHeadersMeta', accountId: snapshot(accountId), mailbox: snapshot(mailbox) });
    if (current.metaError) throw Error(current.metaError);
    return current.meta;
  } });
  const module = sourceModule(context, 'probe');
  await module.link(spec => {
    if (spec === './api') return api;
    if (spec === './db') return db;
    throw Error(`Unexpected probe import: ${spec}`);
  });
  await module.evaluate();
  const steps = [];
  for (const step of testCase.steps) {
    now = step.at;
    current = step;
    const before = calls.length;
    let result, error = null;
    try {
      if (step.op === 'check') result = await module.namespace.mailboxIsUnchanged(step.account, step.accountId, step.mailbox);
      else if (step.op === 'mark') result = module.namespace.markVerified(step.accountId, step.mailbox);
      else if (step.op === 'invalidate') result = module.namespace.invalidate(step.accountId, step.mailbox);
      else throw Error(`Unknown probe operation ${step.op}`);
    } catch (thrown) { error = { name: thrown?.name || 'ThrownValue', message: thrown?.message || String(thrown) }; }
    steps.push({ input: snapshot(step), observed: { result: snapshot(result), error,
      calls: snapshot(calls.slice(before)) } });
  }
  return { name: testCase.name, steps };
}

async function observeFolder(testCase) {
  let now = CLOCK_MS;
  let current;
  let state = snapshot(testCase.initialStore || { folderStatus: {} });
  const calls = [];
  const writes = [];
  const context = vm.createContext({ Date: class extends Date { static now() { return now; } },
    console: { log() {}, warn() {}, error() {} } });
  const api = synthetic(context, 'folder:api', { fetchFolderStatus: async (account, paths) => {
    calls.push({ method: 'fetchFolderStatus', account: snapshot(account), paths: snapshot(paths) });
    if (current.providerError) throw Error(current.providerError);
    return current.rows;
  } });
  const graph = sourceModule(context, 'graph');
  const i18n = synthetic(context, 'folder:i18n', { t: key => key });
  const mailStore = synthetic(context, 'folder:mailStore', { useMailStore: {
    getState: () => state,
    setState: patch => {
      const before = snapshot(state);
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      writes.push({ before, after: snapshot(state) });
    },
  } });
  const modules = new Map([['../api', api], ['../graphConfig', graph],
    ['../i18n/index.js', i18n], ['../../stores/mailStore', mailStore]]);
  const link = spec => {
    const found = modules.get(spec);
    if (!found) throw Error(`Unexpected folder import: ${spec}`);
    return found;
  };
  const dynamicImport = async spec => {
    const found = link(spec);
    if (found.status === 'unlinked') await found.link(link);
    if (found.status === 'linked') await found.evaluate();
    return found;
  };
  const module = sourceModule(context, 'folder', dynamicImport);
  await module.link(link);
  await module.evaluate();
  const steps = [];
  for (const step of testCase.steps) {
    now = step.at;
    current = step;
    const callBefore = calls.length;
    const writeBefore = writes.length;
    const storeBefore = snapshot(state);
    let result, error = null;
    try {
      if (step.op === 'refresh') result = await module.namespace.refreshFolderStatus(step.account, step.mailboxes, step.activeMailbox);
      else if (step.op === 'invalidate') result = module.namespace.invalidateFolderStatus(step.accountId);
      else if (step.op === 'flatten') result = module.namespace._flattenSelectable(step.mailboxes, step.activeMailbox);
      else throw Error(`Unknown folder operation ${step.op}`);
    } catch (thrown) { error = { name: thrown?.name || 'ThrownValue', message: thrown?.message || String(thrown) }; }
    steps.push({ input: snapshot(step), observed: { result: snapshot(result), error,
      providerCalls: snapshot(calls.slice(callBefore)), storeBefore, storeAfter: snapshot(state),
      storeWrites: snapshot(writes.slice(writeBefore)) } });
  }
  return { name: testCase.name, initialStore: snapshot(testCase.initialStore || { folderStatus: {} }), steps };
}

(async () => {
  const probe = [];
  for (const testCase of probeCases) probe.push(await observeProbe(testCase));
  const folders = [];
  for (const testCase of folderCases) folders.push(await observeFolder(testCase));
  const fixture = { originalCommit: BASE, clockMs: CLOCK_MS, probeCases: probe, folderCases: folders };
  const bytes = Buffer.from(JSON.stringify(fixture, null, 2) + '\n');
  if (process.env.MV_CAPTURE_SYNC_OBSERVATION === '1') {
    fs.writeFileSync(OUT, bytes);
    const provenance = {
      originalCommit: BASE,
      originalSources: Object.fromEntries(Object.entries(ORIGINALS).map(([key, entry]) => [key,
        { path: entry.source, archive: `src-core/tests/fixtures/gen/${entry.archive}`, sha256: entry.sha256 }])),
      harness: { path: 'src-core/tests/fixtures/gen/sync-observation-capture.cjs', sha256: sha(fs.readFileSync(__filename)) },
      wrapper: { path: 'src-core/tests/fixtures/gen/sync-observation-cases.test.js',
        sha256: sha(fs.readFileSync(path.join(__dirname, 'sync-observation-cases.test.js'))) },
      runner: { path: 'blitz-wave4-s1-oracle-runner.cjs', sha256: process.env.MV_SYNC_OBSERVATION_RUNNER_SHA256 },
      packageLockSha256: sha(fs.readFileSync(path.join(ROOT, 'package-lock.json'))),
      command: 'MV_CAPTURE_SYNC_OBSERVATION=1 npx vitest run src-core/tests/fixtures/gen/sync-observation-cases.test.js',
      clockMs: CLOCK_MS,
      probeCaseNames: probe.map(item => item.name),
      folderCaseNames: folders.map(item => item.name),
      fixtureSha256: sha(bytes),
    };
    fs.writeFileSync(PROVENANCE, JSON.stringify(provenance, null, 2) + '\n');
  } else {
    if (!fs.existsSync(OUT) || !bytes.equals(fs.readFileSync(OUT))) throw Error('Frozen sync observation corpus differs');
    const provenance = JSON.parse(fs.readFileSync(PROVENANCE, 'utf8'));
    if (provenance.fixtureSha256 !== sha(bytes)) throw Error('Sync observation provenance fixture hash differs');
  }
  process.stdout.write(`Captured/verified ${probe.length} probe cases and ${folders.length} folder cases ${sha(bytes)}\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
