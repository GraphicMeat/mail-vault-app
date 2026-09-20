import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  mailState: null,
  settingsState: null,
  started: [],
  startMailSearch: vi.fn(),
  cancelMailSearch: vi.fn(),
  buildSearchTargets: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('../mailStore', () => ({ useMailStore: { getState: () => harness.mailState } }));
vi.mock('../settingsStore', () => ({
  useSettingsStore: { getState: () => harness.settingsState },
  effectiveSearchMailboxConcurrency: state => (state?.billingProfile?.premiumAccess
    ? Math.max(1, Math.min(5, Number(state.searchMailboxConcurrency) || 3))
    : 1),
}));
vi.mock('../../services/mailSearch.js', () => ({
  startMailSearch: (...args) => harness.startMailSearch(...args),
  cancelMailSearch: (...args) => harness.cancelMailSearch(...args),
}));
vi.mock('../../services/searchTargets.js', () => ({
  buildSearchTargets: (...args) => harness.buildSearchTargets(...args),
}));
vi.mock('../../services/authUtils', () => ({
  hasValidCredentials: () => false,
  ensureFreshToken: async account => account,
}));
vi.mock('../../services/db', () => ({ searchLocalEmails: async () => [] }));
vi.mock('../../services/api', () => ({ searchEmails: async () => ({ emails: [], total: 0 }) }));

const { useSearchStore } = await import('../searchStore.js');

const DEFAULT_FILTERS = {
  location: 'all', folder: 'current', sender: '', dateFrom: null, dateTo: null, hasAttachments: false,
};
const account = { id: 'acct-1', email: 'a@example.test', password: 'secret' };
const mailbox = (path) => ({ path, name: path, delimiter: '.', children: [] });
const result = (uid, subject, extra = {}) => ({
  uid, subject, from: { address: 'sender@example.test' }, date: '2026-09-19T12:00:00Z', ...extra,
});
const progress = (run, sequence, extra = {}) => run.onProgress({
  searchId: run.request.searchId,
  sequence,
  lane: 'local',
  rows: [],
  completed: 0,
  total: 1,
  localMode: null,
  fallbackReason: null,
  coverage: null,
  failures: [],
  terminal: null,
  errorKey: null,
  ...extra,
});

async function startSearch(query, filterOverrides = {}) {
  useSearchStore.setState({
    searchQuery: query,
    searchFilters: { ...DEFAULT_FILTERS, ...filterOverrides },
  });
  await useSearchStore.getState().performSearch();
  return harness.started.at(-1);
}

describe('daemon-backed search lifecycle', () => {
  beforeEach(() => {
    useSearchStore.getState().clearSearch();
    harness.mailState = {
      activeAccountId: 'acct-1',
      activeMailbox: 'INBOX',
      unifiedInbox: false,
      unifiedFolder: 'INBOX',
      accounts: [account],
      mailboxes: [mailbox('INBOX')],
      emails: [],
      savedEmailIds: new Set(),
      backedUpKeys: new Set(),
      backedUpScopes: new Set(),
      backupConfigured: false,
      requestSettingsTab: vi.fn(),
    };
    harness.settingsState = {
      billingProfile: { hasSubscription: true, premiumAccess: true },
      searchMailboxConcurrency: 3,
      addSearchToHistory: vi.fn(),
    };
    harness.started = [];
    harness.startMailSearch.mockReset().mockImplementation(async (request, onProgress, onReconnect) => {
      const run = { request, onProgress, onReconnect, unlisten: vi.fn() };
      harness.started.push(run);
      return { unlisten: run.unlisten };
    });
    harness.cancelMailSearch.mockReset().mockResolvedValue(undefined);
    harness.buildSearchTargets.mockReset().mockImplementation(async () => [{
      accountId: 'acct-1', account, localMailboxes: null, knownMailboxes: ['INBOX'], serverMailboxes: ['INBOX'],
    }]);
    useSearchStore.setState({
      searchQuery: '',
      searchFilters: { ...DEFAULT_FILTERS },
      searchActive: false,
      searchResults: [],
      isSearching: false,
      searchProgress: null,
      searchIndexCoverage: null,
      searchFallback: null,
      searchError: null,
      activeSearchId: null,
      searchGeneration: 0,
      lastSequence: 0,
      searchSnapshot: null,
    });
  });

  it('sends normalized query filters, explicit targets, and effective concurrency', async () => {
    harness.settingsState.searchMailboxConcurrency = 5;
    const targets = [{ accountId: 'acct-1', localMailboxes: null, serverMailboxes: ['INBOX'] }];
    harness.buildSearchTargets.mockResolvedValueOnce(targets);

    const run = await startSearch('  invoice  ', {
      location: 'local', folder: 'all', sender: 'alice@example.test',
      dateFrom: '2026-09-01', dateTo: '2026-09-03', hasAttachments: true,
    });

    expect(run.request).toMatchObject({
      searchId: expect.any(String),
      query: 'invoice',
      sender: 'alice@example.test',
      dateFrom: Date.parse('2026-09-01T00:00:00Z') / 1000,
      dateTo: Date.parse('2026-09-03T23:59:59Z') / 1000,
      hasAttachments: true,
      location: 'local',
      concurrency: 5,
      targets,
    });
    expect(harness.buildSearchTargets).toHaveBeenCalledWith(
      harness.mailState,
      harness.settingsState,
      expect.objectContaining({ folder: 'all', location: 'local' }),
    );
  });

  it('searches attachment-only filters and keeps a saved Premium limit after logout', async () => {
    harness.settingsState.searchMailboxConcurrency = 5;
    harness.settingsState.billingProfile = null;

    const run = await startSearch('', { hasAttachments: true });

    expect(run.request.concurrency).toBe(1);
    expect(run.request.hasAttachments).toBe(true);
    expect(harness.settingsState.searchMailboxConcurrency).toBe(5);
  });

  it('clear invalidates synchronously and late events cannot republish rows', async () => {
    const run = await startSearch('old');
    const oldId = useSearchStore.getState().activeSearchId;
    const generationBeforeClear = useSearchStore.getState().searchGeneration;

    useSearchStore.getState().clearSearch();
    progress(run, 1, { lane: 'server', rows: [result(1, 'stale')] });

    expect(harness.cancelMailSearch).toHaveBeenCalledWith(oldId);
    expect(useSearchStore.getState().searchGeneration).toBeGreaterThan(generationBeforeClear);
    expect(useSearchStore.getState().activeSearchId).toBeNull();
    expect(useSearchStore.getState().searchResults).toEqual([]);
    expect(useSearchStore.getState().searchActive).toBe(false);
  });

  it('ignores obsolete and non-increasing frames while merging local then server rows', async () => {
    const run = await startSearch('invoice');
    const id = run.request.searchId;

    progress(run, 1, { searchId: 'previous-run', rows: [result(10, 'obsolete')] });
    progress(run, 1, { lane: 'local', rows: [result(1, 'local')] });
    progress(run, 1, { lane: 'server', rows: [result(2, 'duplicate-sequence')] });
    progress(run, 0, { lane: 'server', rows: [result(3, 'out-of-order')] });
    progress(run, 2, { lane: 'server', rows: [result(4, 'server')] });

    expect(useSearchStore.getState().activeSearchId).toBe(id);
    expect(useSearchStore.getState().searchResults.map(row => row.subject)).toEqual(['local', 'server']);
    expect(useSearchStore.getState().lastSequence).toBe(2);
  });

  it('stops at the terminal frame and writes history once for the active run', async () => {
    const run = await startSearch('invoice');

    progress(run, 1, { rows: [result(7, 'done')], completed: 1, total: 1, terminal: 'complete' });
    progress(run, 1, { rows: [result(8, 'duplicate terminal')], terminal: 'complete' });

    expect(useSearchStore.getState().isSearching).toBe(false);
    expect(useSearchStore.getState().searchProgress).toBeNull();
    expect(useSearchStore.getState().searchResults.map(row => row.subject)).toEqual(['done']);
    expect(harness.settingsState.addSearchToHistory).toHaveBeenCalledTimes(1);
    expect(harness.settingsState.addSearchToHistory).toHaveBeenCalledWith('invoice');
  });

  it('releases the active event listener when the daemon run terminates', async () => {
    const run = await startSearch('invoice');

    progress(run, 1, { terminal: 'complete' });

    expect(run.unlisten).toHaveBeenCalledOnce();
  });

  it('releases a listener when terminal progress races the start acknowledgement', async () => {
    let acknowledgeStart;
    harness.startMailSearch.mockImplementation((request, onProgress) => {
      const run = { request, onProgress, unlisten: vi.fn() };
      harness.started.push(run);
      return new Promise(resolve => { acknowledgeStart = () => resolve({ unlisten: run.unlisten }); });
    });
    useSearchStore.setState({ searchQuery: 'invoice' });

    const pendingStart = useSearchStore.getState().performSearch();
    await Promise.resolve();
    const run = harness.started[0];
    progress(run, 1, { terminal: 'complete' });
    acknowledgeStart();
    await pendingStart;

    expect(run.unlisten).toHaveBeenCalledOnce();
  });

  it('cancels again after start acknowledgement if Clear raced registration', async () => {
    let acknowledgeStart;
    harness.startMailSearch.mockImplementation((request, onProgress) => {
      const run = { request, onProgress, unlisten: vi.fn() };
      harness.started.push(run);
      return new Promise(resolve => { acknowledgeStart = () => resolve({ unlisten: run.unlisten }); });
    });
    useSearchStore.setState({ searchQuery: 'invoice' });

    const pendingStart = useSearchStore.getState().performSearch();
    await Promise.resolve();
    const run = harness.started[0];
    useSearchStore.getState().clearSearch();
    expect(harness.cancelMailSearch).toHaveBeenCalledTimes(1);
    acknowledgeStart();
    await pendingStart;

    expect(harness.cancelMailSearch).toHaveBeenCalledTimes(2);
    expect(harness.cancelMailSearch).toHaveBeenNthCalledWith(2, run.request.searchId);
    expect(run.unlisten).toHaveBeenCalledOnce();
  });

  it('preserves published rows and exposes the error key when every source fails', async () => {
    const run = await startSearch('invoice');
    progress(run, 1, { rows: [result(8, 'partial result')] });
    progress(run, 2, { terminal: 'error', errorKey: 'errors.searchFailed' });

    expect(useSearchStore.getState().searchResults.map(row => row.subject)).toEqual(['partial result']);
    expect(useSearchStore.getState().searchError).toBe('errors.searchFailed');
    expect(useSearchStore.getState().isSearching).toBe(false);
  });

  it('surfaces the local scan fallback and retains it across server progress', async () => {
    const run = await startSearch('invoice');
    const coverage = { indexed: 20, total: 100, complete: false, matched: 4, shown: 4 };
    progress(run, 1, { localMode: 'scan', fallbackReason: 'building', coverage });
    progress(run, 2, { lane: 'server', rows: [result(9, 'server')] });

    expect(useSearchStore.getState().searchFallback).toBe('building');
    expect(useSearchStore.getState().searchIndexCoverage).toEqual(coverage);
    expect(useSearchStore.getState().searchResults.map(row => row.subject)).toEqual(['server']);
  });

  it('replaces cumulative indexed snapshots per account while retaining other sources', async () => {
    const run = await startSearch('invoice');
    const row = (uid, subject, accountId, day, source = 'local') => result(uid, subject, {
      _accountId: accountId, _mailbox: 'INBOX', source, messageId: `<${uid}@${accountId}.test>`,
      date: `2026-09-${String(day).padStart(2, '0')}T12:00:00Z`,
    });
    progress(run, 1, { rows: [row(1, 'account one old', 'acct-1', 1)], lane: 'local', localMode: 'index', replaceIndexAccountId: 'acct-1' });
    progress(run, 2, { rows: [row(7, 'account two', 'acct-2', 2)], lane: 'local', localMode: 'index', replaceIndexAccountId: 'acct-2' });
    progress(run, 3, { rows: [row(2, 'fallback from account one', 'acct-1', 4)], lane: 'local', localMode: 'scan' });
    progress(run, 4, { rows: [row(3, 'account one newest', 'acct-1', 5)], lane: 'local', localMode: 'index', replaceIndexAccountId: 'acct-1' });
    progress(run, 5, { rows: [row(9, 'server', 'acct-1', 3, 'server-search')], lane: 'server' });

    expect(useSearchStore.getState().searchResults.map(row => row.subject)).toEqual([
      'account one newest', 'fallback from account one', 'server', 'account two',
    ]);
  });

  it('rejects an indexed snapshot that names a different account than its rows', async () => {
    const run = await startSearch('invoice');
    const row = (uid, subject, accountId) => result(uid, subject, {
      _accountId: accountId, _mailbox: 'INBOX', source: 'local', messageId: `<${uid}@${accountId}.test>`,
    });
    const indexed = { lane: 'local', localMode: 'index' };
    progress(run, 1, { ...indexed, rows: [row(1, 'kept snapshot', 'acct-1')], replaceIndexAccountId: 'acct-1' });
    progress(run, 2, { ...indexed, rows: [row(2, 'wrong account', 'acct-2')], replaceIndexAccountId: 'acct-1' });

    expect(useSearchStore.getState().lastSequence).toBe(1);
    expect(useSearchStore.getState().searchResults.map(email => email.subject)).toEqual(['kept snapshot']);
  });

  it('surfaces an incomplete available index as building before the fallback scan arrives', async () => {
    const run = await startSearch('invoice');
    const coverage = { indexed: 20, total: 100, complete: false, matched: 4, shown: 4 };
    progress(run, 1, { localMode: 'index', fallbackReason: 'building', coverage });

    expect(useSearchStore.getState().searchFallback).toBe('building');
    expect(useSearchStore.getState().searchIndexCoverage).toEqual(coverage);
  });

  it('cancels a previous query and ignores its late frames', async () => {
    const oldRun = await startSearch('old query');
    const newRun = await startSearch('new query');

    progress(oldRun, 1, { rows: [result(11, 'stale')] });
    progress(newRun, 1, { rows: [result(12, 'current')] });

    expect(harness.cancelMailSearch).toHaveBeenCalledWith(oldRun.request.searchId);
    expect(newRun.request.searchId).not.toBe(oldRun.request.searchId);
    expect(useSearchStore.getState().searchResults.map(row => row.subject)).toEqual(['current']);
  });

  it('restarts the acknowledged search after a daemon reconnect and ignores the lost run', async () => {
    const lostRun = await startSearch('invoice');
    progress(lostRun, 1, { rows: [result(20, 'before restart')] });

    await lostRun.onReconnect?.();

    expect(harness.started).toHaveLength(2);
    const restartedRun = harness.started[1];
    expect(harness.cancelMailSearch).toHaveBeenCalledWith(lostRun.request.searchId);
    expect(restartedRun.request.query).toBe('invoice');
    progress(lostRun, 2, { rows: [result(21, 'stale after restart')] });
    progress(restartedRun, 1, { rows: [result(22, 'current after restart')] });

    expect(useSearchStore.getState().activeSearchId).toBe(restartedRun.request.searchId);
    expect(useSearchStore.getState().searchResults.map(row => row.subject)).toEqual(['current after restart']);
  });

  it('keeps account-local message identity and dedupes copies by normalized Message-ID', async () => {
    const run = await startSearch('same message');
    progress(run, 1, { rows: [
      result(100, 'archive copy', { _accountId: 'acct-1', _mailbox: 'Archive', messageId: '<same@example.test>', source: 'local' }),
      result(7, 'inbox copy', { _accountId: 'acct-1', _mailbox: 'INBOX', messageId: 'same@example.test', source: 'local' }),
      result(7, 'other account copy', { _accountId: 'acct-2', _mailbox: 'INBOX', messageId: 'same@example.test', source: 'local' }),
    ] });

    expect(useSearchStore.getState().searchResults).toHaveLength(2);
    expect(useSearchStore.getState().searchResults.map(row => [row._accountId, row._mailbox])).toEqual([
      ['acct-1', 'INBOX'],
      ['acct-2', 'INBOX'],
    ]);
  });
});
