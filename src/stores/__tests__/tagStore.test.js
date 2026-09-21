import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { useTagStore, tagRowKey, requestRowTags } = await import('../tagStore');

const RECEIPTS = { id: 't1', name: 'Receipts', color: '#f00', position: 0, count: 0 };
const CLIENTS = { id: 't2', name: 'Clients', color: '', position: 1, count: 0 };

const email = { uid: 7, messageId: '<abc@example.com>' };
const location = { accountId: 'a', mailbox: 'INBOX' };

beforeEach(() => {
  mockDaemonCall.mockReset();
  useTagStore.setState({ tags: [], byRow: {} });
});

describe('tagStore', () => {
  it('loads the tag list from the daemon', async () => {
    mockDaemonCall.mockResolvedValueOnce([RECEIPTS, CLIENTS]);
    await useTagStore.getState().loadTags();
    expect(mockDaemonCall).toHaveBeenCalledWith('tags.list', {});
    expect(useTagStore.getState().tags).toEqual([RECEIPTS, CLIENTS]);
  });

  it('sends the row identity the daemon keys assignments by', async () => {
    useTagStore.setState({ tags: [RECEIPTS] });
    mockDaemonCall.mockResolvedValue({ count: 1 });
    await useTagStore.getState().applyTag(email, location, 't1');
    expect(mockDaemonCall).toHaveBeenCalledWith('tags.assign', {
      tagId: 't1',
      items: [{ accountId: 'a', mailbox: 'INBOX', uid: 7, messageId: '<abc@example.com>' }],
    });
  });

  it('shows the chip before the daemon answers', async () => {
    useTagStore.setState({ tags: [RECEIPTS] });
    let resolve;
    mockDaemonCall.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const pending = useTagStore.getState().applyTag(email, location, 't1');
    expect(useTagStore.getState().tagIdsFor(email, location)).toEqual(['t1']);
    resolve({ count: 1 });
    await pending;
    expect(useTagStore.getState().tagIdsFor(email, location)).toEqual(['t1']);
  });

  it('takes the chip back when the daemon refuses', async () => {
    useTagStore.setState({ tags: [RECEIPTS] });
    mockDaemonCall.mockRejectedValueOnce(new Error('nope'));
    await useTagStore.getState().applyTag(email, location, 't1');
    expect(useTagStore.getState().tagIdsFor(email, location)).toEqual([]);
  });

  it('never tags one row twice', async () => {
    useTagStore.setState({ tags: [RECEIPTS] });
    mockDaemonCall.mockResolvedValue({ count: 1 });
    await useTagStore.getState().applyTag(email, location, 't1');
    await useTagStore.getState().applyTag(email, location, 't1');
    expect(useTagStore.getState().tagIdsFor(email, location)).toEqual(['t1']);
  });

  it('removes a tag from the row and tells the daemon', async () => {
    useTagStore.setState({ tags: [RECEIPTS], byRow: { [tagRowKey('a', 'INBOX', 7)]: ['t1'] } });
    mockDaemonCall.mockResolvedValue({ count: 1 });
    await useTagStore.getState().removeTag(email, location, 't1');
    expect(mockDaemonCall).toHaveBeenCalledWith('tags.unassign', expect.objectContaining({ tagId: 't1' }));
    expect(useTagStore.getState().tagIdsFor(email, location)).toEqual([]);
  });

  it('matches the daemon reply back onto the rows it asked about', async () => {
    mockDaemonCall.mockResolvedValueOnce({ tags: [['t1'], [], ['t1', 't2']] });
    const rows = [
      { email: { uid: 7, messageId: '<one@x>' }, location },
      { email: { uid: 8, messageId: '<two@x>' }, location },
      { email: { uid: 9, messageId: '<three@x>' }, location },
    ];
    await useTagStore.getState().loadRowTags(rows);
    expect(useTagStore.getState().tagIdsFor(rows[0].email, location)).toEqual(['t1']);
    expect(useTagStore.getState().tagIdsFor(rows[1].email, location)).toEqual([]);
    expect(useTagStore.getState().tagIdsFor(rows[2].email, location)).toEqual(['t1', 't2']);
  });

  it('tags a whole selection in one call', async () => {
    useTagStore.setState({ tags: [RECEIPTS] });
    mockDaemonCall.mockResolvedValueOnce({ count: 2 });
    const rows = [
      { email: { uid: 7, messageId: '<one@x>' }, location },
      { email: { uid: 8, messageId: '<two@x>' }, location },
    ];
    await useTagStore.getState().applyTagToRows(rows, 't1');
    const assigns = mockDaemonCall.mock.calls.filter(([method]) => method === 'tags.assign');
    expect(assigns).toHaveLength(1);
    expect(assigns[0][1].items).toHaveLength(2);
    expect(useTagStore.getState().tagIdsFor(rows[1].email, location)).toEqual(['t1']);
  });

  it('a deleted tag leaves no chip behind on any row', async () => {
    useTagStore.setState({
      tags: [RECEIPTS, CLIENTS],
      byRow: { [tagRowKey('a', 'INBOX', 7)]: ['t1', 't2'], [tagRowKey('a', 'INBOX', 8)]: ['t1'] },
    });
    mockDaemonCall.mockResolvedValueOnce(null);
    await useTagStore.getState().deleteTag('t1');
    expect(useTagStore.getState().tags).toEqual([CLIENTS]);
    expect(useTagStore.getState().tagIdsFor({ uid: 7 }, location)).toEqual(['t2']);
    expect(useTagStore.getState().tagIdsFor({ uid: 8 }, location)).toEqual([]);
  });

  it('a row with no resolvable location is left alone rather than keyed wrongly', async () => {
    useTagStore.setState({ tags: [RECEIPTS] });
    const applied = await useTagStore.getState().applyTag(email, { accountId: 'a', mailbox: 'UNIFIED' }, 't1');
    expect(applied).toBe(false);
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });

  it('asks for every row on screen in one call rather than one call per chip', async () => {
    mockDaemonCall.mockResolvedValueOnce({ tags: [['t1'], []] });
    requestRowTags({ uid: 7, messageId: '<one@x>' }, location);
    requestRowTags({ uid: 8, messageId: '<two@x>' }, location);
    await new Promise(resolve => setTimeout(resolve, 5));
    const asks = mockDaemonCall.mock.calls.filter(([method]) => method === 'tags.for_messages');
    expect(asks).toHaveLength(1);
    expect(asks[0][1].items).toHaveLength(2);
    expect(useTagStore.getState().tagIdsFor({ uid: 7 }, location)).toEqual(['t1']);
  });

  it('does not ask twice for a row it already knows', async () => {
    useTagStore.setState({ byRow: { [tagRowKey('a', 'INBOX', 7)]: ['t1'] } });
    requestRowTags({ uid: 7, messageId: '<one@x>' }, location);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });
});
