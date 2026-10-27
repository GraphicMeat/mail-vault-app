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

// maildir_store/maildir_delete now route through transport.js (Task 2.1);
// the window.__TAURI__ stub below stays as the "are we in Tauri" presence
// check localDrafts.js still gates on.
const mockSend = vi.fn().mockResolvedValue(undefined);
vi.mock('../transport', () => ({ send: (...a) => mockSend(...a) }));

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
  setComposeOpener, openLocalDraft, draftToInitialData, scheduledEmlToInitialData,
} = await import('../localDrafts');
const { resetDraftProjectionForTest } = await import('../draftProjection');
const { _resetArchivedGroupsForTest, getArchivedGroup } = await import('../../stores/slices/messageListSlice');

const ACCOUNT = { id: 'acct-1', email: 'me@example.com' };
const invoke = vi.fn().mockResolvedValue(undefined);

const draftsTree = [
  { path: 'INBOX', name: 'INBOX' },
  { path: 'Folders/Entwürfe', name: 'Entwürfe', specialUse: '\\Drafts' },
];

beforeEach(() => {
  vi.clearAllMocks();
  _resetArchivedGroupsForTest();
  resetDraftProjectionForTest();
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

const nativeEntry = { uid: 1700000000, source: 'local_draft', subject: 'Half written', to: [{ address: 'a@example.com', name: '' }, { address: 'b@example.com', name: '' }], message_id: '<id@example.com>', flags: ['archived', 'seen', 'draft'] };
const nativeReply = (entry = nativeEntry, revision = 1) => ({ draftId: 'draft-one', revision, disposition: 'saved', accountId: 'acct-1', mailbox: 'Drafts', uid: entry.uid, entry, current: { identity: { accountId: 'acct-1', mailbox: 'Drafts', uid: entry.uid, messageId: entry.message_id }, entry }, pending: null, cleanupIdentities: [], cleanup: 'complete', discarded: false });
const complete = over => ({ to: '', cc: '', bcc: '', subject: '', html: '', text: '', inReplyTo: '', references: '', attachments: [], ...over });
beforeEach(() => {
  mockSend.mockImplementation(async (method) => {
    if (method === 'drafts.save') return nativeReply();
    if (method === 'drafts.discard') return { draftId: 'draft-one', discarded: true, cleanup: 'complete', cleanupIdentities: [] };
    if (method === 'drafts.list') return { drafts: [{ ...nativeReply(), eml: await mockGetLocalEmailFull() }], managed: [nativeReply()] };
  });
});

const save = (over = {}) => saveLocalDraft({
  draftId: 'draft-one', revision: 1,
  account: ACCOUNT,
  accountId: 'acct-1',
  mailbox: 'Drafts',
  uid: 1700000000,
  fromAddress: 'me@example.com',
  displayName: 'Me',
  payload: complete({ to: 'a@example.com, b@example.com', subject: 'Half written', html: '<p>hi</p>' }),
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
  it('routes only a complete snapshot to the daemon', async () => {
    expect(await save()).toMatchObject({ draftId: 'draft-one', disposition: 'saved', entry: nativeEntry });
    expect(mockSend).toHaveBeenCalledWith('drafts.save', expect.objectContaining({ draftId: 'draft-one', revision: 1, snapshot: complete({ to: 'a@example.com, b@example.com', subject: 'Half written', html: '<p>hi</p>' }) }));
    expect(mockBuildDraftMime).not.toHaveBeenCalled();
    expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  });
  it('uses native envelope metadata and does not reinterpret recipients', async () => {
    const entry = (await save()).entry;
    expect(entry).toEqual(nativeEntry);
    expect(mockAppendLocalIndex).not.toHaveBeenCalled();
  });
  it('preserves the accepted row when a native save fails', async () => {
    await save(); mockSend.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(save({ revision: 2 })).rejects.toThrow('disk unavailable');
    expect(storeState.localEmails.map(e => e.uid)).toEqual([1700000000]);
  });
  it('shows one row after native copy-on-write publication', async () => {
    await save();
    mockSend.mockResolvedValueOnce(nativeReply({ ...nativeEntry, uid: 1700000001, subject: 'Second pass' }, 2));
    await save({ revision: 2, payload: complete({ subject: 'Second pass' }) });
    expect(storeState.localEmails.map(e => [e.uid, e.subject])).toEqual([[1700000001, 'Second pass']]);
    expect(storeState.archivedEmailIds.has('acct-1:Drafts:1700000000')).toBe(false);
    expect(storeState.archivedEmailIds.has('acct-1:Drafts:1700000001')).toBe(true);
  });
  it('keeps the visible folder scoped while saving elsewhere', async () => {
    storeState.activeMailbox = 'INBOX'; await save();
    expect(storeState.localEmails).toEqual([]);
    expect(mockSend).toHaveBeenCalledWith('drafts.save', expect.anything());
  });
});
describe('deleteLocalDraft', () => {
  it('discards by canonical identity and removes the exact presented tuple', async () => {
    await save(); await deleteLocalDraft({ draftId: 'draft-one' });
    expect(mockSend).toHaveBeenLastCalledWith('drafts.discard', { draftId: 'draft-one' });
    expect(mockRemoveFromLocalIndex).not.toHaveBeenCalled();
    expect(storeState.localEmails).toEqual([]);
    expect(storeState.archivedEmailIds.has('acct-1:Drafts:1700000000')).toBe(false);
  });
  it('does nothing without an identity', async () => {
    await deleteLocalDraft({ accountId: 'acct-1', mailbox: 'Drafts', uid: null });
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('keeps an unrelated account with the same UID', async () => {
    await save();
    storeState.localEmails.push({ uid: 1700000000, _accountId: 'acct-2', _mailbox: 'Drafts', subject: 'unrelated' });
    await deleteLocalDraft({ draftId: 'draft-one' });
    expect(storeState.localEmails.map(e => e.subject)).toEqual(['unrelated']);
  });
});
describe('discardDraftFor', () => {
  it('uses the stable identity carried by a minimized snapshot', async () => {
    await discardDraftFor({ _draftId: 'draft-one', _accountId: 'acct-1', _draftMailbox: 'Drafts', _draftUid: 42 });
    expect(mockSend).toHaveBeenLastCalledWith('drafts.discard', { draftId: 'draft-one' });
  });
  it('no-ops for a window without identity', async () => {
    await discardDraftFor({ _accountId: 'acct-1' }); await discardDraftFor(null);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
describe('saveLocalDraft: threading wire', () => {
  it('carries both threading headers explicitly', async () => {
    const payload = complete({ inReplyTo: '<parent@example.com>', references: '<root@example.com> <parent@example.com>' });
    await save({ payload });
    expect(mockSend).toHaveBeenCalledWith('drafts.save', expect.objectContaining({ snapshot: payload }));
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

  it('shows the recipient text exactly as typed when the draft carries it', () => {
    // The parsed lists above are what an older save leaves: a trailing comma
    // or an entry without an @ cannot be read back from them.
    const typed = { to: '"Doe, Zoë" <zoe@x.com>, bad', cc: 'bad,', bcc: 'a@x.com, prime@' };
    const data = shape({ eml: { ...eml, to: [{ address: 'Doe, Zoë <zoe@x.com>, bad' }], draftRecipients: typed } });
    expect(data.to).toBe(typed.to);
    expect(data.cc).toBe(typed.cc);
    expect(data.bcc).toBe(typed.bcc);
  });

  it('takes each field from the parsed list when the draft has no typed text for it', () => {
    const data = shape({ eml: { ...eml, draftRecipients: { cc: 'bad,' } } });
    expect(data.to).toBe('a@example.com, b@example.com');
    expect(data.cc).toBe('bad,');
    expect(data.bcc).toBe('');
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

// A draft is written as it would be sent: body, then the original
// (replyWireHtml). Read back, the original goes beside the body again, never
// into the editor, which keeps only what its schema knows.
const { replyWireHtml } = await import('../../utils/replyQuote');
describe('a reply or forward read back from the vault', () => {
  const header = '<p><strong>Original Message</strong><br>Subject: Digest</p>';
  const original = '<style>.x{color:red}</style><table><tr><td>Read <img src="cid:logo@example.test"></td></tr></table>';
  const logo = { filename: 'logo.png', contentType: 'image/png', size: 4, contentId: '<logo@example.test>', content: 'AAAA' };
  const draft = (html, attachments = []) => draftToInitialData({
    accountId: 'acct-1', mailbox: 'Drafts', uid: 42, entry: { source: 'local_draft' },
    eml: { subject: 'Fwd: Digest', to: [], cc: [], bcc: [], html, attachments },
  });

  it('puts a forward\'s original back beside the body', () => {
    const data = draft(replyWireHtml('<p>FYI</p>', header + original, true), [logo]);
    expect(data.body).toBe('<p>FYI</p>');
    expect(data._quotedHtml).toBe(header + original);
    expect(data._contextHtml).toBe(header + original);
    expect(data._forward).toBe(true);
    // The picture the original shows stays tied to its cid: reference.
    expect(data.attachments).toEqual([expect.objectContaining({ filename: 'logo.png', cid: 'logo@example.test' })]);
  });

  it('puts a reply\'s quote back beside the body', () => {
    const data = draft(replyWireHtml('<p>Thanks</p>', header + original));
    expect(data.body).toBe('<p>Thanks</p>');
    expect(data._quotedHtml).toBe(header + original);
    expect(data._forward).toBe(false);
  });

  it('leaves a new message whole', () => {
    const data = draft('<p>one</p><hr><p>two</p>');
    expect(data.body).toBe('<p>one</p><hr><p>two</p>');
    expect(data._quotedHtml).toBe('');
  });

  it('puts a scheduled forward\'s original back beside the body', () => {
    const data = scheduledEmlToInitialData({
      row: { id: 'row-1', accountId: 'acct-1', mailbox: 'Scheduled', uid: 7, envelope: '{}', localTime: '2026-10-01T09:00', tz: 'UTC' },
      eml: { subject: 'Fwd: Digest', to: [], cc: [], bcc: [], html: replyWireHtml('<p>FYI</p>', header + original, true), attachments: [logo] },
    });
    expect(data.body).toBe('<p>FYI</p>');
    expect(data._quotedHtml).toBe(header + original);
    expect(data._forward).toBe(true);
    expect(data.attachments).toEqual([expect.objectContaining({ filename: 'logo.png', cid: 'logo@example.test', isFromOriginal: true })]);
  });
});

describe('scheduledEmlToInitialData', () => {
  // What buildOutgoingPayload froze: a picture pasted into the body went out
  // as a cid: part, a file the user attached as an ordinary attachment.
  const RAW = [
    'From: alias@example.com',
    'To: you@example.com',
    'Subject: Later',
    'In-Reply-To: <parent@example.com>',
    'References: <root@example.com>',
    ' <parent@example.com>',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
  ].join('\r\n');
  const row = {
    id: 'row-1', accountId: 'acct-1', mailbox: 'Scheduled', uid: 7,
    envelope: JSON.stringify({ from: 'alias@example.com', to: 'you@example.com', cc: '', bcc: 'hidden@example.com' }),
    localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius', status: 'queued',
  };
  const eml = {
    subject: 'Later',
    from: { address: 'alias@example.com', name: 'Me' },
    to: [{ address: 'you@example.com' }],
    cc: [],
    bcc: [{ address: 'hidden@example.com' }],
    html: '<p>Look</p><img src="cid:pic-1@mailvault.inline" alt="inline-1.png">',
    text: 'Look',
    attachments: [
      { filename: 'inline-1.png', contentType: 'image/png', size: 4, contentId: '<pic-1@mailvault.inline>', content: 'iVBORw==' },
      { filename: 'terms.pdf', contentType: 'application/pdf', size: 8, contentId: null, content: 'JVBERi0=' },
    ],
    rawSource: btoa(RAW),
  };

  it('shows pictures in the body again and lists only the real files', () => {
    const data = scheduledEmlToInitialData({ row, eml });
    expect(data.body).toBe('<p>Look</p><img src="data:image/png;base64,iVBORw==" alt="inline-1.png">');
    expect(data.attachments).toEqual([
      { filename: 'terms.pdf', contentType: 'application/pdf', size: 8, content: 'JVBERi0=', isFromOriginal: true },
    ]);
    expect(data.to).toBe('you@example.com');
    expect(data.bcc).toBe('hidden@example.com');
    expect(data.subject).toBe('Later');
  });

  /// The vault parse drops In-Reply-To and References; a scheduled reply that
  /// lost them would no longer thread for its recipient.
  it('keeps the threading headers, from the vault\'s base64 and the demo\'s plain text alike', () => {
    for (const rawSource of [eml.rawSource, RAW]) {
      const data = scheduledEmlToInitialData({ row, eml: { ...eml, rawSource } });
      expect(data.inReplyTo).toBe('<parent@example.com>');
      expect(data.references).toBe('<root@example.com> <parent@example.com>');
    }
    expect(scheduledEmlToInitialData({ row, eml: { ...eml, rawSource: undefined } })).toMatchObject({ inReplyTo: '', references: '' });
  });

  /// Adopting the .eml's uid would make autosave overwrite the frozen message
  /// and a later Send or Schedule delete it.
  it('edits the row, never the frozen .eml in the Scheduled mailbox', () => {
    const data = scheduledEmlToInitialData({ row, eml });
    expect(data).not.toHaveProperty('_draftUid');
    expect(data).not.toHaveProperty('_draftMailbox');
    expect(data._editScheduledId).toBe('row-1');
    expect(data._editScheduledRow).toEqual({ accountId: 'acct-1', localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' });
    expect(data._scheduleDraft).toEqual({ localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' });
    expect(data._accountId).toBe('acct-1');
    expect(data._fromAddress).toBe('alias@example.com');
  });

  /// The follow-up reminder rides in the stored envelope: an edit opens
  /// armed with it, and saving keeps it unless the user turns it off.
  it('opens armed with the reminder the schedule carries', () => {
    const withReminder = { ...row, envelope: JSON.stringify({ ...JSON.parse(row.envelope), remindDays: 3 }) };
    expect(scheduledEmlToInitialData({ row: withReminder, eml })._remindDays).toBe(3);
    expect(scheduledEmlToInitialData({ row, eml })._remindDays).toBe(0);
  });

  /// Opening it is not an edit: the window must not read as dirty (and write
  /// a Drafts copy, and ask to discard) until something actually changes.
  it('opens pristine: the baseline is exactly what it opens with', () => {
    const data = scheduledEmlToInitialData({ row, eml });
    expect(data._baseline).toEqual({ to: data.to, subject: data.subject, body: data.body });
    expect(data.attachments.every(att => att.isFromOriginal)).toBe(true);
  });
});

describe('openLocalDraft', () => {
  const eml = { subject: 'Continue me', to: [{ address: 'a@example.com' }], html: '<p>x</p>', attachments: [] };
  let opened;

  beforeEach(() => {
    opened = [];
    setComposeOpener((data) => opened.push(data));
    mockGetLocalIndexEntry.mockResolvedValue({ uid: 42, source: 'local_draft', flags: ['archived', 'draft'] });
    mockGetLocalEmailFull.mockResolvedValue(eml);
  });

  it('opens a draft this app wrote', async () => {
    expect(await openLocalDraft('acct-1', 'Drafts', 42)).toBe(true);
    expect(opened.length).toBe(1);
    expect(opened[0].subject).toBe('Continue me');
    expect(opened[0]._draftUid).toBe(1700000000);
    expect(opened[0]._draftId).toBe('draft-one');
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
    expect(await openLocalDraft('acct-1', 'Drafts', 42)).toBe(true);
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

  it('never hands the same uid to two windows', () => {
    // Two compose windows opened in the same second used to be given the same
    // uid, and one draft's .eml and index entry then overwrote the other's —
    // silent loss of a message the user was still writing. A uid identifies a
    // draft, so it cannot be a bare clock reading.
    const uids = new Set([newDraftUid(), newDraftUid(), newDraftUid()]);
    expect(uids.size).toBe(3);
    const ordered = [...uids];
    expect(ordered[1]).toBeGreaterThan(ordered[0]);
    expect(ordered[2]).toBeGreaterThan(ordered[1]);
  });
});

describe('saveLocalDraft: the optimistic row also feeds the per-group archived-ids map', () => {
  it('adds the new uid to _archivedIdsByGroup, not just the store field', async () => {
    // saveLocalDraft's _showInList writes archivedEmailIds straight to the
    // store for the optimistic row. Before this fix that bypassed
    // `_archivedIdsByGroup` the same way the other writer sites did, so a
    // later failed read for this group would not know about this uid.
    await save();

    const group = getArchivedGroup('acct-1', 'Drafts');
    expect(group?.has(1700000000)).toBe(true);
  });
});

it.each([['', ''], ['native exact plain text', 'Exact Sender']])('carries native semantic text/name presence without fabricating an immutable request (%j, %j)', (text, name) => {
  const mapped = draftToInitialData({ accountId: 'acct-1', mailbox: 'Drafts', uid: 42, draftId: 'native-id', revision: 4,
    entry: { from: { address: 'alias@example.test', name } }, eml: { html: '<p>body</p>', text, from: { address: 'alias@example.test', name }, attachments: [] } });
  expect(mapped._draftNativeContent).toMatchObject({ revision: 4, html: '<p>body</p>', text, displayName: name });
  expect(mapped._draftContent).toBeUndefined();
  expect(mapped).toMatchObject({ _draftId: 'native-id', _draftRevision: 4, _draftAcceptedRevision: 4, _draftAccountId: 'acct-1', _draftMailbox: 'Drafts', _draftUid: 42 });
});

it('keeps omitted native text/name unknown rather than creating empty semantic evidence', () => {
  const mapped = draftToInitialData({ accountId: 'acct-1', mailbox: 'Drafts', uid: 42, draftId: 'native-id', revision: 4,
    entry: { snippet: 'truncated preview' }, eml: { html: '<p>body</p>', attachments: [] } });
  expect(mapped._draftNativeContent).toEqual({ revision: 4, html: '<p>body</p>' });
  expect(mapped._draftContent).toBeUndefined();
});
