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
const mockGetLocalIndexEntry = vi.fn();
const mockGetLocalEmailFull = vi.fn();
vi.mock('../db', () => ({
  getCachedMailboxes: (...a) => mockGetCachedMailboxes(...a),
  getLocalIndexEntry: (...a) => mockGetLocalIndexEntry(...a),
  getLocalEmailFull: (...a) => mockGetLocalEmailFull(...a),
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

const {
  resolveDraftsMailbox, saveLocalDraft, deleteLocalDraft, discardDraftFor, newDraftUid,
  setComposeOpener, openLocalDraft, draftToInitialData,
} = await import('../localDrafts');

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

describe('saveLocalDraft — threading headers survive the round trip', () => {
  it('indexes both In-Reply-To and References', async () => {
    const entry = await save({
      payload: {
        to: 'a@example.com',
        subject: 'Re: something',
        html: '<p>hi</p>',
        inReplyTo: '<parent@example.com>',
        references: '<root@example.com> <parent@example.com>',
      },
    });
    // The .eml carries both, but the vault parse surfaces neither, so the
    // index is the only place a reopened draft can read them back from —
    // dropping References here is what turns a continued reply into a new
    // thread on the recipient's side.
    expect(entry.in_reply_to).toBe('<parent@example.com>');
    expect(entry.references).toBe('<root@example.com> <parent@example.com>');
  });
});

describe('draftToInitialData', () => {
  const eml = {
    subject: 'Half written',
    from: { address: 'me@example.com', name: 'Me' },
    to: [{ address: 'a@example.com' }, { address: 'b@example.com' }],
    cc: [{ address: 'c@example.com' }],
    bcc: [],
    html: '<p>the body I was writing</p>',
    text: 'the body I was writing',
    attachments: [
      { filename: 'notes.pdf', contentType: 'application/pdf', size: 12, content: 'JVBERi0=' },
    ],
  };
  const entry = {
    uid: 42,
    source: 'local_draft',
    from: { address: 'alias@example.com', name: 'Me' },
    in_reply_to: '<parent@example.com>',
    references: '<root@example.com> <parent@example.com>',
  };
  const shape = (over = {}) => draftToInitialData({
    accountId: 'acct-1', mailbox: 'Drafts', uid: 42, entry, eml, ...over,
  });

  it('rebuilds the compose fields the draft was written from', () => {
    const data = shape();
    expect(data.to).toBe('a@example.com, b@example.com');
    expect(data.cc).toBe('c@example.com');
    expect(data.bcc).toBe('');
    expect(data.subject).toBe('Half written');
    expect(data.body).toBe('<p>the body I was writing</p>');
  });

  it('carries the attachment bytes, not just its name', () => {
    // A reopened draft has to be sendable. Attachment metadata with no content
    // is a draft that silently loses its files at send.
    expect(shape().attachments).toEqual([
      { filename: 'notes.pdf', contentType: 'application/pdf', size: 12, content: 'JVBERi0=' },
    ]);
  });

  it('binds the window to the SAME vault draft', () => {
    const data = shape();
    expect(data._draftUid).toBe(42);
    expect(data._draftMailbox).toBe('Drafts');
    expect(data._accountId).toBe('acct-1');
    // The identity it was being written as, not the account login — a draft
    // started from an alias must not silently change its From on reopen.
    expect(data._fromAddress).toBe('alias@example.com');
  });

  it('restores the threading headers from the index', () => {
    const data = shape();
    expect(data.inReplyTo).toBe('<parent@example.com>');
    expect(data.references).toBe('<root@example.com> <parent@example.com>');
  });

  it('falls back to the text part when the HTML one is unreadable', () => {
    const data = shape({ eml: { ...eml, html: null, text: 'line one\n<b>not markup</b>' } });
    // Escaped, not injected — and the line breaks the user typed are kept.
    expect(data.body).toBe('line one<br>&lt;b&gt;not markup&lt;/b&gt;');
  });
});

describe('openLocalDraft', () => {
  const eml = { subject: 'Continue me', to: [{ address: 'a@example.com' }], html: '<p>x</p>', attachments: [] };
  let opened;

  beforeEach(() => {
    opened = [];
    setComposeOpener((data) => opened.push(data));
    mockGetLocalIndexEntry.mockResolvedValue({ uid: 42, source: 'local_draft' });
    mockGetLocalEmailFull.mockResolvedValue(eml);
  });

  it('opens a draft this app wrote', async () => {
    expect(await openLocalDraft('acct-1', 'Drafts', 42)).toBe(true);
    expect(opened.length).toBe(1);
    expect(opened[0].subject).toBe('Continue me');
    expect(opened[0]._draftUid).toBe(42);
  });

  it('leaves a message archived from a server to the viewer', async () => {
    // 'local' and 'local_draft' render identically as rows — provenance is the
    // only thing that separates a saved message from an unfinished one.
    mockGetLocalIndexEntry.mockResolvedValue({ uid: 42, source: 'local' });
    expect(await openLocalDraft('acct-1', 'INBOX', 42)).toBe(false);
    expect(opened.length).toBe(0);
    expect(mockGetLocalEmailFull).not.toHaveBeenCalled();
  });

  it('leaves a row with no index entry alone', async () => {
    mockGetLocalIndexEntry.mockResolvedValue(null);
    expect(await openLocalDraft('acct-1', 'INBOX', 42)).toBe(false);
    expect(opened.length).toBe(0);
  });

  it('refuses to open an empty window when the vault has no bytes', async () => {
    // Indexed as a draft, nothing on disk: an empty compose would look like
    // the draft was always blank. The viewer says "missing" honestly.
    mockGetLocalEmailFull.mockResolvedValue(undefined);
    expect(await openLocalDraft('acct-1', 'Drafts', 42)).toBe(false);
    expect(opened.length).toBe(0);
  });

  it('does nothing before App has registered a way to open compose', async () => {
    setComposeOpener(null);
    expect(await openLocalDraft('acct-1', 'Drafts', 42)).toBe(false);
    expect(mockGetLocalIndexEntry).not.toHaveBeenCalled();
  });
});

describe('newDraftUid', () => {
  it('is a second-resolution stamp, like the staged Sent copy', () => {
    const uid = newDraftUid();
    expect(Number.isInteger(uid)).toBe(true);
    expect(Math.abs(uid - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });
});
