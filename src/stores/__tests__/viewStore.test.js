import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const harness = vi.hoisted(() => ({
  daemonCall: vi.fn(),
  mailState: null,
  cacheMailboxes: {},
}));

vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => harness.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('../mailStore', () => ({ useMailStore: { getState: () => harness.mailState } }));
vi.mock('../../services/cacheManager', () => ({
  getAccountCacheMailboxes: id => harness.cacheMailboxes[id] || [],
}));

const { useViewStore, viewLabel } = await import('../viewStore');
const { useSearchStore } = await import('../searchStore.js');
const { useFieldStore } = await import('../fieldStore');

const STARRED = { id: 'builtin-starred', name: '', icon: 'star', position: 1, builtin: 'starred', def: { starred: true } };
const MINE = { id: 'v1', name: 'Receipts', icon: 'tag', position: 3, builtin: null, def: { query: 'invoice' } };

const row = (uid, extra = {}) => ({
  uid, subject: `subject ${uid}`, from: { address: 'ann@x.test' }, date: '2026-09-19T12:00:00Z',
  _accountId: 'acct-1', _mailbox: 'INBOX', messageId: `<${uid}@x.test>`, ...extra,
});

beforeEach(() => {
  harness.daemonCall.mockReset().mockResolvedValue({});
  harness.cacheMailboxes = {
    'acct-1': [{ path: 'INBOX', name: 'INBOX' }, { path: 'Papierkorb', name: 'Papierkorb', specialUse: '\\Trash' }],
  };
  harness.mailState = {
    accounts: [{ id: 'acct-1', email: 'me@x.test' }],
    activeAccountId: 'acct-1',
    activeMailbox: 'INBOX',
    mailboxes: [],
    backedUpKeys: new Set(),
    backedUpScopes: new Set(),
    backupConfigured: false,
  };
  useViewStore.setState({ views: [], counts: {}, activeViewId: null, unavailableReason: null, loading: false });
  useSearchStore.getState().clearSearch();
});

describe('saved views', () => {
  it('loads the views the daemon keeps', async () => {
    harness.daemonCall.mockResolvedValueOnce([STARRED, MINE]);
    await useViewStore.getState().loadViews();
    expect(harness.daemonCall).toHaveBeenCalledWith('views.list', {});
    expect(useViewStore.getState().views).toEqual([STARRED, MINE]);
  });

  it('tells the daemon which folder is this account’s bin', async () => {
    harness.daemonCall.mockResolvedValueOnce({ available: true, rows: [], total: 0 });
    await useViewStore.getState().openView(STARRED);
    const [method, params] = harness.daemonCall.mock.calls[0];
    expect(method).toBe('views.evaluate');
    expect(params.viewId).toBe('builtin-starred');
    expect(params.accounts).toEqual([{
      accountId: 'acct-1',
      address: 'me@x.test',
      knownMailboxes: ['INBOX', 'Papierkorb'],
      specialUse: { '\\Trash': 'Papierkorb' },
    }]);
  });

  it('shows the rows it got through the list the search already uses', async () => {
    harness.daemonCall.mockResolvedValueOnce({ available: true, rows: [row(1), row(2)], total: 2 });
    await useViewStore.getState().openView(STARRED);
    expect(useViewStore.getState().activeViewId).toBe('builtin-starred');
    expect(useSearchStore.getState().searchActive).toBe(true);
    expect(useSearchStore.getState().searchResults.map(r => r.uid)).toEqual([1, 2]);
  });

  /// An index that cannot answer is not an empty view.
  it('says the index could not answer rather than showing an empty view', async () => {
    harness.daemonCall.mockResolvedValueOnce({ available: false, reason: 'building', rows: [] });
    await useViewStore.getState().openView(STARRED);
    expect(useViewStore.getState().unavailableReason).toBe('building');
    expect(useSearchStore.getState().searchActive).toBe(false);
  });

  it('closing a view puts the mailbox back', async () => {
    harness.daemonCall.mockResolvedValueOnce({ available: true, rows: [row(1)], total: 1 });
    await useViewStore.getState().openView(STARRED);
    useViewStore.getState().closeView();
    expect(useViewStore.getState().activeViewId).toBeNull();
    expect(useSearchStore.getState().searchActive).toBe(false);
    expect(useSearchStore.getState().searchResults).toEqual([]);
  });

  it('keeps a count per view', async () => {
    harness.daemonCall.mockResolvedValueOnce({ 'builtin-starred': 4, v1: 0 });
    await useViewStore.getState().refreshCounts();
    expect(harness.daemonCall.mock.calls[0][0]).toBe('views.counts');
    expect(useViewStore.getState().counts).toEqual({ 'builtin-starred': 4, v1: 0 });
  });

  it('saving a view reloads the list so the sidebar is never stale', async () => {
    harness.daemonCall.mockResolvedValueOnce(MINE).mockResolvedValueOnce([STARRED, MINE]);
    await useViewStore.getState().saveView(MINE);
    expect(harness.daemonCall.mock.calls[0]).toEqual(['views.save', { view: MINE }]);
    expect(useViewStore.getState().views).toEqual([STARRED, MINE]);
  });

  it('turns the search on screen into a view definition', () => {
    useSearchStore.setState({
      searchQuery: 'invoice tag:Receipts',
      searchFilters: { location: 'all', folder: 'current', sender: 'ann@x.test', dateFrom: null, dateTo: null, hasAttachments: true },
    });
    const def = useViewStore.getState().defFromSearch([{ id: 't1', name: 'Receipts' }]);
    expect(def.query).toBe('invoice');
    expect(def.tags).toEqual(['t1']);
    expect(def.sender).toBe('ann@x.test');
    expect(def.hasAttachments).toBe(true);
  });
});

/// Field values arriving one rendered row at a time would group every row as
/// "no value" and then reshuffle the list under the reader.
describe('a view grouped by a custom field', () => {
  const GROUPED = { id: 'v2', name: 'By priority', icon: 'tag', position: 4, builtin: null, def: { group: 'field:f1' } };
  let loadRowValues;

  beforeEach(() => {
    loadRowValues = useFieldStore.getState().loadRowValues;
  });
  afterEach(() => {
    // Replacing a store action outlives the test that did it.
    useFieldStore.setState({ loadRowValues });
  });

  it('has the values before the rows are shown', async () => {
    const order = [];
    useFieldStore.setState({
      loadRowValues: vi.fn(async (rows) => {
        order.push(['values', rows.map(({ email }) => email.uid), useSearchStore.getState().searchActive]);
      }),
    });
    harness.daemonCall
      .mockResolvedValueOnce({ available: true, rows: [row(1), row(2)], total: 2 })
      .mockResolvedValueOnce({});

    expect(await useViewStore.getState().openView(GROUPED)).toBe(true);
    // Asked for every row, and asked before the list showed any of them.
    expect(order).toEqual([['values', [1, 2], false]]);
    expect(useSearchStore.getState().searchResults.map(r => r.uid)).toEqual([1, 2]);
  });

  it('opens the view even when the values will not load', async () => {
    useFieldStore.setState({ loadRowValues: vi.fn(async () => { throw new Error('no daemon'); }) });
    harness.daemonCall
      .mockResolvedValueOnce({ available: true, rows: [row(1)], total: 1 })
      .mockResolvedValueOnce({});

    expect(await useViewStore.getState().openView(GROUPED)).toBe(true);
    expect(useSearchStore.getState().searchResults.map(r => r.uid)).toEqual([1]);
  });

  it('leaves the values alone for a view that groups by nothing', async () => {
    useFieldStore.setState({ loadRowValues: vi.fn(async () => {}) });
    harness.daemonCall.mockResolvedValueOnce({ available: true, rows: [row(1)], total: 1 });
    await useViewStore.getState().openView(MINE);
    expect(useFieldStore.getState().loadRowValues).not.toHaveBeenCalled();
  });
});

describe('what a view is called', () => {
  const t = key => ({ 'views.builtin.starred': 'Starred' }[key] || key);

  it('translates a starter by its builtin id', () => {
    expect(viewLabel(STARRED, t)).toBe('Starred');
  });

  it('keeps a name the user typed over the starter it came from', () => {
    expect(viewLabel({ ...STARRED, name: 'Pinned' }, t)).toBe('Pinned');
  });

  it('uses the name of a view the user made', () => {
    expect(viewLabel(MINE, t)).toBe('Receipts');
  });

  it('clears the search box it is replacing', async () => {
    useSearchStore.setState({
      searchQuery: 'invoice',
      searchFilters: { location: 'all', folder: 'current', sender: 'ann@x.test', dateFrom: null, dateTo: null, hasAttachments: true },
    });
    harness.daemonCall.mockResolvedValueOnce({ available: true, rows: [row(1)], total: 1 });
    await useViewStore.getState().openView(STARRED);
    expect(useSearchStore.getState().searchQuery).toBe('');
    expect(useSearchStore.getState().searchFilters.sender).toBe('');
    expect(useSearchStore.getState().searchFilters.hasAttachments).toBe(false);
  });

  it('a view opened while another was still loading wins', async () => {
    let releaseFirst;
    harness.daemonCall
      .mockReturnValueOnce(new Promise(resolve => { releaseFirst = resolve; }))
      .mockResolvedValueOnce({ available: true, rows: [row(2)], total: 1 });
    const first = useViewStore.getState().openView(STARRED);
    const second = await useViewStore.getState().openView(MINE);
    releaseFirst({ available: true, rows: [row(1)], total: 1 });
    await first;
    expect(second).toBe(true);
    expect(useViewStore.getState().activeViewId).toBe('v1');
    expect(useSearchStore.getState().searchResults.map(r => r.uid)).toEqual([2]);
  });

  it('refreshes the counts once the view it opened has run', async () => {
    harness.daemonCall
      .mockResolvedValueOnce({ available: true, rows: [], total: 0 })
      .mockResolvedValueOnce({ 'builtin-starred': 7 });
    await useViewStore.getState().openView(STARRED);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(harness.daemonCall.mock.calls.map(([method]) => method)).toContain('views.counts');
  });

  it('moving a view swaps it with its neighbour and saves both', async () => {
    const first = { ...STARRED, position: 0 };
    const second = { ...MINE, position: 1 };
    useViewStore.setState({ views: [first, second] });
    harness.daemonCall.mockResolvedValue({});
    await useViewStore.getState().moveView('v1', -1);
    const saves = harness.daemonCall.mock.calls.filter(([method]) => method === 'views.save');
    expect(saves.map(([, params]) => [params.view.id, params.view.position])).toEqual([['v1', 0], ['builtin-starred', 1]]);
  });

  it('a view already at the top does not move', async () => {
    useViewStore.setState({ views: [{ ...STARRED, position: 0 }, { ...MINE, position: 1 }] });
    await useViewStore.getState().moveView('builtin-starred', -1);
    expect(harness.daemonCall).not.toHaveBeenCalled();
  });

  it('a view that ran is re-run after it is edited', async () => {
    useViewStore.setState({ views: [MINE], activeViewId: 'v1' });
    harness.daemonCall
      .mockResolvedValueOnce(MINE)
      .mockResolvedValueOnce([MINE])
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ available: true, rows: [], total: 0 });
    await useViewStore.getState().saveView({ ...MINE, name: 'Unpaid' });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(harness.daemonCall.mock.calls.map(([method]) => method)).toContain('views.evaluate');
  });
});
