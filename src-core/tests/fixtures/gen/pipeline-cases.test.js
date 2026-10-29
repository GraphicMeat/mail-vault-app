// @vitest-environment jsdom
// S5 characterization: runs the REAL EmailPipelineManager, the real
// usePipelineCoordinator hook and the real sentFolder helpers with only their IO
// seams replaced (daemon policy answer, db, stores, the AccountPipeline workers).
// Capture mode (MV_PIPELINE_CAPTURE=1) prints the corpus between markers; an
// ordinary run compares what the JS does now with the committed corpus, so the
// fixture stays reproducible until S7 removes these files.
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderHook, act, cleanup } from '@testing-library/react';
import { create } from 'zustand';

const h = vi.hoisted(() => ({
  trace: [], instances: [], gates: new Map(), policies: {}, policyDelay: null,
  mail: {}, hidden: {}, indexed: {}, vault: {}, cachedMailboxes: {}, waitSent: 'Sent',
  invalid: new Set(), complete: new Map(),
}));

vi.mock('../../../../src/services/AccountPipeline', () => ({
  AccountPipeline: class {
    constructor(account, options = {}) {
      this.account = account;
      this.accountId = account.id;
      this.concurrency = options.concurrency || 3;
      this._destroyed = false;
      this._activeSlots = 0;
      this._phase = 'idle';
      this._lastLoadedEmails = null;
      h.instances.push(this);
      h.trace.push({ event: 'construct', account: account.id, concurrency: this.concurrency });
    }
    async loadHeaders(mailbox = 'INBOX') {
      h.trace.push({ event: 'loadHeaders', account: this.accountId, mailbox });
      const gate = h.gates.get(`${this.accountId}:${mailbox}`);
      if (gate) await gate.promise;
      // The real pipeline keeps the LAST loaded folder's rows for the content phase.
      this._lastLoadedEmails = (h.headers[`${this.accountId}:${mailbox}`] || []).map(r => ({ ...r }));
    }
    async startContentCaching(uids, mailbox = 'INBOX') {
      h.trace.push({ event: 'startContentCaching', account: this.accountId, mailbox, uids: [...uids] });
    }
    waitForComplete() {
      const hold = h.complete.get(this.accountId);
      h.trace.push({ event: 'waitForComplete', account: this.accountId });
      return hold ? hold.promise : Promise.resolve();
    }
    resume(mailbox) { h.trace.push({ event: 'resume', account: this.accountId, mailbox }); }
    pause() { h.trace.push({ event: 'pause', account: this.accountId }); }
    destroy() { this._destroyed = true; h.trace.push({ event: 'destroy', account: this.accountId }); }
    get state() { return { phase: this._phase }; }
  },
}));
h.headers = {};

vi.mock('../../../../src/services/authUtils', () => ({
  hasValidCredentials: account => !h.invalid.has(account.id),
  ensureFreshToken: account => Promise.resolve(account),
}));
vi.mock('../../../../src/services/api', () => ({ fetchMailboxes: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../../src/services/transport', () => ({
  send: vi.fn(async (method, params) => {
    if (method !== 'policy.accounts') throw new Error(`unexpected ${method}`);
    if (h.policyDelay) await h.policyDelay.promise;
    return { accounts: Object.fromEntries(params.accounts.map(account => {
      const policy = h.policies[account.id];
      if (policy === 'throw') throw new Error('daemon unavailable');
      return [account.id, { fetch: policy === undefined ? null : policy, transfer: null }];
    })) };
  }),
}));
vi.mock('../../../../src/stores/mailStore', () => ({
  useMailStore: { getState: () => h.mail, setState: vi.fn(), subscribe: () => () => {} },
}));
vi.mock('../../../../src/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ hiddenAccounts: h.hidden }), subscribe: () => () => {} },
}));
vi.mock('../../../../src/services/db', () => ({
  getVaultUidSets: vi.fn(async (accountId, mailbox) => {
    const key = `${accountId}:${mailbox}`;
    return key in h.vault ? h.vault[key] : { saved: new Set(), archived: new Set() };
  }),
  getBodyIndexedUids: vi.fn(async (accountId, mailbox) => {
    const set = h.indexed[`${accountId}:${mailbox}`];
    return set === undefined ? null : new Set(set);
  }),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  getCachedMailboxes: vi.fn(async accountId => h.cachedMailboxes[accountId] ?? null),
}));
vi.mock('../../../../src/services/graphConfig', () => ({
  isGraphAccount: () => false, graphFoldersToMailboxes: () => [],
}));
vi.mock('../../../../src/utils/sentFolder', async importOriginal => ({
  ...(await importOriginal()),
  waitForSentMailboxPath: vi.fn(async () => h.waitSent),
}));
vi.mock('../../../../src/services/downloadCapWatch', () => ({ downloadCapChanged: () => false }));

const accountState = create(() => ({ activeAccountId: null, accounts: [] }));
const listState = create(() => ({ emails: [] }));
const syncState = create(() => ({ loading: false }));
vi.mock('../../../../src/stores/accountStore', () => ({ useAccountStore: accountState }));
vi.mock('../../../../src/stores/messageListStore', () => ({ useMessageListStore: listState }));
vi.mock('../../../../src/stores/syncStore', () => ({ useSyncStore: syncState }));

const { pipelineManager } = await import('../../../../src/services/EmailPipelineManager');
const { usePipelineCoordinator } = await import('../../../../src/hooks/usePipelineCoordinator');
const { fetchesAhead } = await import('../../../../src/services/accountPolicy');
const { findSentMailboxPath } = await import('../../../../src/utils/sentFolder');

const FIXTURE = 'src-core/tests/fixtures/pipeline-cases.json';
const PROVENANCE = 'src-core/tests/fixtures/pipeline-cases.provenance.json';
const SOURCES = ['src/services/EmailPipelineManager.js', 'src/services/AccountPipeline.js',
  'src/hooks/usePipelineCoordinator.js', 'src/services/accountPolicy.js', 'src/utils/sentFolder.js',
  'src/stores/slices/unifiedHelpers.js'];
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));

const fetchAll = { mode: 'hoarder', windowMonths: 0, keep: 'all', keepSinceMs: null };
const fetchNone = { mode: 'onDemand', windowMonths: 0, keep: 'none', keepSinceMs: null };
const since = (mode, ms) => ({ mode, windowMonths: 3, keep: 'since', keepSinceMs: ms });
const CUTOFF = Date.parse('2026-07-01T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.trace.length = 0; h.instances.length = 0; h.gates.clear(); h.complete.clear();
  h.policies = {}; h.policyDelay = null; h.hidden = {}; h.indexed = {}; h.vault = {};
  h.cachedMailboxes = {}; h.waitSent = 'Sent'; h.invalid = new Set(); h.headers = {};
  pipelineManager.pipelines.clear();
  pipelineManager._activeAccountId = null;
  pipelineManager._destroyed = false;
  pipelineManager._backgroundHeadersRunning = false;
  pipelineManager._backgroundContentRunning = false;
  pipelineManager._contentCascadeDone.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async (turns = 12) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };

function uidsOf(trace, event) {
  return trace.filter(entry => entry.event === event).map(entry => ({ ...entry }));
}

it('captures the real EmailPipelineManager, coordinator and Sent lookup behavior', async () => {
  const corpus = { candidates: [], scope: [], sent: [], headerChunks: null, contentCascade: [], coordinator: null,
    constants: {} };

  // ── 1. Candidate selection: _keptUids + _getUncachedUids over real fetchesAhead ──
  const day = n => `2026-0${n}-10T12:00:00Z`;
  const rows = [
    { uid: 1, date: '2026-08-10T12:00:00Z' },                        // inside the window
    { uid: 2, date: '2026-05-10T12:00:00Z' },                        // outside the window
    { uid: 3, date: 'Mon, 05 Jan 2026 10:00:00 +0000' },             // RFC 2822, outside
    { uid: 4, date: 'Tue, 11 Aug 2026 10:00:00 +0000 (UTC)' },       // RFC 2822 with a comment, inside
    { uid: 5, date: 'not a date' },                                  // unknown date: kept
    { uid: 6 },                                                      // no date at all: kept
    { uid: 7, date: '', internalDate: '2026-08-01T00:00:00Z' },      // empty date falls to internalDate, inside
    { uid: 8, date: '', internalDate: '2026-01-01T00:00:00Z' },      // falls to internalDate, outside
    { uid: 9, date: null, internalDate: 'garbage' },                 // both unusable: kept
    { uid: 10, date: '2026-07-01T00:00:00.000Z' },                   // exactly the cutoff: kept
    { uid: 11, date: '2026-06-30T23:59:59.999Z' },                   // one ms before: dropped
    { uid: 12, date: '2026-08-10T12:00:00Z', internalDate: '2020-01-01T00:00:00Z' }, // date wins
    { uid: 13, date: 1788000000000 },                                // ms number inside
    { uid: 14, date: 1700000000000 },                                // ms number outside
  ];
  const candidateCases = [
    ['hoarder-keeps-all', fetchAll, [3], null],
    ['keep-recent-window', since('keepRecent', CUTOFF), [], null],
    ['keep-recent-saved-excluded', since('keepRecent', CUTOFF), [1, 4, 10], null],
    ['index-only-indexed-counts-as-kept', since('indexOnly', CUTOFF), [1], [4, 10, 13]],
    ['index-only-index-unknown-vault-alone', since('indexOnly', CUTOFF), [1], 'unknown'],
    ['index-only-empty-index', since('indexOnly', CUTOFF), [1], []],
    ['keep-recent-ignores-index', since('keepRecent', CUTOFF), [1], [4, 10]],
    ['on-demand-fetches-nothing', fetchNone, [], null],
    ['hidden-or-unavailable-policy', null, [], null],
    ['window-zero-index-only-keeps-all', { mode: 'indexOnly', windowMonths: 0, keep: 'all', keepSinceMs: null }, [], null],
  ];
  for (const [name, policy, saved, indexed] of candidateCases) {
    h.indexed['acc:INBOX'] = indexed === null || indexed === 'unknown' ? undefined : indexed;
    const kept = await pipelineManager._keptUids('acc', 'INBOX', new Set(saved), policy);
    const uids = pipelineManager._getUncachedUids(copy(rows), kept, policy);
    corpus.candidates.push({ name, input: { policy: copy(policy), rows: copy(rows), saved, indexed },
      output: { kept: [...kept].sort((a, b) => a - b), uids } });
  }
  // fetchesAhead on its own, so the Rust KeepBodies mapping is pinned per date form.
  corpus.fetchesAhead = [fetchAll, fetchNone, since('keepRecent', CUTOFF), null].flatMap(policy =>
    [NaN, CUTOFF - 1, CUTOFF, CUTOFF + 1].map(dateMs => ({ policy: copy(policy),
      dateMs: Number.isNaN(dateMs) ? 'NaN' : dateMs, output: fetchesAhead(policy, dateMs) })));

  // ── 2. Scope: the real startActiveAccountPipeline scoping block ──
  pipelineManager._loadSentHeaders = vi.fn();
  pipelineManager._startBackgroundHeadersOnly = vi.fn();
  const A = { id: 'luke', email: 'luke@x' };
  const B = { id: 'yoda', email: 'yoda@x' };
  const row = (uid, extra = {}) => ({ uid, date: '2026-08-10T12:00:00Z', ...extra });
  const scopeCases = [
    ['ordinary-folder', 'luke', { accounts: [A, B], activeMailbox: 'INBOX', emails: [row(1), row(2), row(3)],
      savedEmailIds: new Set(['luke:INBOX:2']) }, { luke: fetchAll }],
    ['ordinary-non-inbox', 'luke', { accounts: [A], activeMailbox: 'Archive', emails: [row(5), row(6)],
      savedEmailIds: new Set() }, { luke: fetchAll }],
    ['unified-own-rows-only-same-uid-in-two-accounts', 'luke', { accounts: [A, B], activeMailbox: 'UNIFIED',
      emails: [row(7, { _accountId: 'luke', _mailbox: 'INBOX' }), row(7, { _accountId: 'yoda', _mailbox: 'INBOX' }),
        row(910, { _accountId: 'yoda', _mailbox: 'INBOX' })], savedEmailIds: new Set() }, { luke: fetchAll, yoda: fetchAll }],
    ['unified-yoda-active-same-uid', 'yoda', { accounts: [A, B], activeMailbox: 'UNIFIED',
      emails: [row(7, { _accountId: 'luke', _mailbox: 'INBOX' }), row(7, { _accountId: 'yoda', _mailbox: 'Archive' })],
      savedEmailIds: new Set() }, { luke: fetchAll, yoda: fetchAll }],
    ['unified-no-own-rows-falls-back-to-inbox', 'luke', { accounts: [A, B], activeMailbox: 'UNIFIED',
      emails: [row(1, { _accountId: 'yoda', _mailbox: 'Archive' })], savedEmailIds: new Set() }, { luke: fetchAll }],
    ['unified-saved-set-is-keyed-by-the-resolved-mailbox', 'luke', { accounts: [A], activeMailbox: 'UNIFIED',
      emails: [row(7, { _accountId: 'luke', _mailbox: 'INBOX' }), row(8, { _accountId: 'luke', _mailbox: 'INBOX' })],
      savedEmailIds: new Set(['luke:Sent:7', 'luke:INBOX:8']) }, { luke: fetchAll }],
    ['subtree-root-rows-only', 'luke', { accounts: [A], activeMailbox: 'Projects',
      mailboxScope: { root: 'Projects', paths: ['Projects', 'Projects/Child'] },
      emails: [row(1), row(2, { _mailbox: 'Projects' }), row(3, { _mailbox: 'Projects/Child' }), row(4, { _mailbox: 'Projects/Child' })],
      savedEmailIds: new Set(['luke:Projects:2']) }, { luke: fetchAll }],
    ['keep-recent-window-in-the-active-folder', 'luke', { accounts: [A], activeMailbox: 'INBOX',
      emails: [row(1), row(2, { date: '2026-01-01T00:00:00Z' }), row(3, { date: 'garbage' })],
      savedEmailIds: new Set() }, { luke: since('keepRecent', CUTOFF) }],
    ['index-only-active-uses-the-index', 'luke', { accounts: [A], activeMailbox: 'INBOX',
      emails: [row(1), row(2), row(3)], savedEmailIds: new Set(['luke:INBOX:1']) },
      { luke: since('indexOnly', CUTOFF) }, { 'luke:INBOX': [2] }],
    ['on-demand-fetches-nothing-ahead', 'luke', { accounts: [A], activeMailbox: 'INBOX', emails: [row(1)],
      savedEmailIds: new Set() }, { luke: fetchNone }],
    ['policy-unavailable-fetches-nothing', 'luke', { accounts: [A], activeMailbox: 'INBOX', emails: [row(1)],
      savedEmailIds: new Set() }, { luke: 'throw' }],
    ['hidden-account-starts-nothing', 'luke', { accounts: [A], activeMailbox: 'INBOX', emails: [row(1)],
      savedEmailIds: new Set() }, { luke: fetchAll }, {}, { hidden: { luke: true } }],
    ['no-credentials-starts-nothing', 'luke', { accounts: [A], activeMailbox: 'INBOX', emails: [row(1)],
      savedEmailIds: new Set() }, { luke: fetchAll }, {}, { invalid: ['luke'] }],
    ['unknown-account-starts-nothing', 'ghost', { accounts: [A], activeMailbox: 'INBOX', emails: [row(1)],
      savedEmailIds: new Set() }, { luke: fetchAll }],
    ['empty-list-still-completes-with-no-uids', 'luke', { accounts: [A], activeMailbox: 'INBOX', emails: [],
      savedEmailIds: new Set() }, { luke: fetchAll }],
  ];
  for (const [name, accountId, state, policies, indexed = {}, extra = {}] of scopeCases) {
    h.trace.length = 0; h.instances.length = 0; pipelineManager.pipelines.clear();
    pipelineManager._activeAccountId = null;
    h.mail = { ...state, getSentMailboxPath: () => 'Sent' };
    h.policies = policies; h.indexed = indexed; h.hidden = extra.hidden || {}; h.invalid = new Set(extra.invalid || []);
    await pipelineManager.startActiveAccountPipeline(accountId);
    const started = uidsOf(h.trace, 'startContentCaching');
    corpus.scope.push({ name, input: { accountId, activeMailbox: state.activeMailbox,
      mailboxScope: state.mailboxScope || null,
      rows: state.emails.map(r => ({ uid: r.uid, date: r.date ?? null, internalDate: r.internalDate ?? null,
        accountId: r._accountId ?? null, mailbox: r._mailbox ?? null })),
      saved: [...state.savedEmailIds], policy: policies[accountId] === 'throw' ? 'unavailable' : (policies[accountId] ?? null),
      indexed: indexed[`${accountId}:INBOX`] ?? null, hidden: !!h.hidden[accountId], noCredentials: h.invalid.has(accountId) },
    output: { started: started.map(e => ({ mailbox: e.mailbox, uids: e.uids })),
      concurrency: uidsOf(h.trace, 'construct').map(e => e.concurrency) } });
  }

  // A pipeline reused only when idle; a busy one is rebuilt; a newer activation wins.
  {
    h.mail = { accounts: [A, B], activeMailbox: 'INBOX', emails: [row(1)], savedEmailIds: new Set(), getSentMailboxPath: () => 'Sent' };
    h.policies = { luke: fetchAll, yoda: fetchAll };
    h.trace.length = 0; h.instances.length = 0; pipelineManager.pipelines.clear();
    await pipelineManager.startActiveAccountPipeline('luke');
    const first = h.instances[0];
    first._activeSlots = 0;
    await pipelineManager.startActiveAccountPipeline('luke');
    const reusedIdle = h.instances.length === 1;
    first._activeSlots = 2;
    await pipelineManager.startActiveAccountPipeline('luke');
    const rebuiltBusy = h.instances.length === 2 && first._destroyed;
    h.trace.length = 0; h.instances.length = 0; pipelineManager.pipelines.clear();
    h.policyDelay = deferred();
    const slow = pipelineManager.startActiveAccountPipeline('luke');
    await flush();
    const fast = pipelineManager.startActiveAccountPipeline('yoda');
    h.policyDelay.resolve();
    await Promise.all([slow, fast]);
    h.policyDelay = null;
    corpus.activation = { reusedIdle, rebuiltBusy,
      newerActivationWins: uidsOf(h.trace, 'startContentCaching').map(e => e.account) };
  }

  // ── 3. Sent lookup: the real findSentMailboxPath ──
  const box = (path, extra = {}) => ({ path, name: path.split('/').pop(), ...extra });
  const lists = [
    ['special-use-wins', [box('INBOX'), box('Gesendet', { specialUse: '\\Sent' })], null],
    ['override-existing-wins', [box('INBOX'), box('Sent', { specialUse: '\\Sent' }), box('Mine')], 'Mine'],
    ['override-missing-falls-back', [box('Sent Items')], 'Gone'],
    ['name-pattern', [box('INBOX'), box('Sent Items')], null],
    ['localized-name', [box('INBOX'), box('Enviados')], null],
    ['nested-special-use', [box('INBOX'), { path: '[Gmail]', name: '[Gmail]', children: [box('[Gmail]/Sent Mail', { specialUse: '\\Sent' })] }], null],
    ['nested-name', [box('INBOX'), { path: 'Mail', name: 'Mail', children: [box('Mail/Sent')] }], null],
    ['outbox-counts', [box('Outbox')], null],
    ['none', [box('INBOX'), box('Archive')], null],
    ['empty-list', [], null],
    ['no-list', null, null],
  ];
  for (const [name, list, override] of lists) {
    corpus.sent.push({ name, input: { mailboxes: copy(list), override }, output: findSentMailboxPath(copy(list), override) });
  }

  // ── 4. Background headers: chunks of 3, one worker each, Sent after INBOX ──
  {
    const ids = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'hid', 'bad'];
    const accounts = ids.map(id => ({ id, email: `${id}@x` }));
    h.mail = { accounts, activeMailbox: 'INBOX', emails: [], savedEmailIds: new Set(), activeAccountId: 'a0',
      getSentMailboxPath: () => null };
    h.hidden = { hid: true }; h.invalid = new Set(['bad']);
    h.cachedMailboxes = { a1: [box('INBOX'), box('Sent', { specialUse: '\\Sent' })], a2: [box('INBOX'), box('Sent Items')],
      a3: [box('INBOX'), box('Mine')], a4: [box('INBOX')], a5: null };
    accounts[3].sentFolderOverride = 'Mine';
    pipelineManager._loadSentHeaders = Object.getPrototypeOf(pipelineManager)._loadSentHeaders.bind(pipelineManager);
    pipelineManager._publishSent = () => {};
    pipelineManager._activeAccountId = 'a0';
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) h.gates.set(`${id}:INBOX`, deferred());
    h.trace.length = 0; h.instances.length = 0;
    const running = pipelineManager._startBackgroundHeadersOnly = Object.getPrototypeOf(pipelineManager)._startBackgroundHeadersOnly.bind(pipelineManager);
    const run = running();
    await flush(30);
    const steps = [];
    const snapshot = label => steps.push({ label, started: uidsOf(h.trace, 'loadHeaders').map(e => `${e.account}:${e.mailbox}`) });
    snapshot('before-any-inbox-finishes');
    for (const id of ['a1', 'a2']) { h.gates.get(`${id}:INBOX`).resolve(); await flush(30); }
    snapshot('two-of-the-first-three-finished');
    h.gates.get('a3:INBOX').resolve(); await flush(60);
    snapshot('first-chunk-finished');
    for (const id of ['a4', 'a5']) { h.gates.get(`${id}:INBOX`).resolve(); await flush(30); }
    await run;
    snapshot('all-finished');
    corpus.headerChunks = { accounts: ids, excluded: ['a0 (active)', 'hid (hidden)', 'bad (no credentials)'], steps,
      concurrency: uidsOf(h.trace, 'construct').map(e => `${e.account}:${e.concurrency}`),
      finalOrder: uidsOf(h.trace, 'loadHeaders').map(e => `${e.account}:${e.mailbox}`) };
  }

  // ── 5. Background content: sequential, one account at a time, kept-set keyed by INBOX ──
  {
    const accounts = ['c1', 'c2', 'c3', 'c4'].map(id => ({ id, email: `${id}@x` }));
    h.mail = { accounts: [{ id: 'c0', email: 'c0@x' }, ...accounts], activeAccountId: 'c0', activeMailbox: 'INBOX',
      emails: [], savedEmailIds: new Set(), getSentMailboxPath: () => null };
    h.policies = { c1: since('keepRecent', CUTOFF), c2: fetchAll, c3: fetchAll, c4: fetchNone };
    h.vault = { 'c1:INBOX': { saved: new Set([1]), archived: new Set() }, 'c2:INBOX': { saved: new Set(), archived: new Set() },
      'c3:INBOX': null, 'c4:INBOX': { saved: new Set(), archived: new Set() } };
    h.trace.length = 0; h.instances.length = 0; pipelineManager.pipelines.clear();
    pipelineManager._activeAccountId = 'c0';
    const inboxRows = [{ uid: 1, date: '2026-08-10T12:00:00Z' }, { uid: 2, date: '2026-08-11T12:00:00Z' },
      { uid: 3, date: '2026-01-01T00:00:00Z' }];
    const sentRows = [{ uid: 7, date: '2026-08-10T12:00:00Z' }, { uid: 8, date: '2026-08-10T12:00:00Z' }];
    for (const [id, loaded] of [['c1', inboxRows], ['c2', inboxRows], ['c3', inboxRows], ['c4', inboxRows]]) {
      const pipeline = new (await import('../../../../src/services/AccountPipeline')).AccountPipeline({ id, email: `${id}@x` }, { concurrency: 1 });
      pipeline._lastLoadedEmails = loaded.map(r => ({ ...r }));
      pipelineManager.pipelines.set(id, pipeline);
    }
    h.trace.length = 0; h.instances.length = 0;
    h.complete.set('c1', deferred());
    const first = pipelineManager._startBackgroundContentPipelines();
    await flush(40);
    const midFlight = uidsOf(h.trace, 'startContentCaching').map(e => e.account);
    h.complete.get('c1').resolve();
    await first;
    const firstWalk = uidsOf(h.trace, 'startContentCaching').map(e => ({ account: e.account, mailbox: e.mailbox, uids: e.uids }));
    const done = [...pipelineManager._contentCascadeDone].sort();
    h.trace.length = 0;
    await pipelineManager._startBackgroundContentPipelines();
    const secondWalk = uidsOf(h.trace, 'startContentCaching').map(e => ({ account: e.account, uids: e.uids }));
    // The original trace of the shared-rows overwrite: Sent rows loaded last feed INBOX content.
    h.trace.length = 0; pipelineManager._contentCascadeDone.clear();
    pipelineManager.pipelines.get('c2')._lastLoadedEmails = sentRows.map(r => ({ ...r }));
    h.policies = { c2: fetchAll };
    await pipelineManager._startBackgroundContentPipelines();
    const legacy = uidsOf(h.trace, 'startContentCaching').filter(e => e.account === 'c2').map(e => ({ mailbox: e.mailbox, uids: e.uids }));
    corpus.contentCascade = { midFlightStarted: midFlight, cascadeDone: done, secondWalkStarted: secondWalk,
      firstWalkStarts: firstWalk, legacySentRowsFeedInboxContent: legacy,
      note: 'c3 has an unknown vault and is skipped unmarked; c4 (on demand) is walked with no uids' };
  }

  // ── 6. The coordinator hook: 200ms start delay, switch, cache-empty reset, online/offline ──
  {
    vi.useFakeTimers();
    const calls = [];
    const original = {};
    for (const name of ['startActiveAccountPipeline', 'onAccountSwitch', 'syncAccounts', 'pauseAll', 'resumeAll', 'destroyAll', 'watchTransferLimits']) {
      original[name] = pipelineManager[name];
      pipelineManager[name] = (...args) => { calls.push({ call: name, at: Date.now() - t0, args: name === 'syncAccounts' ? [args[0].map(a => a.id)] : args.filter(a => typeof a === 'string') }); return () => {}; };
    }
    const t0 = Date.now();
    const starts = () => calls.filter(c => c.call === 'startActiveAccountPipeline').length;
    const set = async change => { await act(async () => { change(); }); };
    const wait = async ms => { await act(async () => { vi.advanceTimersByTime(ms); }); };
    accountState.setState({ activeAccountId: 'a', accounts: [{ id: 'a' }, { id: 'b' }] });
    listState.setState({ emails: [] }); syncState.setState({ loading: false });
    const hook = renderHook(() => usePipelineCoordinator());
    await wait(500);
    const startsWithNoEmails = starts();
    await set(() => listState.setState({ emails: [{ uid: 1 }] }));
    await wait(199);
    const startsAt199ms = starts();
    await wait(1);
    const startsAt200ms = starts();
    await set(() => listState.setState({ emails: [{ uid: 1 }, { uid: 2 }] }));
    await wait(600);
    const startsAfterSameAccountEmailsChange = starts();
    await set(() => listState.setState({ emails: [] }));
    await set(() => listState.setState({ emails: [{ uid: 3 }] }));
    await wait(200);
    const startsAfterCacheEmptyReset = starts();
    await set(() => syncState.setState({ loading: true }));
    await set(() => listState.setState({ emails: [{ uid: 4 }, { uid: 5 }] }));
    await wait(600);
    const startsWhileSyncing = starts();
    await set(() => syncState.setState({ loading: false }));
    await wait(200);
    const startsWhenSyncEnds = starts();
    const beforeSwitch = calls.length;
    await set(() => accountState.setState({ activeAccountId: 'b' }));
    await wait(300);
    const afterSwitchPlus300ms = calls.slice(beforeSwitch).map(c => `${c.call}:${c.args.join(',')}`);
    await set(() => listState.setState({ emails: [] }));
    await set(() => listState.setState({ emails: [{ uid: 9 }] }));
    await wait(200);
    const afterSwitchThenListReload = calls.slice(beforeSwitch).map(c => `${c.call}:${c.args.join(',')}`);
    await set(() => accountState.setState({ accounts: [{ id: 'b' }] }));
    await act(async () => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
    hook.unmount();
    corpus.coordinator = { startDelayMs: 200, startsWithNoEmails, startsAt199ms, startsAt200ms,
      startsAfterSameAccountEmailsChange, startsAfterCacheEmptyReset, startsWhileSyncing, startsWhenSyncEnds,
      afterSwitchPlus300ms, afterSwitchThenListReload,
      otherCalls: calls.filter(c => ['syncAccounts', 'pauseAll', 'resumeAll', 'destroyAll'].includes(c.call))
        .map(c => `${c.call}${c.call === 'syncAccounts' ? ':' + c.args[0].join(',') : ''}`) };
    Object.assign(pipelineManager, original);
  }

  corpus.constants = { activeWorkers: 3, backgroundHeaderWorkers: 1, backgroundHeaderChunk: 3, backgroundContentWorkers: 1,
    activationDelayMs: 200 };

  if (process.env.MV_PIPELINE_CAPTURE === '1') {
    const text = JSON.stringify(corpus, null, 1);
    process.stdout.write('PIPELINE_FIXTURE_BEGIN\n' + Buffer.from(text).toString('base64') + '\nPIPELINE_FIXTURE_END\n');
    process.stdout.write('PIPELINE_PROVENANCE ' + JSON.stringify(Object.fromEntries(SOURCES.map(p => [p, sha(p)]))) + '\n');
    return;
  }
  const frozen = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  expect(corpus).toEqual(frozen);
  const provenance = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  // The corpus is only a parity oracle while these sources are the ones it was taken from.
  for (const path of SOURCES) expect(sha(path), path).toBe(provenance.sources[path]);
});
