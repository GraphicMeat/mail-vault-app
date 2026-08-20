// Graph's only expunge signal is a message missing from a listing, so
// `_loadEmailsViaGraph` diffs the page it just fetched against the headers
// already in the store and names the difference as server-deleted. That diff is
// only sound inside the window the page covers — and the window is a range of
// dates, not of uids.
//
// Graph uids are allocated first-seen over a `receivedDateTime desc` listing:
// the seed gave uid 1 to the newest message and counted upward into the past,
// and messages that arrived afterwards took the highest numbers of all. uid 1
// therefore sits on page 1 of every mailbox, which made the old
// `uid >= lowestGraphUid` window cover every row the store held — so one
// 200-message page deleted the rest of a warm cache as if the server had
// expunged it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
}
vi.stubGlobal('navigator', { onLine: true });

const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);
const mockListGraphMessages = vi.fn();

vi.mock('../../db', () => ({
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getArchivedEmailIds: vi.fn().mockResolvedValue(new Set()),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue({
    fetchedAt: Date.now(),
    mailboxes: [
      { path: 'INBOX', _graphFolderId: 'folder-inbox' },
      { path: 'Archive', _graphFolderId: 'folder-archive' },
    ],
  }),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  clearMailboxCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  graphListFolders: vi.fn().mockResolvedValue([]),
  fetchEmails: vi.fn(),
  checkMailboxStatus: vi.fn(),
  searchAllUids: vi.fn().mockResolvedValue([]),
  fetchHeadersByUids: vi.fn().mockResolvedValue({ emails: [] }),
  fetchChangedFlags: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => true,
  normalizeGraphFolderName: (x) => x,
  graphFoldersToMailboxes: () => [],
  graphMessageToEmail: (m) => m,
}));

vi.mock('../../cacheManager', () => ({
  saveRestoreDescriptor: vi.fn(),
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  listGraphMessages: (...a) => mockListGraphMessages(...a),
  getGraphMessageId: vi.fn().mockReturnValue(null),
  resolveGraphMessageId: vi.fn().mockResolvedValue(null),
  restoreGraphIdMap: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ setUnreadForAccount: vi.fn() }) },
}));

const { useMailStore } = await import('../../../stores/mailStore');
const { _loadEmailsViaGraph } = await import('../loadEmails');
const { getLoadEmailsGeneration } = await import('../../../stores/slices/messageListSlice');

const ACCOUNT = { id: 'acct-graph', email: 'me@outlook.com', oauth2AccessToken: 'tok' };

const row = (uid, date) => ({
  uid,
  seq: uid,
  subject: `Msg ${uid}`,
  internalDate: date,
  date,
  flags: [],
  _graphId: `id-${uid}`,
});

function prime(emails) {
  useMailStore.setState({
    accounts: [ACCOUNT],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    emails,
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids(new Set(), { complete: false }),
    deleteTombstones: new Set(),
    mailboxes: [{ path: 'INBOX', _graphFolderId: 'folder-inbox' }],
    totalEmails: emails.length,
  });
}

/** The `removedUids` handed to the sidecar writer by the last save. */
function savedRemovals() {
  expect(mockSaveEmailHeaders).toHaveBeenCalled();
  const [, , , , opts] = mockSaveEmailHeaders.mock.calls.at(-1);
  return [...(opts?.removedUids ?? [])].sort((a, b) => a - b);
}

// The workflow bails out early on a generation mismatch, and a bailed-out run
// saves nothing — which every assertion below would read as "pruned nothing".
// Pass the live counter so the body actually runs.
const gen = () => getLoadEmailsGeneration();

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveEmailHeaders.mockResolvedValue(undefined);
});

describe('_loadEmailsViaGraph expunge window', () => {
  it('spares cached messages older than the page it just fetched', async () => {
    // The store holds a warm cache going back to May. The listing is one page
    // of the three newest. Nothing was deleted server-side, so nothing may be
    // pruned — under the uid window, uids 3 and 4 were both "inside" the page
    // (uid >= 1) and got deleted.
    prime([
      row(5, '2026-08-15T00:00:00Z'), // arrived after the seed — newest of all
      row(1, '2026-08-01T00:00:00Z'), // newest at seed time
      row(2, '2026-07-01T00:00:00Z'),
      row(3, '2026-06-01T00:00:00Z'), // below the page window
      row(4, '2026-05-01T00:00:00Z'), // below the page window
    ]);
    mockListGraphMessages.mockResolvedValue({
      headers: [
        row(5, '2026-08-15T00:00:00Z'),
        row(1, '2026-08-01T00:00:00Z'),
        row(2, '2026-07-01T00:00:00Z'),
      ],
      graphMessageIds: ['id-5', 'id-1', 'id-2'],
      nextLink: 'https://graph.example/next',
    });

    await _loadEmailsViaGraph(ACCOUNT, ACCOUNT.id, 'INBOX', gen());

    expect(savedRemovals()).toEqual([]);
  });

  it('still prunes a message that vanished from inside the page window', async () => {
    // uid 2 falls between the page's newest and oldest dates but is absent from
    // the listing — that is the one genuine expunge signal Graph offers.
    prime([
      row(1, '2026-08-01T00:00:00Z'),
      row(2, '2026-07-15T00:00:00Z'), // deleted on the server
      row(3, '2026-07-01T00:00:00Z'),
      row(4, '2026-05-01T00:00:00Z'), // below the window — unknown, keep
    ]);
    mockListGraphMessages.mockResolvedValue({
      headers: [row(1, '2026-08-01T00:00:00Z'), row(3, '2026-07-01T00:00:00Z')],
      graphMessageIds: ['id-1', 'id-3'],
      nextLink: 'https://graph.example/next',
    });

    await _loadEmailsViaGraph(ACCOUNT, ACCOUNT.id, 'INBOX', gen());

    expect(savedRemovals()).toEqual([2]);
  });

  it('never prunes a cached row it cannot date', async () => {
    prime([
      row(1, '2026-08-01T00:00:00Z'),
      { uid: 9, subject: 'no date', flags: [] },
    ]);
    mockListGraphMessages.mockResolvedValue({
      headers: [row(1, '2026-08-01T00:00:00Z')],
      graphMessageIds: ['id-1'],
      nextLink: null,
    });

    await _loadEmailsViaGraph(ACCOUNT, ACCOUNT.id, 'INBOX', gen());

    expect(savedRemovals()).toEqual([]);
  });

  it('prunes nothing when the listing comes back empty', async () => {
    // An empty page is indistinguishable from a throttled or failed request,
    // and the cache is a superset of the store — absence is not proof.
    prime([row(1, '2026-08-01T00:00:00Z'), row(2, '2026-07-01T00:00:00Z')]);
    mockListGraphMessages.mockResolvedValue({
      headers: [],
      graphMessageIds: [],
      nextLink: null,
    });

    await _loadEmailsViaGraph(ACCOUNT, ACCOUNT.id, 'INBOX', gen());

    expect(savedRemovals()).toEqual([]);
  });
});
