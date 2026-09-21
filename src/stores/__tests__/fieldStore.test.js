import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { useFieldStore, fieldRowKey, requestRowValues } = await import('../fieldStore');

const PRIORITY = {
  id: 'f1', scope: 'acct-1', name: 'Priority', kind: 'select', position: 0,
  options: [{ id: 'hi', label: 'High', color: '#f00' }, { id: 'lo', label: 'Low', color: '' }],
};
const OWNER = { id: 'g1', scope: '*', name: 'Owner', kind: 'text', position: 0, options: [] };

const email = { uid: 7, messageId: '<abc@example.com>' };
const location = { accountId: 'acct-1', mailbox: 'INBOX' };

beforeEach(() => {
  mockDaemonCall.mockReset().mockResolvedValue({});
  useFieldStore.setState({ fields: {}, byRow: {} });
});

describe('custom fields', () => {
  it('loads the schema an account can use', async () => {
    mockDaemonCall.mockResolvedValueOnce([OWNER, PRIORITY]);
    await useFieldStore.getState().loadFields('acct-1');
    expect(mockDaemonCall).toHaveBeenCalledWith('fields.list', { accountId: 'acct-1' });
    expect(useFieldStore.getState().fieldsFor('acct-1')).toEqual([OWNER, PRIORITY]);
  });

  it('keeps one account’s schema apart from another’s', async () => {
    mockDaemonCall.mockResolvedValueOnce([PRIORITY]).mockResolvedValueOnce([OWNER]);
    await useFieldStore.getState().loadFields('acct-1');
    await useFieldStore.getState().loadFields('acct-2');
    expect(useFieldStore.getState().fieldsFor('acct-1')).toEqual([PRIORITY]);
    expect(useFieldStore.getState().fieldsFor('acct-2')).toEqual([OWNER]);
  });

  it('sends the row identity when a value is set', async () => {
    await useFieldStore.getState().setValue(email, location, 'f1', 'hi');
    expect(mockDaemonCall).toHaveBeenCalledWith('fields.set', {
      item: { accountId: 'acct-1', mailbox: 'INBOX', uid: 7, messageId: '<abc@example.com>' },
      fieldId: 'f1',
      value: 'hi',
    });
  });

  it('shows the new value before the daemon answers', async () => {
    let resolve;
    mockDaemonCall.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const pending = useFieldStore.getState().setValue(email, location, 'f1', 'hi');
    expect(useFieldStore.getState().valuesFor(email, location)).toEqual({ f1: 'hi' });
    resolve(null);
    await pending;
    expect(useFieldStore.getState().valuesFor(email, location)).toEqual({ f1: 'hi' });
  });

  it('puts the old value back when the daemon refuses', async () => {
    useFieldStore.setState({ byRow: { [fieldRowKey('acct-1', 'INBOX', 7)]: { f1: 'lo' } } });
    mockDaemonCall.mockRejectedValueOnce(new Error('nope'));
    await useFieldStore.getState().setValue(email, location, 'f1', 'hi');
    expect(useFieldStore.getState().valuesFor(email, location)).toEqual({ f1: 'lo' });
  });

  it('clearing a value drops it from the row', async () => {
    useFieldStore.setState({ byRow: { [fieldRowKey('acct-1', 'INBOX', 7)]: { f1: 'hi' } } });
    await useFieldStore.getState().setValue(email, location, 'f1', null);
    expect(useFieldStore.getState().valuesFor(email, location)).toEqual({});
  });

  it('matches the daemon reply back onto the rows it asked about', async () => {
    mockDaemonCall.mockResolvedValueOnce({ values: [{ f1: 'hi' }, {}] });
    const rows = [
      { email: { uid: 7, messageId: '<one@x>' }, location },
      { email: { uid: 8, messageId: '<two@x>' }, location },
    ];
    await useFieldStore.getState().loadRowValues(rows);
    expect(useFieldStore.getState().valuesFor(rows[0].email, location)).toEqual({ f1: 'hi' });
    expect(useFieldStore.getState().valuesFor(rows[1].email, location)).toEqual({});
  });

  it('asks for every row on screen in one call', async () => {
    mockDaemonCall.mockResolvedValueOnce({ values: [{}, {}] });
    requestRowValues({ uid: 7, messageId: '<one@x>' }, location);
    requestRowValues({ uid: 8, messageId: '<two@x>' }, location);
    await new Promise(resolve => setTimeout(resolve, 5));
    const asks = mockDaemonCall.mock.calls.filter(([method]) => method === 'fields.values');
    expect(asks).toHaveLength(1);
    expect(asks[0][1].items).toHaveLength(2);
  });

  it('deleting a field forgets its values everywhere on screen', async () => {
    useFieldStore.setState({
      fields: { 'acct-1': [PRIORITY] },
      byRow: { [fieldRowKey('acct-1', 'INBOX', 7)]: { f1: 'hi', g1: 'Ann' } },
    });
    mockDaemonCall.mockResolvedValueOnce({ droppedValues: 1 }).mockResolvedValueOnce([]);
    await useFieldStore.getState().deleteField('acct-1', 'f1');
    expect(useFieldStore.getState().valuesFor(email, location)).toEqual({ g1: 'Ann' });
  });

  it('copying a schema reloads the account that received it', async () => {
    mockDaemonCall.mockResolvedValueOnce([PRIORITY]).mockResolvedValueOnce([PRIORITY]);
    await useFieldStore.getState().copyFields(['f1'], 'acct-2');
    expect(mockDaemonCall.mock.calls[0]).toEqual(['fields.copy', { fieldIds: ['f1'], accountId: 'acct-2' }]);
    expect(mockDaemonCall.mock.calls[1]).toEqual(['fields.list', { accountId: 'acct-2' }]);
  });

  it('a row with no resolvable folder is left alone rather than keyed wrongly', async () => {
    const done = await useFieldStore.getState().setValue(email, { accountId: 'acct-1', mailbox: 'UNIFIED' }, 'f1', 'hi');
    expect(done).toBe(false);
    expect(mockDaemonCall).not.toHaveBeenCalled();
  });
});
