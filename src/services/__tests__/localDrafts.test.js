// The vault side of compose autosave. What matters here is what ends up on
// disk and in the index: a draft row the list can render, marked as created
// here so a later delete is never replayed against a server that never had it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockBuildDraftMime = vi.fn();
const mockAppendLocalIndex = vi.fn().mockResolvedValue(undefined);
const mockRemoveFromLocalIndex = vi.fn().mockResolvedValue(undefined);

vi.mock('../api', () => ({
  buildDraftMime: (...a) => mockBuildDraftMime(...a),
  appendLocalIndex: (...a) => mockAppendLocalIndex(...a),
  removeFromLocalIndex: (...a) => mockRemoveFromLocalIndex(...a),
}));

const mockGetCachedMailboxes = vi.fn().mockResolvedValue(null);
vi.mock('../db', () => ({
  getCachedMailboxes: (...a) => mockGetCachedMailboxes(...a),
}));

let storeState;
const setState = vi.fn((updater) => {
  storeState = { ...storeState, ...(typeof updater === 'function' ? updater(storeState) : updater) };
});
vi.mock('../../stores/mailStore', () => ({
  useMailStore: {
    getState: () => storeState,
    setState: (...a) => setState(...a),
  },
}));

const { resolveDraftsMailbox, saveLocalDraft, deleteLocalDraft, discardDraftFor, newDraftUid } =
  await import('../localDrafts');

const ACCOUNT = { id: 'acct-1', email: 'me@example.com' };
const invoke = vi.fn().mockResolvedValue(undefined);

const draftsTree = [
  { path: 'INBOX', name: 'INBOX' },
  { path: 'Folders/Entwürfe', name: 'Entwürfe', specialUse: '\\Drafts' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildDraftMime.mockResolvedValue({ rawBase64: 'Ym9keQ==', messageId: '<id@example.com>', rawSize: 4 });
  mockGetCachedMailboxes.mockResolvedValue(null);
  storeState = {
    activeAccountId: 'acct-1',
    activeMailbox: 'Drafts',
    mailboxes: [],
    localEmails: [],
    emails: [],
    archivedEmailIds: new Set(),
    savedEmailIds: new Set(),
    updateSortedEmails: vi.fn(),
  };
  globalThis.window = globalThis.window || {};
  globalThis.window.__TAURI__ = { core: { invoke } };
});

const save = (over = {}) => saveLocalDraft({
  account: ACCOUNT,
  accountId: 'acct-1',
  mailbox: 'Drafts',
  uid: 1700000000,
  fromAddress: 'me@example.com',
  displayName: 'Me',
  payload: { to: 'a@example.com, b@example.com', subject: 'Half written', html: '<p>hi</p>' },
  snippet: 'hi',
  hasAttachments: false,
  ...over,
});

describe('resolveDraftsMailbox', () => {
  it('takes the SPECIAL-USE Drafts folder, whatever it is called', async () => {
    storeState.mailboxes = draftsTree;
    expect(await resolveDraftsMailbox('acct-1')).toBe('Folders/Entwürfe');
  });

  it('reads another account from its cached folder list, not the open one', async () => {
    storeState.mailboxes = draftsTree;
    mockGetCachedMailboxes.mockResolvedValue([{ path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' }]);
    expect(await resolveDraftsMailbox('acct-2')).toBe('Drafts');
    expect(mockGetCachedMailboxes).toHaveBeenCalledWith('acct-2');
  });

  it('falls back to a plain Drafts folder when no list has landed yet', async () => {
    // Offline / cold start: the draft still needs somewhere to go, and this
    // stage never asks a server to make one.
    expect(await resolveDraftsMailbox('acct-1')).toBe('Drafts');
  });
});

describe('saveLocalDraft', () => {
  it('writes the .eml with the flags that make it a visible local draft', async () => {
    await save();
    expect(invoke).toHaveBeenCalledWith('maildir_store', {
      accountId: 'acct-1',
      mailbox: 'Drafts',
      uid: 1700000000,
      rawSourceBase64: 'Ym9keQ==',
      // 'archived' is what puts a local row in the list at all; 'draft' is what
      // it is.
      flags: ['archived', 'seen', 'draft'],
    });
  });

  it('indexes it as locally created, with the recipients split out', async () => {
    const entry = await save();
    expect(mockAppendLocalIndex).toHaveBeenCalledWith('acct-1', 'Drafts', [entry]);
    expect(entry.source).toBe('local_draft');
    expect(entry.uid).toBe(1700000000);
    expect(entry.subject).toBe('Half written');
    expect(entry.to).toEqual([
      { address: 'a@example.com', name: '' },
      { address: 'b@example.com', name: '' },
    ]);
    expect(entry.message_id).toBe('<id@example.com>');
  });

  it('writes nothing when the MIME could not be built', async () => {
    mockBuildDraftMime.mockResolvedValue(null);
    // Half a draft is worse than none: a row that cannot open the user's text
    // reads as "saved" and is not.
    expect(await save()).toBe(null);
    expect(invoke).not.toHaveBeenCalled();
    expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  });

  it('shows the row while that folder is on screen, and keeps one row per draft', async () => {
    await save();
    await save({ payload: { to: 'a@example.com', subject: 'Second pass', html: '<p>hi</p>' } });

    expect(storeState.localEmails.length).toBe(1);
    expect(storeState.localEmails[0].subject).toBe('Second pass');
    expect(storeState.localEmails[0].isArchived).toBe(true);
    // A local row only renders when its uid is in this set.
    expect(storeState.archivedEmailIds.has(1700000000)).toBe(true);
  });

  it('leaves the list alone when the user is looking somewhere else', async () => {
    storeState.activeMailbox = 'INBOX';
    await save();
    expect(storeState.localEmails.length).toBe(0);
    // Still written, though — the row appears when they open Drafts.
    expect(mockAppendLocalIndex).toHaveBeenCalled();
  });
});

describe('deleteLocalDraft', () => {
  it('removes the file, the index entry and the row', async () => {
    await save();
    await deleteLocalDraft({ accountId: 'acct-1', mailbox: 'Drafts', uid: 1700000000 });

    expect(invoke).toHaveBeenCalledWith('maildir_delete', {
      accountId: 'acct-1', mailbox: 'Drafts', uid: 1700000000,
    });
    expect(mockRemoveFromLocalIndex).toHaveBeenCalledWith('acct-1', 'Drafts', 1700000000);
    expect(storeState.localEmails.length).toBe(0);
    expect(storeState.archivedEmailIds.has(1700000000)).toBe(false);
  });

  it('does nothing without a draft to delete', async () => {
    await deleteLocalDraft({ accountId: 'acct-1', mailbox: 'Drafts', uid: null });
    expect(invoke).not.toHaveBeenCalled();
    expect(mockRemoveFromLocalIndex).not.toHaveBeenCalled();
  });

  it('leaves another account\'s rows alone', async () => {
    await save();
    storeState.activeAccountId = 'acct-2';
    await deleteLocalDraft({ accountId: 'acct-1', mailbox: 'Drafts', uid: 1700000000 });

    // The file is gone, but a uid is unique only inside one mailbox — dropping
    // it from the visible account's sets would blank an unrelated row.
    expect(invoke).toHaveBeenCalledWith('maildir_delete', expect.anything());
    expect(storeState.localEmails.length).toBe(1);
  });
});

describe('discardDraftFor', () => {
  it('discards the draft a minimized window owned', async () => {
    await discardDraftFor({ _accountId: 'acct-1', _draftMailbox: 'Drafts', _draftUid: 42 });
    expect(mockRemoveFromLocalIndex).toHaveBeenCalledWith('acct-1', 'Drafts', 42);
  });

  it('no-ops for a window that never saved one', async () => {
    await discardDraftFor({ _accountId: 'acct-1' });
    await discardDraftFor(null);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('newDraftUid', () => {
  it('is a second-resolution stamp, like the staged Sent copy', () => {
    const uid = newDraftUid();
    expect(Number.isInteger(uid)).toBe(true);
    expect(Math.abs(uid - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });
});
