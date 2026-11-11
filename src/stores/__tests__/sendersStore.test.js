import { describe, it, expect, vi, beforeEach } from 'vitest';

const harness = vi.hoisted(() => ({ daemonCall: vi.fn() }));
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...a) => harness.daemonCall(...a),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('../mailStore', () => ({ useMailStore: { getState: () => ({ accounts: [{ id: 'a', email: 'me@h.io' }] }) } }));

const { useSendersStore } = await import('../sendersStore');
const { useSettingsStore } = await import('../settingsStore');

beforeEach(() => {
  harness.daemonCall.mockReset();
  useSettingsStore.setState({ aliases: {}, sendAsAddresses: {} });
  useSendersStore.getState().reset();
});

describe('sendersStore', () => {
  it('load sends query, sort and own addresses', async () => {
    harness.daemonCall.mockResolvedValue({ items: [{ address: 'a@x.io' }], total: 1 });
    useSendersStore.setState({ query: 'al', sort: 'total' });
    await useSendersStore.getState().load();
    expect(harness.daemonCall).toHaveBeenCalledWith('people.senders', { query: 'al', sort: 'total', ownAddresses: ['me@h.io'], limit: 50, offset: 0 });
    expect(useSendersStore.getState().items).toHaveLength(1);
  });

  it('defaults to newest first', () => {
    expect(useSendersStore.getState().sort).toBe('last');
  });

  it('a stale reply never overwrites a newer one', async () => {
    let slow;
    harness.daemonCall
      .mockImplementationOnce(() => new Promise((r) => { slow = r; }))
      .mockResolvedValueOnce({ items: [{ address: 'new@x.io' }], total: 1 });
    const first = useSendersStore.getState().load();
    await useSendersStore.getState().load();
    slow({ items: [{ address: 'old@x.io' }], total: 1 });
    await first;
    expect(useSendersStore.getState().items[0].address).toBe('new@x.io');
  });

  it('two loadMore calls in flight append the page once', async () => {
    let land;
    harness.daemonCall.mockImplementationOnce(() => new Promise((r) => { land = r; }));
    useSendersStore.setState({ items: [{ address: 'a@x.io' }], total: 3 });
    const first = useSendersStore.getState().loadMore();
    const second = useSendersStore.getState().loadMore();
    land({ items: [{ address: 'b@x.io' }, { address: 'c@x.io' }], total: 3 });
    await Promise.all([first, second]);
    expect(harness.daemonCall).toHaveBeenCalledTimes(1);
    expect(harness.daemonCall).toHaveBeenCalledWith('people.senders', expect.objectContaining({ offset: 1 }));
    expect(useSendersStore.getState().items.map((i) => i.address)).toEqual(['a@x.io', 'b@x.io', 'c@x.io']);
  });

  it('setQuery and setSort reload from the first page', async () => {
    harness.daemonCall.mockResolvedValue({ items: [], total: 0 });
    await useSendersStore.getState().setQuery('bo');
    await useSendersStore.getState().setSort('name');
    expect(harness.daemonCall).toHaveBeenLastCalledWith('people.senders', expect.objectContaining({ query: 'bo', sort: 'name', offset: 0 }));
  });
});
