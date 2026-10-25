// @vitest-environment jsdom
// Actual ComposeModal debounce/chain contract. External IO and editor DOM only are stubbed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';

const { stageOutgoing, saveLocalDraft, readAttachments, deleteLocalDraft, resolveDraftsMailbox } = vi.hoisted(() => ({
  // compose.stage's answer: the staged copy and the row the daemon wrote.
  stageOutgoing: vi.fn(async (_account, email) => ({
    uid: 1, mailbox: 'Sent', messageId: '<mine@example.test>',
    entry: {
      uid: 1, message_id: '<mine@example.test>', in_reply_to: email.inReplyTo || null,
      references: email.references ? email.references.split(/\s+/) : null, flags: ['draft', 'seen'], source: 'local_draft',
    },
  })),
  saveLocalDraft: vi.fn().mockResolvedValue(undefined),
  readAttachments: vi.fn(),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  resolveDraftsMailbox: vi.fn().mockResolvedValue("Drafts"),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, ...props }, ref) =>
      React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));
// Only the editor itself is stubbed: textToHtml and htmlToText are what build
// the quote and its text part, so they stay real.
vi.mock('../RichTextEditor', async (importOriginal) => ({
  ...(await importOriginal()),
  RichTextEditor: ({ editorRef, content, onUpdate }) => {
    const ref = React.useRef(null);
    React.useEffect(() => {
      // `state.doc` is real enough for signatureCaretPos: Tab out of the
      // subject reads the document to find the signature separator.
      editorRef.current = {
        state: { doc: { forEach: () => {} } },
        chain: () => ({ focus: () => ({ run: () => ref.current?.focus() }) }),
      };
    }, [editorRef]);
    return React.createElement('textarea', {
      ref, 'data-testid': 'editor-stub', value: content,
      onChange: event => onUpdate(event.target.value),
    });
  },
}));
vi.mock('../ContactsPicker', () => ({ ContactsPickerButton: () => null, ContactsAutocomplete: () => null }));
// The pane's reader is ThreadView (its own spec, ThreadViewReadOnly.test.jsx,
// pins what read-only means). Here: which thread, which message open, which
// theme, and that it is read-only.
vi.mock('../email/ThreadView', () => ({
  ThreadView: ({ thread, readOnly, emailThemeDark, openEmailKey }) => React.createElement('div', {
    'data-testid': 'original-thread',
    'data-read-only': String(readOnly === true),
    'data-dark': String(emailThemeDark),
    'data-open-key': openEmailKey,
    'data-subjects': thread.emails.map(e => e.subject).join('|'),
  }),
}));
vi.mock('../../services/localDrafts', () => ({
  resolveDraftsMailbox,
  saveLocalDraft,
  deleteLocalDraft,
  newDraftUid: () => 1,
  newDraftId: () => "stable-draft",
}));
vi.mock('../../services/workflows/messageMutations', () => ({
  markAnswered: vi.fn().mockResolvedValue(undefined),
  markForwarded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/api', () => ({
  sendStaged: vi.fn().mockResolvedValue({ messageId: '<mine@example.test>' }),
  stageOutgoing: (...a) => stageOutgoing(...a),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  ensureSentMailbox: vi.fn().mockResolvedValue('Sent'),
}));
vi.mock('../../services/db', () => ({
  getCachedMailboxes: vi.fn().mockResolvedValue([]),
  saveAccount: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: vi.fn(async (a) => a) }));
vi.mock('../../services/transport', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, send: (cmd, args) => (cmd === 'maildir_read_attachments' ? readAttachments(args) : actual.send(cmd, args)) };
});

const account = { id: 'acct-1', email: 'me@example.test', name: 'Me' };
const mail = {
  accounts: [account, { id: 'acct-2', email: 'two@example.test', name: 'Two' }],
  activeAccountId: 'acct-1',
  lastSelectedAccountId: 'acct-1',
  activeMailbox: 'INBOX',
  mailboxes: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Sent', name: 'Sent', specialUse: '\\Sent' }],
  sentEmails: [],
  emails: [],
  queueSend: (_state, sendFn) => sendFn(),
  updateSortedEmails: vi.fn(),
  loadSentHeaders: vi.fn(),
};
const settings = {
  getSignature: () => '', getDisplayName: () => 'Me', getOrderedAccounts: (accounts) => accounts,
  sendAsAddresses: {}, sendDelay: 0, emailTemplates: [], spellcheckEnabled: true,
  addEmailTemplate: vi.fn(), lastComposeIdentity: null, setLastComposeIdentity: vi.fn(),
  setComposeContextSplit: vi.fn(), composeSize: null, setComposeSize: vi.fn(),
  setComposeOpenMode: vi.fn(),
};
vi.mock('../../stores/mailStore', () => {
  const hook = vi.fn((selector) => selector(mail));
  hook.getState = () => mail;
  hook.setState = (update) => Object.assign(mail, typeof update === 'function' ? update(mail) : update);
  return { useMailStore: hook };
});
vi.mock('../../stores/accountStore', () => ({ useAccountStore: (selector) => selector(mail) }));
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  // OriginalFrame reads this gate directly (same as EmailViewer/EmailPreviewFrame);
  // this suite doesn't exercise tracker blocking, so it stays off by default.
  return { useSettingsStore: hook, isTrackerBlockingActive: (s) => !!(s || settings).trackerBlockingEnabled };
});

const { ComposeModal } = await import('../ComposeModal');

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const accepted = (request, uid = 42) => ({ draftId: request.draftId, revision: request.revision, disposition: 'saved', cleanup: 'complete', discarded: false, pending: null, cleanupIdentities: [], current: { identity: { accountId: request.accountId, mailbox: 'LegacyDrafts', uid }, entry: { uid, draftId: request.draftId, revision: request.revision } }, accountId: request.accountId, mailbox: 'LegacyDrafts', uid });
const seed = { to: '', cc: '', bcc: '', subject: '', body: '<p>typed</p>', attachments: [], _accountId: 'acct-1', _draftUid: 42, _draftMailbox: 'LegacyDrafts' };
const props = { mode: 'new', onClose() {}, onMinimize() {}, onSaveState() {} };
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); }
beforeEach(() => {
  vi.useFakeTimers(); settings.lastComposeIdentity = null; settings.composeOpenMode = undefined;
  saveLocalDraft.mockReset().mockImplementation(async request => accepted(request));
  deleteLocalDraft.mockReset().mockResolvedValue(undefined);
  resolveDraftsMailbox.mockReset().mockResolvedValue('Drafts'); readAttachments.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('complete draft revisions at the actual component boundary', () => {
  it('persists deliberate all-clear after a saved body', async () => {
    render(<ComposeModal {...props} initialData={seed} />); await tick();
    expect(saveLocalDraft).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '' } }); await tick();
    expect(saveLocalDraft).toHaveBeenCalledTimes(2);
    expect(saveLocalDraft.mock.calls.at(-1)[0].payload).toMatchObject({ html: '', text: '', cc: '', bcc: '', inReplyTo: '', references: '', attachments: [] });
  });
  it('persists an equal-length selected quote delivered by late body fill', async () => {
    const onSaveState = vi.fn();
    const header = { uid: 8, messageId: '<parent@example.test>', from: { address: 'them@example.test' }, to: [{ address: 'me@example.test' }], subject: 'Original', _selectedQuoteHtml: '<p>AAAA</p>' };
    const view = render(<ComposeModal {...props} mode="reply" replyTo={header} onSaveState={onSaveState} />);
    fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>typed</p>' } }); await tick();
    const oldQuote = onSaveState.mock.calls.at(-1)[0]._quotedHtml;
    expect(oldQuote).toContain('AAAA');
    view.rerender(<ComposeModal {...props} mode="reply" replyTo={{ ...header, html: '<p>BBBB</p>', _selectedQuoteHtml: '<p>BBBB</p>' }} onSaveState={onSaveState} />); await tick();
    const newQuote = onSaveState.mock.calls.at(-1)[0]._quotedHtml;
    expect(newQuote).toContain('BBBB'); expect(newQuote.length).toBe(oldQuote.length);
    expect(saveLocalDraft).toHaveBeenCalledTimes(2);
    expect(saveLocalDraft.mock.calls.at(-1)[0].payload.html).toContain('BBBB');
  });
  it('persists actual replacement attachment bytes with the same filename and size', async () => {
    // jsdom FileReader queues three setImmediate tasks; keep those real while
    // controlling only the component debounce timers. No file bytes are mocked.
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const file = { filename: 'f.bin', size: 3, contentType: 'application/octet-stream', content: 'QUFB' };
    const onSaveState = vi.fn();
    const view = render(<ComposeModal {...props} initialData={{ ...seed, attachments: [file] }} onSaveState={onSaveState} />); await tick();
    fireEvent.click(screen.getByTestId('compose-attachment').querySelector('button'));
    const RealFileReader = globalThis.FileReader;
    let finish;
    const readDone = new Promise(resolve => { finish = resolve; });
    const readerSpy = vi.spyOn(globalThis, 'FileReader').mockImplementation(function () {
      const reader = new RealFileReader(); reader.addEventListener('loadend', finish); return reader;
    });
    try {
      fireEvent.change(view.container.querySelector('input[type="file"]'), { target: { files: [new File(['BBB'], 'f.bin', { type: 'application/octet-stream' })] } });
      await act(async () => { await readDone; }); await tick();
      const actual = onSaveState.mock.calls.at(-1)[0].attachments;
      expect(actual).toHaveLength(1); expect(actual[0]).toMatchObject({ filename: 'f.bin', size: 3, content: 'QkJC' });
      expect(saveLocalDraft).toHaveBeenCalledTimes(2);
      expect(saveLocalDraft.mock.calls.at(-1)[0].payload.attachments[0].content).toBe('QkJC');
    } finally { readerSpy.mockRestore(); }
  });
  it('freezes account and identity while the old native save waits', async () => {
    const save = deferred(); saveLocalDraft.mockReturnValueOnce(save.promise);
    render(<ComposeModal {...props} initialData={{ ...seed, _draftMailbox: null }} />); await tick();
    fireEvent.change(screen.getByTestId('compose-from'), { target: { value: 'acct-2 two@example.test' } }); await tick();
    const first = saveLocalDraft.mock.calls[0][0];
    await act(async () => { save.resolve(accepted(first)); });
    expect(saveLocalDraft.mock.calls.map(([request]) => [request.accountId, request.fromAddress, request.draftId])).toEqual([['acct-1', 'me@example.test', 'stable-draft'], ['acct-2', 'two@example.test', 'stable-draft']]);
    expect(saveLocalDraft.mock.calls[1][0].revision).toBeGreaterThan(first.revision);
    expect(resolveDraftsMailbox).not.toHaveBeenCalled();
  });
  it('keeps the old durable draft if destination save fails', async () => {
    const durable = new Map([['acct-1/LegacyDrafts/42', 'old text']]);
    deleteLocalDraft.mockImplementation(async ({ accountId, mailbox, uid }) => { durable.delete(`${accountId}/${mailbox}/${uid}`); });
    saveLocalDraft.mockImplementation(async request => { if (request.accountId === 'acct-2') throw Error('destination unavailable'); durable.set(`${request.accountId}/LegacyDrafts/42`, request.payload.text); return accepted(request); });
    render(<ComposeModal {...props} initialData={seed} />); await tick();
    fireEvent.change(screen.getByTestId('compose-from'), { target: { value: 'acct-2 two@example.test' } }); await tick();
    expect(durable.get('acct-1/LegacyDrafts/42')).toBe('typed');
  });
  it('waits for an in-flight local save before handing the latest snapshot off', async () => {
    const save = deferred(); saveLocalDraft.mockReturnValueOnce(save.promise); const onDetach = vi.fn().mockResolvedValue(undefined);
    render(<ComposeModal {...props} initialData={seed} onDetach={onDetach} />); await tick();
    fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>latest</p>' } });
    fireEvent.click(screen.getByTestId('compose-detach')); await act(async () => {});
    expect(onDetach).not.toHaveBeenCalled();
    await act(async () => { save.resolve(accepted(saveLocalDraft.mock.calls[0][0])); });
    expect(onDetach).toHaveBeenCalledTimes(1); expect(onDetach.mock.calls[0][0].body).toBe('<p>latest</p>');
  });
});

describe('revision recovery at the actual component boundary', () => {
  it('separates newer issued content from an older accepted save reply', async () => {
    const first = deferred(); const second = deferred();
    saveLocalDraft.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onSaveState = vi.fn(); const snapshotRef = { current: null };
    render(<ComposeModal {...props} initialData={seed} onSaveState={onSaveState} snapshotRef={snapshotRef} />); await tick();
    const older = saveLocalDraft.mock.calls[0][0];
    fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>x</p>' } }); await tick();
    const issued = onSaveState.mock.calls.at(-1)[0];
    expect(issued._draftRevision).toBeGreaterThan(older.revision);
    expect(issued._draftAcceptedRevision).toBe(0);
    await act(async () => { first.resolve(accepted(older, 100)); });
    const pending = onSaveState.mock.calls.at(-1)[0];
    expect(pending.body).toBe('<p>x</p>'); expect(pending._draftRevision).toBe(issued._draftRevision);
    expect(pending._draftAcceptedRevision).toBe(older.revision); expect(pending._draftUid).toBe(100);
    await act(async () => { second.resolve(accepted(saveLocalDraft.mock.calls[1][0], 101)); });
    expect((await snapshotRef.current())._draftUid).toBe(101);
  });
  it('retries unchanged failed content with the same complete revision after restoration', async () => {
    saveLocalDraft.mockRejectedValueOnce(Error('vault unavailable'));
    const onSaveState = vi.fn(); const snapshotRef = { current: null };
    const view = render(<ComposeModal {...props} initialData={seed} onSaveState={onSaveState} snapshotRef={snapshotRef} />); await tick();
    const request = saveLocalDraft.mock.calls[0][0];
    expect(screen.getByRole('alert').textContent).toContain('vault unavailable');
    const saved = await snapshotRef.current(); view.unmount();
    render(<ComposeModal {...props} initialData={saved} />); await tick();
    expect(saveLocalDraft).toHaveBeenCalledTimes(2);
    expect(saveLocalDraft.mock.calls[1][0]).toEqual(request);
  });
  it('does not accept submitted content when native reports a superseded revision', async () => {
    const save = deferred(); saveLocalDraft.mockReturnValueOnce(save.promise);
    const onSaveState = vi.fn(); const snapshotRef = { current: null };
    render(<ComposeModal {...props} initialData={seed} onSaveState={onSaveState} snapshotRef={snapshotRef} />); await tick();
    const request = saveLocalDraft.mock.calls[0][0];
    await act(async () => { save.resolve({ ...accepted({ ...request, revision: 8 }, 108), disposition: 'superseded' }); });
    const saved = await snapshotRef.current();
    expect(saved.body).toBe('<p>typed</p>'); expect(saved._draftRevision).toBe(request.revision);
    expect(saved._draftAcceptedRevision).toBe(8); expect(saved._draftUid).toBe(108);
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await tick();
    expect(saveLocalDraft.mock.calls[1][0]).toEqual(request);
  });
  it('allocates a stable identity for blank detach without saving a blank draft', async () => {
    const onDetach = vi.fn().mockResolvedValue(undefined);
    render(<ComposeModal {...props} onDetach={onDetach} />); await tick();
    fireEvent.click(screen.getByTestId('compose-detach')); await act(async () => {});
    expect(onDetach.mock.calls[0][0]).toMatchObject({ _draftId: 'stable-draft', _draftRevision: 0, _draftAcceptedRevision: 0 });
    expect(saveLocalDraft).not.toHaveBeenCalled();
  });
});
