import { describe, it, expect, vi, beforeEach } from 'vitest';

const harness = vi.hoisted(() => ({ daemonCall: vi.fn() }));
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...a) => harness.daemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('../mailStore', () => ({ useMailStore: { getState: () => ({ accounts: [{ id: 'a', email: 'me@h.io' }], activeAccountId: 'a' }) } }));

const { usePeopleStore } = await import('../peopleStore');
const { useSettingsStore } = await import('../settingsStore');

beforeEach(() => {
  harness.daemonCall.mockReset();
  useSettingsStore.setState({ aliases: {}, sendAsAddresses: {} });
  usePeopleStore.setState(usePeopleStore.getInitialState(), true);
});

describe('peopleStore', () => {
  it('load asks the daemon for the current query and sort', async () => {
    harness.daemonCall.mockResolvedValue({ items: [{ id: 'p1', displayName: 'Al' }], total: 1, indexReady: true });
    usePeopleStore.setState({ query: 'al', sort: 'total' });
    await usePeopleStore.getState().load();
    expect(harness.daemonCall).toHaveBeenCalledWith('people.list', expect.objectContaining({ query: 'al', sort: 'total', offset: 0 }));
    expect(usePeopleStore.getState().items).toHaveLength(1);
  });

  it('a stale list reply never overwrites a newer one', async () => {
    let slow;
    harness.daemonCall
      .mockImplementationOnce(() => new Promise(r => { slow = r; }))
      .mockResolvedValueOnce({ items: [{ id: 'new' }], total: 1, indexReady: true });
    const first = usePeopleStore.getState().load();
    await usePeopleStore.getState().load();
    slow({ items: [{ id: 'old' }], total: 1, indexReady: true });
    await first;
    expect(usePeopleStore.getState().items[0].id).toBe('new');
  });

  it('loadMail passes own addresses and pages with the cursor', async () => {
    usePeopleStore.setState({ selectedId: 'p1' });
    harness.daemonCall.mockResolvedValueOnce({ items: [{ uid: 1 }], next: { sortMs: 1, accountId: 'a', mailboxPath: 'INBOX', uid: 1 } });
    await usePeopleStore.getState().loadMail({});
    expect(harness.daemonCall).toHaveBeenLastCalledWith('people.messages', expect.objectContaining({ id: 'p1', ownAddresses: ['me@h.io'] }));
    harness.daemonCall.mockResolvedValueOnce({ items: [{ uid: 2 }], next: null });
    await usePeopleStore.getState().loadMoreMail();
    expect(harness.daemonCall).toHaveBeenLastCalledWith('people.messages', expect.objectContaining({ after: { sortMs: 1, accountId: 'a', mailboxPath: 'INBOX', uid: 1 } }));
    expect(usePeopleStore.getState().mail).toHaveLength(2);
    expect(usePeopleStore.getState().mailNext).toBeNull();
  });

  it('own addresses include the default From and every alias of every account', async () => {
    useSettingsStore.setState({ aliases: { a: [{ address: 'alias@h.io' }] }, sendAsAddresses: { a: 'from@h.io' } });
    harness.daemonCall.mockResolvedValue({});
    await usePeopleStore.getState().refreshStats(['p1']);
    expect(harness.daemonCall).toHaveBeenCalledWith('people.stats', { ids: ['p1'], ownAddresses: ['me@h.io', 'from@h.io', 'alias@h.io'] });
  });

  it('merge refreshes list and card and surfaces errors as state, not exceptions', async () => {
    harness.daemonCall.mockRejectedValueOnce(new Error('E_INVALID: nope'));
    await expect(usePeopleStore.getState().merge(['a', 'b'], 'a')).resolves.toBeNull();
    expect(usePeopleStore.getState().error).toMatch(/E_INVALID/);
  });

  it('the index progress event flips indexReady', () => {
    usePeopleStore.getState().applyIndexEvent({ indexed: 10, done: true });
    expect(usePeopleStore.getState().indexReady).toBe(true);
    usePeopleStore.getState().applyIndexEvent({ indexed: 5, done: false });
    expect(usePeopleStore.getState().indexing).toBe(true);
  });
});
