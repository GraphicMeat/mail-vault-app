import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { activeAccountId: 'a', activeMailbox: 'INBOX', mailboxScope: null, savedEmailIds: new Set(), archivedEmailIds: new Set(),
  localEmails: [], updateSortedEmails: vi.fn() };
const store = { getState: () => state, setState: patch => Object.assign(state, patch) };
vi.mock('../../../stores/mailStore', () => ({ useMailStore: store }));

let batchCallback = null;
const db = {
  getVaultUidSets: vi.fn(async () => ({ saved: new Set([1]), archived: new Set([2]) })),
  getArchivedEmails: vi.fn(async (_account, _mailbox, _uids, onBatch) => { batchCallback = onBatch; }),
};
vi.mock('../../db', () => db);
vi.mock('../../../stores/slices/messageListSlice', () => ({ setArchivedGroup: vi.fn() }));

const { refreshVaultSets } = await import('../refreshVaultSets.js');

beforeEach(() => {
  Object.assign(state, { activeAccountId: 'a', activeMailbox: 'INBOX', mailboxScope: null, localEmails: [] });
  state.updateSortedEmails.mockClear(); batchCallback = null;
});

describe('refreshVaultSets archived batches', () => {
  it('paints a batch into the folder it was read for', async () => {
    await refreshVaultSets('a', 'INBOX');
    batchCallback([{ uid: 2 }]);
    expect(state.localEmails).toEqual([{ uid: 2 }]);
  });

  it('drops a batch that arrives after the same account switched to another folder', async () => {
    await refreshVaultSets('a', 'INBOX');
    Object.assign(state, { activeMailbox: 'Archive' });
    state.updateSortedEmails.mockClear();
    batchCallback([{ uid: 2 }]);
    expect(state.localEmails, 'the other folder\'s list must not receive INBOX rows').toEqual([]);
    expect(state.updateSortedEmails).not.toHaveBeenCalled();
  });

  it('drops a batch after the list started to span folders', async () => {
    await refreshVaultSets('a', 'INBOX');
    Object.assign(state, { activeMailbox: 'UNIFIED' });
    batchCallback([{ uid: 2 }]);
    expect(state.localEmails).toEqual([]);
  });
});
