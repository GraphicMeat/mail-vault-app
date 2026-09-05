// Unread counts for folders that are not open come from STATUS, once per
// activation, never for the folder that is selected or for \Noselect nodes.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockFetchFolderStatus = vi.fn();
vi.mock('../../api', () => ({ fetchFolderStatus: (...a) => mockFetchFolderStatus(...a) }));
// The real predicate, not a constant false: the skip for a Graph account is a
// branch this file is supposed to cover, and a stubbed-off `false` makes it
// unreachable — the spec would stay green with the guard deleted.
vi.mock('../../graphConfig', () => ({ isGraphAccount: (a) => a?.oauth2Transport === 'graph' }));

let state = { folderStatus: {} };
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => state,
    setState: (patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; },
  },
}));

const { refreshFolderStatus, invalidateFolderStatus, _flattenSelectable, _resetFolderStatusThrottle } =
  await import('../folderStatus');

const ACCOUNT = { id: 'acct1', email: 'me@mock.test' };
const FLAT = [
  { name: 'INBOX', path: 'INBOX', noselect: false, children: [] },
  { name: 'Archive', path: 'Archive', noselect: false, children: [] },
  { name: 'Parent', path: 'Parent', noselect: true, children: [] },
  { name: 'Child', path: 'Parent/Child', noselect: false, children: [] },
];

beforeEach(() => {
  state = { folderStatus: {} };
  mockFetchFolderStatus.mockReset();
  _resetFolderStatusThrottle();
});

describe('refreshFolderStatus', () => {
  it('asks STATUS for every selectable folder except the open one and stores the answer', async () => {
    mockFetchFolderStatus.mockResolvedValue([
      { path: 'Archive', messages: 5, unseen: 2 },
      { path: 'Parent/Child', messages: 1, unseen: 0 },
    ]);
    await refreshFolderStatus(ACCOUNT, FLAT, 'INBOX');
    expect(mockFetchFolderStatus).toHaveBeenCalledWith(ACCOUNT, ['Archive', 'Parent/Child']);
    expect(state.folderStatus.acct1.Archive.unseen).toBe(2);
    expect(state.folderStatus.acct1['Parent/Child'].messages).toBe(1);
  });

  it('is throttled to one sweep per minute per account unless forced', async () => {
    mockFetchFolderStatus.mockResolvedValue([]);
    await refreshFolderStatus(ACCOUNT, FLAT, 'INBOX');
    await refreshFolderStatus(ACCOUNT, FLAT, 'INBOX');
    expect(mockFetchFolderStatus).toHaveBeenCalledTimes(1);
    await refreshFolderStatus(ACCOUNT, FLAT, 'INBOX', { force: true });
    expect(mockFetchFolderStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps counts of other accounts when one account updates', async () => {
    state = { folderStatus: { other: { INBOX: { path: 'INBOX', messages: 3, unseen: 3 } } } };
    mockFetchFolderStatus.mockResolvedValue([{ path: 'Archive', messages: 1, unseen: 1 }]);
    await refreshFolderStatus(ACCOUNT, FLAT, 'INBOX');
    expect(state.folderStatus.other.INBOX.unseen).toBe(3);
    expect(state.folderStatus.acct1.Archive.unseen).toBe(1);
  });

  // One round trip per folder on one background session — an account with 59
  // folders is on record, and the sweep holds that session for all of them.
  it('caps the sweep at 50 folders', async () => {
    const many = Array.from({ length: 60 }, (_, i) => (
      { name: `F${i}`, path: `F${i}`, noselect: false, children: [] }
    ));
    mockFetchFolderStatus.mockResolvedValue([]);
    await refreshFolderStatus(ACCOUNT, many, 'INBOX');
    expect(mockFetchFolderStatus).toHaveBeenCalledWith(ACCOUNT, expect.any(Array));
    expect(mockFetchFolderStatus.mock.calls[0][1]).toHaveLength(50);
  });

  // Refresh must reach the server, and the throttle says "swept moments ago".
  // Forcing a second sweep was one answer; dropping the timestamp so the sweep
  // activateAccount already runs becomes the fresh one is the cheaper one.
  it('runs again after invalidateFolderStatus, without a forced call', async () => {
    mockFetchFolderStatus.mockResolvedValue([]);
    await refreshFolderStatus(ACCOUNT, FLAT, 'INBOX');
    await refreshFolderStatus(ACCOUNT, FLAT, 'INBOX');
    expect(mockFetchFolderStatus).toHaveBeenCalledTimes(1);

    invalidateFolderStatus(ACCOUNT.id);
    await refreshFolderStatus(ACCOUNT, FLAT, 'INBOX');
    expect(mockFetchFolderStatus).toHaveBeenCalledTimes(2);
  });

  it('leaves other accounts throttled when one is invalidated', async () => {
    const OTHER = { id: 'acct2', email: 'other@mock.test' };
    mockFetchFolderStatus.mockResolvedValue([]);
    await refreshFolderStatus(ACCOUNT, FLAT, 'INBOX');
    await refreshFolderStatus(OTHER, FLAT, 'INBOX');
    expect(mockFetchFolderStatus).toHaveBeenCalledTimes(2);

    invalidateFolderStatus(ACCOUNT.id);
    await refreshFolderStatus(OTHER, FLAT, 'INBOX');
    expect(mockFetchFolderStatus).toHaveBeenCalledTimes(2);
  });

  // STATUS is an IMAP command. A Graph account has no session to send it on,
  // and asking would be a thrown error per sidebar paint.
  it('never sends STATUS for a Graph account', async () => {
    const graph = { id: 'acct-graph', email: 'ms@mock.test', oauth2Transport: 'graph' };
    expect(await refreshFolderStatus(graph, FLAT, 'INBOX')).toBe(null);
    expect(mockFetchFolderStatus).not.toHaveBeenCalled();
  });

  // The sidebar paints before the account list resolves on a cold start.
  it('does nothing without an account', async () => {
    expect(await refreshFolderStatus(null, FLAT, 'INBOX')).toBe(null);
    expect(mockFetchFolderStatus).not.toHaveBeenCalled();
  });

  it('_flattenSelectable skips noselect nodes and the active mailbox', () => {
    expect(_flattenSelectable(FLAT, 'Archive')).toEqual(['INBOX', 'Parent/Child']);
  });
});
