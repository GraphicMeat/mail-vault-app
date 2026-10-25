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

vi.mock('../../stores/safeStorage', async original => ({ ...(await original()), flushSafeStorage: vi.fn(async () => 0) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('framer-motion', () => {
  const components = new Map();
  return {
    motion: new Proxy({}, { get: (_target, tag) => {
      if (!components.has(tag)) components.set(tag, React.forwardRef(({ children, initial, animate, exit, ...props }, ref) =>
        React.createElement('div', { ...props, ref }, children)));
      return components.get(tag);
    } }),
    AnimatePresence: ({ children }) => children,
  };
});
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
  cleanupDraftFor: vi.fn().mockResolvedValue({ discarded: true, cleanup: 'complete' }),
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
  const { preparationTransport } = await import('../../test/composePrep');
  const prepared = preparationTransport(actual);
  return { ...prepared, send: (cmd, args) => (cmd === 'maildir_read_attachments' ? readAttachments(args) : prepared.send(cmd, args)) };
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
const { OutboxTray } = await import('../OutboxTray');

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
    await act(async () => { await vi.waitFor(() => expect(screen.getByTestId('compose-send').closest('form').dataset.preparationReady).toBe('true')); });
    fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>typed</p>' } }); await tick();
    const oldQuote = onSaveState.mock.calls.at(-1)[0]._quotedHtml;
    expect(oldQuote).toContain('AAAA');
    view.rerender(<ComposeModal {...props} mode="reply" replyTo={{ ...header, html: '<p>BBBB</p>', _selectedQuoteHtml: '<p>BBBB</p>' }} onSaveState={onSaveState} />);
    await act(async () => { await vi.waitFor(() => expect(screen.getByTestId('compose-send').closest('form').dataset.preparationReady).toBe('true')); });
    await tick();
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
    expect(screen.getByRole('alert').textContent).toContain('The draft could not be saved. Please retry.');
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

it('saves recovered request-only bytes as revision one without adopting the original tuple', async () => {
  const original = { accountId: 'acct-1', fromAddress: 'me@example.test', displayName: 'Exact Name',
    payload: { to: '', cc: '', bcc: 'secret@example.test', subject: '', html: '<p>recovered</p>', text: 'exact plain text', inReplyTo: '<p>', references: '<r> <p>',
      attachments: [{ filename: 'empty', contentType: 'text/plain', content: '', encoding: 'base64', source: { accountId: 'source', mailbox: 'Inbox', uid: 9, attachmentIndex: 2 } }] }, snippet: 'exact snippet' };
  const onSaveState = vi.fn();
  render(<ComposeModal {...props} onSaveState={onSaveState} initialData={{ _draftId: 'recovered', _draftRevision: 0, _draftAcceptedRevision: 0,
    _draftRecoveredContent: original, _draftRecovery: 'exact-provenance', _accountId: 'acct-1', _fromAddress: 'me@example.test',
    body: '<p>recovered</p>', bcc: 'secret@example.test', inReplyTo: '<p>', references: '<r> <p>', attachments: original.payload.attachments }} />); await tick();
  expect(saveLocalDraft).toHaveBeenCalledExactlyOnceWith({ draftId: 'recovered', revision: 1, ...original });
  expect(onSaveState.mock.calls.at(-1)[0]._draftRecovery).toBe('exact-provenance');
});

it('retains accepted location and offers the same revision retry while native cleanup is pending', async () => {
  saveLocalDraft.mockImplementationOnce(async request => ({ ...accepted(request), cleanup: 'pending', cleanupIdentities: [{ accountId: 'acct-1', mailbox: 'LegacyDrafts', uid: 40 }] }));
  const snapshotRef = { current: null };
  render(<ComposeModal {...props} initialData={seed} snapshotRef={snapshotRef} />); await tick();
  const first = saveLocalDraft.mock.calls[0][0]; const saved = await snapshotRef.current();
  expect(saved._draftAcceptedRevision).toBe(first.revision); expect(saved._draftUid).toBe(42);
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await tick();
  expect(saveLocalDraft.mock.calls[1][0]).toEqual(first);
  expect(screen.queryByRole('alert')).toBeNull();
});

const { useComposeSessionHydration, mergeComposeSession } = await import('../../services/composeSession');
function HydrationHarness({ loader, persist, controls, initial = [], focus, terminalOptions = {}, showOutbox = false }) {
  const [windows, setWindows] = React.useState(initial);
  const idRef = React.useRef(20);
  const owner = useComposeSessionHydration({ windows, setWindows, idRef, loader, persist, focus, ...terminalOptions });
  controls.current = { ...owner, windows, fresh: (mode = 'new') => setWindows(prev => [...prev, { id: ++idRef.current, mode,
    ...(mode === 'reply' ? { replyTo: { uid: 9, from: { address: 'them@example.test' }, subject: 'Question', html: '<p>Q</p>' } } : {}) }]) };
  return <>{showOutbox && <OutboxTray onRestoreDraft={owner.restoreCompose} />}{windows.filter(w => !w.minimized && !w.detached && owner.canMount(w)).map(w => <ComposeModal {...props} key={w.id}
    mode={w.mode || 'new'} replyTo={w.replyTo} initialData={w.initialData} onSaveState={data => owner.saveState(w.id, data)} onDiscard={data => owner.terminalCleanup(data, 'discard', w.id)} />)}</>;
}
const nativeDraft = { ...seed, _draftId: 'managed', _draftRevision: 2, _draftAcceptedRevision: 2, _draftUid: 22, _draftAccountId: 'acct-1' };
describe('App production hydration owner with the real editor', () => {
  it('waits for newer complete session content before mounting one native-reopen editor', async () => {
    const load = deferred(); const loader = vi.fn(() => load.promise); const persist = vi.fn(); const controls = { current: null };
    render(<HydrationHarness {...{ loader, persist, controls }} />);
    await act(async () => { controls.current.openDraft(nativeDraft); controls.current.openDraft({ ...nativeDraft }); });
    expect(controls.current.windows).toHaveLength(1);
    expect(screen.queryByTestId('editor-stub')).toBeNull(); await tick();
    expect(saveLocalDraft).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
    const file = { filename: 'same', contentType: 'text/plain', content: 'QkJC', encoding: 'base64' };
    const content = { accountId: 'acct-1', fromAddress: 'me@example.test', displayName: 'Me', payload: {
      to: '', cc: '', bcc: '', subject: '', html: '<p>x</p><hr data-mailvault-quote="reply"><blockquote><p>QQ</p></blockquote>',
      text: 'x\n\n-------- Original Message --------\nQQ', inReplyTo: '', references: '', attachments: [file],
    }, snippet: 'x' };
    const session = { ...nativeDraft, body: '<p>x</p>', _quotedHtml: '<p>QQ</p>', attachments: [file], _draftContent: content,
      _draftRevision: 3, _draftAcceptedRevision: 1, _draftUid: 11 };
    await act(async () => { load.resolve([{ id: 90, minimized: true, initialData: session }]); });
    expect(screen.getAllByTestId('editor-stub')).toHaveLength(1); expect(screen.getByTestId('editor-stub').value).toBe('<p>x</p>');
    expect(controls.current.windows[0].initialData).toMatchObject({ _draftRevision: 3, _draftAcceptedRevision: 2, _draftUid: 22 });
    expect(persist.mock.calls.at(-1)[0][0].initialData.body).toBe('<p>x</p>');
    await tick(); expect(saveLocalDraft.mock.calls[0][0]).toMatchObject({ draftId: 'managed', revision: 3, ...content });
  });
  it('keeps fresh and reply editors mounted while hydration is pending and after they gain IDs', async () => {
    const load = deferred(); const loader = () => load.promise; const controls = { current: null }; const persist = vi.fn();
    render(<HydrationHarness {...{ loader, persist, controls }} />);
    await act(async () => { controls.current.fresh(); });
    const editor = screen.getByTestId('editor-stub'); fireEvent.change(editor, { target: { value: '<p>fresh exact</p>' } }); await tick();
    expect(controls.current.windows[0].snapshot._draftId).toBe('stable-draft'); expect(screen.getByTestId('editor-stub')).toBe(editor);
    await act(async () => { controls.current.fresh('reply'); }); expect(screen.getAllByTestId('editor-stub')).toHaveLength(2);
    await act(async () => { load.resolve([]); });
    expect(screen.getAllByTestId('editor-stub')[0]).toBe(editor); expect(editor.value).toBe('<p>fresh exact</p>');
  });
  it('releases a pending native reopen on loader rejection without persisting a waiting marker', async () => {
    const load = deferred(); const loader = () => load.promise; const controls = { current: null }; const persist = vi.fn();
    render(<HydrationHarness {...{ loader, persist, controls }} />);
    await act(async () => { controls.current.openDraft(nativeDraft); });
    await act(async () => { load.reject(Error('session unavailable')); });
    expect(screen.getByTestId('editor-stub').value).toBe('<p>typed</p>');
    expect(controls.current.windows.some(w => w._awaitDraftHydration)).toBe(false);
    expect(persist).toHaveBeenCalled();
  });
  it('preserves the already-live detached owner and ignores hydration completion after unmount', async () => {
    const load = deferred(); const loader = () => load.promise; const controls = { current: null }; const persist = vi.fn(); const focus = vi.fn();
    const live = { id: 5, detached: true, nativeLabel: 'live-token', initialData: nativeDraft };
    const view = render(<HydrationHarness {...{ loader, persist, controls, focus }} initial={[live]} />);
    await act(async () => { controls.current.openDraft(nativeDraft); });
    expect(focus).toHaveBeenCalledWith('live-token'); expect(controls.current.windows).toHaveLength(1);
    expect(controls.current.windows[0]).toMatchObject({ detached: true, nativeLabel: 'live-token' });
    view.unmount(); await act(async () => { load.resolve([]); }); expect(persist).not.toHaveBeenCalled();
  });
});

it('preserves complete unversioned restored text against the pending native current in hydration', async () => {
  const load = deferred(); const loader = () => load.promise; const persist = vi.fn(); const controls = { current: null };
  render(<HydrationHarness {...{ loader, persist, controls }} />);
  await act(async () => { controls.current.openDraft(nativeDraft); });
  expect(screen.queryByTestId('editor-stub')).toBeNull();
  const file = { filename: 'empty', contentType: 'text/plain', content: '', source: { accountId: 'source', mailbox: 'Inbox', uid: 9, attachmentIndex: 2 } };
  const legacy = { ...seed, _draftUid: 22, body: '<p>legacy exact</p>', cc: 'copy@example.test', bcc: 'secret@example.test',
    _quotedHtml: '<p>full quote</p>', inReplyTo: '<parent>', references: '<root> <parent>', _fromAddress: 'alias@example.test', attachments: [file] };
  await act(async () => { load.resolve([{ id: 90, initialData: legacy }]); });
  expect(controls.current.windows).toHaveLength(1);
  expect(screen.getByTestId('editor-stub').value).toBe('<p>legacy exact</p>');
  expect(controls.current.windows[0].initialData).toMatchObject({ _draftId: 'managed', _draftAcceptedRevision: 2, _draftUid: 22, _draftRevision: 0 });
  expect(persist.mock.calls.at(-1)[0][0].initialData.body).toBe('<p>legacy exact</p>');
  await tick();
  expect(saveLocalDraft.mock.calls[0][0]).toMatchObject({ draftId: 'managed', revision: 3, fromAddress: 'alias@example.test',
    payload: { cc: 'copy@example.test', bcc: 'secret@example.test', html: expect.stringContaining('<p>legacy exact</p>'), inReplyTo: '<parent>', references: '<root> <parent>',
      attachments: [{ content: '', source: { accountId: 'source', mailbox: 'Inbox', uid: 9, attachmentIndex: 2 } }] } });
  expect(saveLocalDraft.mock.calls[0][0].payload.html).toContain('full quote');
});

it('captures an edit before the recovery seed first timer and retries that exact latest request after restore', async () => {
  saveLocalDraft.mockRejectedValueOnce(Error('recovery vault unavailable'));
  const file = { filename: 'empty', contentType: 'text/plain', content: '', encoding: 'base64', source: { accountId: 'source', mailbox: 'Inbox', uid: 9, attachmentIndex: 2 } };
  const original = { accountId: 'acct-1', fromAddress: 'me@example.test', displayName: 'Exact Name', payload: {
    to: '', cc: '', bcc: 'secret@example.test', subject: '', html: '<p>old recovery</p>', text: 'old plain text', inReplyTo: '<parent>', references: '<root> <parent>', attachments: [file],
  }, snippet: 'old snippet' };
  const snapshotRef = { current: null };
  const view = render(<ComposeModal {...props} snapshotRef={snapshotRef} initialData={{ _draftId: 'recovered', _draftRevision: 0, _draftAcceptedRevision: 0,
    _draftRecoveredContent: original, _draftRecovery: 'provenance', _accountId: 'acct-1', _fromAddress: 'me@example.test',
    body: '<p>old recovery</p>', bcc: 'secret@example.test', inReplyTo: '<parent>', references: '<root> <parent>', attachments: [file] }} />);
  fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>latest before capture</p>' } });
  fireEvent.change(screen.getByTestId('compose-to'), { target: { value: 'latest@example.test' } });
  fireEvent.change(screen.getByTestId('compose-from'), { target: { value: 'acct-2 two@example.test' } });
  await tick();
  const request = saveLocalDraft.mock.calls[0][0];
  expect(request).toMatchObject({ draftId: 'recovered', revision: 1, accountId: 'acct-2', fromAddress: 'two@example.test', payload: {
    to: 'latest@example.test', bcc: 'secret@example.test', html: '<p>latest before capture</p>', text: 'latest before capture',
    inReplyTo: '<parent>', references: '<root> <parent>', attachments: [{ content: '', source: { attachmentIndex: 2 } }],
  } });
  expect(request.previousIdentity).toBeUndefined();
  const saved = await snapshotRef.current(); view.unmount();
  render(<ComposeModal {...props} initialData={saved} />); await tick();
  expect(saveLocalDraft.mock.calls[1][0]).toEqual(request);
  expect(screen.getByTestId('editor-stub').value).toBe('<p>latest before capture</p>');
});

it('retries exact content at an independently accepted revision when request acceptance is unknown', async () => {
  const content = { accountId: 'acct-1', fromAddress: 'me@example.test', displayName: 'Me', payload: {
    to: '', cc: '', bcc: '', subject: '', html: '<p>typed</p>', text: 'typed', inReplyTo: '', references: '', attachments: [],
  }, snippet: 'typed' };
  const snapshotRef = { current: null };
  render(<ComposeModal {...props} snapshotRef={snapshotRef} initialData={{ ...nativeDraft, _draftContent: content, _draftAcceptanceUnknown: true }} />); await tick();
  expect(saveLocalDraft).toHaveBeenCalledExactlyOnceWith({ draftId: 'managed', revision: 2, ...content });
  expect((await snapshotRef.current())._draftAcceptanceUnknown).toBe(false);
});

it.each([false, true])('hydrates compatible exact request content without invented acceptance (%s pending)', async pending => {
  const load = deferred(); const loader = () => load.promise; const persist = vi.fn(); const controls = { current: null };
  render(<HydrationHarness {...{ loader, persist, controls }} />);
  const native = { ...nativeDraft, _fromAddress: 'me@example.test', _draftNativeContent: { revision: 2, html: '<p>typed</p>', text: 'typed', displayName: 'Me' } };
  await act(async () => { controls.current.openDraft(native); });
  const uiContent = { accountId: 'acct-1', fromAddress: 'me@example.test', displayName: 'Me', payload: {
    to: '', cc: '', bcc: '', subject: '', html: '<p>typed</p>', text: 'typed', inReplyTo: '', references: '', attachments: [],
  }, snippet: 'typed' };
  const exact = { ...uiContent, snippet: 'exact untruncated snippet '.repeat(50) };
  await act(async () => { load.resolve([{ id: 90, initialData: { ...native, _draftContent: exact,
    _draftUiSignature: JSON.stringify(uiContent), _draftAcceptedRevision: pending ? 1 : 2 } }]); });
  expect(controls.current.windows).toHaveLength(1); expect(screen.getByTestId('editor-stub').value).toBe('<p>typed</p>');
  expect(controls.current.windows[0].initialData._draftContent).toEqual(exact);
  await tick();
  if (pending) {
    expect(saveLocalDraft).toHaveBeenCalledExactlyOnceWith({ draftId: 'managed', revision: 2, ...exact });
    expect(controls.current.windows[0].snapshot._draftAcceptanceUnknown).toBe(false);
  } else expect(saveLocalDraft).not.toHaveBeenCalled();
});

it('preserves exact known native-only text and sender when that contender becomes a recovery compose', async () => {
  const native = { ...nativeDraft, _fromAddress: 'me@example.test', _draftNativeContent: { revision: 2, html: '<p>typed</p>', text: 'exact native plain', displayName: 'Exact Native Sender' } };
  const windows = mergeComposeSession([{ id: 1, initialData: { ...nativeDraft, body: '<p>owner text</p>' } }], [{ id: 2, initialData: native }]);
  expect(windows).toHaveLength(2); const recovered = windows[1].snapshot || windows[1].initialData;
  render(<ComposeModal {...props} initialData={recovered} />); await tick();
  expect(saveLocalDraft.mock.calls[0][0]).toMatchObject({ draftId: recovered._draftId, revision: 1, displayName: 'Exact Native Sender', payload: { html: '<p>typed</p>', text: 'exact native plain' } });
  expect(saveLocalDraft.mock.calls[0][0].previousIdentity).toBeUndefined();
});


// Terminal intent must fence the real editor and be owned by the same hook App uses.
describe('terminal draft owner with the real editor', () => {
  const window = () => ({ id: 4, initialData: { ...nativeDraft, _draftId: 'terminal', _draftRevision: 0, _draftAcceptedRevision: 0, _draftUid: null, _draftMailbox: null } });
  const discardClick = async () => {
    fireEvent.click(screen.getByTestId('compose-discard'));
    const dialog = screen.getByTestId('compose-discard-dialog');
    fireEvent.click([...dialog.querySelectorAll('button')].find(button => button.textContent === 'Discard'));
    await act(async () => {});
  };
  it('freezes before the first save, retains unknown identity, and retries only cleanup', async () => {
    const load = () => Promise.resolve([]); const discard = vi.fn().mockRejectedValueOnce(Error('lost acknowledgement'))
      .mockResolvedValueOnce({ draftId: 'terminal', discarded: true, cleanup: 'complete' });
    const flush = vi.fn().mockResolvedValue(undefined); const controls = { current: null }; const persist = vi.fn();
    render(<HydrationHarness loader={load} persist={persist} controls={controls} initial={[window()]}
      terminalOptions={{ discard, flush }} />);
    await act(async () => {}); await discardClick(); await tick();
    expect(discard).toHaveBeenCalledWith(expect.objectContaining({ _draftId: 'terminal', body: '<p>typed</p>' }));
    expect(saveLocalDraft).not.toHaveBeenCalled(); expect(screen.queryByTestId('editor-stub')).toBeNull();
    expect(controls.current.windows[0].snapshot).toMatchObject({ _draftCleanupOnly: true, _draftTerminal: 'discard', _draftCleanupState: 'unknown', _draftId: 'terminal' });
    expect(flush).toHaveBeenCalled();
    await act(async () => { await controls.current.retryCleanup(4); });
    expect(discard).toHaveBeenCalledTimes(2); expect(controls.current.windows).toEqual([]);
  });
  it('does not queue saves after discard intent while an earlier save is in flight', async () => {
    const save = deferred(); const cleanup = deferred(); saveLocalDraft.mockReturnValueOnce(save.promise);
    const discard = vi.fn(() => cleanup.promise); const controls = { current: null }; const load = () => Promise.resolve([]);
    render(<HydrationHarness loader={load} persist={vi.fn()} controls={controls} initial={[window()]} terminalOptions={{ discard, flush: vi.fn() }} />);
    await tick(); const request = saveLocalDraft.mock.calls[0][0]; await discardClick();
    fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>too late</p>' } }); await tick();
    expect(discard).not.toHaveBeenCalled(); expect(controls.current.windows).toHaveLength(1);
    await act(async () => { save.resolve(accepted(request)); });
    expect(discard).toHaveBeenCalledTimes(1);
    await act(async () => { cleanup.resolve({ draftId: 'terminal', discarded: true, cleanup: 'pending' }); });
    await tick(); expect(saveLocalDraft).toHaveBeenCalledTimes(1);
    expect(controls.current.windows[0].snapshot).toMatchObject({ body: '<p>typed</p>', _draftCleanupState: 'pending' });
  });
  it('keeps a failed durable flush in memory and serializes concurrent windows coherently', async () => {
    const rpc = deferred(); const flush = vi.fn().mockRejectedValueOnce(Error('settings disk unavailable')).mockResolvedValue(undefined);
    const discard = vi.fn(() => rpc.promise); const controls = { current: null }; const persist = vi.fn(); const loader = () => Promise.resolve([]);
    render(<HydrationHarness {...{ loader, persist, controls }} initial={[{ ...window(), minimized: true }]}
      terminalOptions={{ discard, discardThrough: discard, flush }} />); await act(async () => {});
    let operation; await act(async () => { operation = controls.current.terminalCleanup({ ...nativeDraft, _draftId: 'terminal', body: 'latest minimized' }, 'sent', 4); });
    await act(async () => { controls.current.fresh(); });
    await act(async () => { rpc.reject(Error('lost ACK')); await operation; });
    expect(controls.current.windows).toHaveLength(2);
    const terminal = controls.current.windows.find(w => w.snapshot?._draftTerminal === 'sent');
    expect(terminal.snapshot).toMatchObject({ body: 'latest minimized', _draftTerminal: 'sent', _draftCleanupState: 'unknown' });
    expect(terminal.snapshot._draftCleanupPersistError).toBe(true);
    expect(persist.mock.calls.at(-1)[0]).toHaveLength(2);
    expect(controls.current.canMount(terminal)).toBe(false);
    await act(async () => { controls.current.removeSource(4); });
    expect(controls.current.windows).toHaveLength(2);
  });
  it('restores terminal entries through cleanup only and terminal dominates a stale editable twin', async () => {
    const discard = vi.fn().mockResolvedValue({ draftId: 'terminal', discarded: true, cleanup: 'pending' });
    const controls = { current: null }; const persist = vi.fn(); const flush = vi.fn();
    const data = { ...nativeDraft, _draftId: 'terminal', _draftCleanupOnly: true, _draftTerminal: 'discard', _draftCleanupState: 'unknown' };
    const loader = () => Promise.resolve([{ id: 8, initialData: data }]);
    render(<HydrationHarness {...{ loader, persist, controls }} initial={[{ ...window(), minimized: true }]}
      terminalOptions={{ discard, flush }} />);
    await act(async () => {}); await tick();
    expect(controls.current.windows).toHaveLength(1); expect(discard).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('editor-stub')).toBeNull(); expect(saveLocalDraft).not.toHaveBeenCalled();
    await act(async () => { controls.current.openDraft({ ...nativeDraft, _draftId: 'terminal' }); });
    expect(screen.queryByTestId('editor-stub')).toBeNull(); expect(controls.current.windows).toHaveLength(1);
  });
  it('reconciles child accepted identity changes once, with stale publication fenced after terminal', async () => {
    const controls = { current: null }; const loader = () => Promise.resolve([]); const read = deferred();
    const reconcile = vi.fn(() => read.promise); const discard = vi.fn().mockResolvedValue({ draftId: 'terminal', discarded: true, cleanup: 'pending' });
    render(<HydrationHarness loader={loader} persist={vi.fn()} controls={controls} initial={[{ ...window(), minimized: true }]}
      terminalOptions={{ reconcile, discard, flush: vi.fn() }} />); await act(async () => {});
    const child = { ...nativeDraft, _draftId: 'terminal', _draftAcceptedRevision: 3, _draftAccountId: 'acct-2', _draftUid: 99 };
    await act(async () => { controls.current.saveState(4, child); });
    await act(async () => { controls.current.saveState(4, { ...child, body: '<p>keystroke</p>' }); });
    expect(reconcile).toHaveBeenCalledTimes(1);
    const fence = reconcile.mock.calls[0][1]; expect(fence.isCurrent()).toBe(true);
    await act(async () => { await controls.current.terminalCleanup(child, 'discard', 4); });
    expect(fence.isCurrent()).toBe(false);
    await act(async () => { read.resolve({ managed: [] }); });
    expect(controls.current.windows[0].snapshot._draftTerminal).toBe('discard');
  });
});


describe('automatic cleanup protects reopened writers', () => {
  it.each([false, true])('keeps a real reopened editor after old outbox cancellation and acceptance (published=%s)', async published => {
    const controls = { current: null }; const loader = () => Promise.resolve([]); const cleanup = vi.fn();
    const data = { ...nativeDraft, _draftId: 'reopened' }; const sent = deferred();
    render(<HydrationHarness loader={loader} persist={vi.fn()} controls={controls} initial={[{ id: 30, initialData: data }]}
      terminalOptions={{ discardThrough: cleanup, flush: vi.fn() }} />); await act(async () => {});
    const editor = screen.getByTestId('editor-stub');
    fireEvent.change(editor, { target: { value: '<p>unpublished complete words</p>' } });
    // No timer/publication: parent is deliberately behind this actual editor.
    if (published) { await tick(); expect(controls.current.windows[0].snapshot._draftRevision).toBe(3); }
    else expect(controls.current.windows[0].snapshot).toBeUndefined();
    const { createComposeSlice } = await import('../../stores/slices/composeSlice');
    let state; const get = () => state; const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; };
    state = createComposeSlice(set, get);
    const api = await import('../../services/api');
    api.sendStaged.mockReturnValueOnce(sent.promise);
    const { createComposeSend } = await import('../../services/composeSend');
    state.queueSend({ initialData: data }, createComposeSend({ snapshot: data, account, cleanupDraft: controls.current.terminalCleanup }), 0);
    await act(async () => {}); state.cancelOutbox(state.outboxItems[0].id);
    await act(async () => { sent.resolve({ success: true }); });
    expect(cleanup).not.toHaveBeenCalled(); expect(controls.current.windows).toHaveLength(1);
    expect(screen.getByTestId('editor-stub')).toBe(editor); expect(editor.value).toContain('unpublished complete words');
    await tick(); expect(saveLocalDraft.mock.calls.at(-1)[0]).toMatchObject({ draftId: 'reopened', revision: 3, payload: { html: '<p>unpublished complete words</p>' } });
  });
  it('retains the original conditional bound through unknown cleanup and restoration', async () => {
    const loader = () => Promise.resolve([]); const persist = vi.fn(); const controls = { current: null };
    const discardThrough = vi.fn().mockRejectedValue(Error('lost ACK'));
    const data = { ...nativeDraft, _draftId: 'bound', _draftRevision: 4 };
    const view = render(<HydrationHarness {...{ loader, persist, controls }} terminalOptions={{ discardThrough, flush: vi.fn() }} />);
    await act(async () => {});
    await act(async () => { await controls.current.terminalCleanup(data, 'sent'); });
    const retained = controls.current.windows;
    expect(retained[0].snapshot).toMatchObject({ _draftCleanupThroughRevision: 4, _draftCleanupState: 'unknown' });
    view.unmount();
    const skip = vi.fn().mockResolvedValue({ draftId: 'bound', discarded: false, skipped: true, reason: 'newer_revision', newerRevision: 5 });
    const restore = () => Promise.resolve(retained);
    render(<HydrationHarness loader={restore} persist={vi.fn()} controls={controls} terminalOptions={{ discardThrough: skip, flush: vi.fn() }} />);
    await act(async () => {});
    expect(skip).toHaveBeenCalledWith(expect.objectContaining({ _draftId: 'bound', _draftCleanupThroughRevision: 4 }));
    expect(controls.current.windows).toEqual([]); expect(saveLocalDraft).not.toHaveBeenCalled();
  });
  it('gates a contender during conditional cleanup and recovers its supplied content if native terminal wins', async () => {
    const rpc = deferred(); const discardThrough = vi.fn(() => rpc.promise); const controls = { current: null }; const loader = () => Promise.resolve([]);
    render(<HydrationHarness loader={loader} persist={vi.fn()} controls={controls} terminalOptions={{ discardThrough, flush: vi.fn() }} />);
    await act(async () => {}); const captured = { ...nativeDraft, _draftId: 'admission' };
    let operation; await act(async () => { operation = controls.current.terminalCleanup(captured, 'sent'); });
    await act(async () => { controls.current.openDraft({ ...captured, _draftRevision: 3, body: '<p>retain contender</p>' }); });
    expect(screen.queryByTestId('editor-stub')).toBeNull(); expect(saveLocalDraft).not.toHaveBeenCalled();
    await act(async () => { rpc.resolve({ draftId: 'admission', discarded: true, cleanup: 'complete' }); await operation; });
    expect(controls.current.windows).toHaveLength(1);
    const recovered = controls.current.windows[0].snapshot || controls.current.windows[0].initialData;
    expect(recovered.body).toBe('<p>retain contender</p>'); expect(recovered._draftId).not.toBe('admission');
    expect(recovered._draftUid).toBeUndefined(); expect(recovered._draftTerminal).toBeUndefined();
  });
});


it.each(['unknown', 'pending'])('the standalone editor freezes discard and exposes a cleanup-only retry after %s', async outcome => {
  const onClose = vi.fn();
  if (outcome === 'unknown') deleteLocalDraft.mockRejectedValueOnce(Error('internal draft identity byte-proof failure'));
  else deleteLocalDraft.mockResolvedValueOnce({ draftId: 'stable-draft', discarded: true, cleanup: 'pending' });
  deleteLocalDraft.mockResolvedValueOnce({ draftId: 'stable-draft', discarded: true, cleanup: 'complete' });
  render(<ComposeModal {...props} onClose={onClose} initialData={{ ...seed, _draftUid: null, _draftMailbox: null }} />);
  fireEvent.click(screen.getByTestId('compose-discard'));
  fireEvent.click([...screen.getByTestId('compose-discard-dialog').querySelectorAll('button')].find(button => button.textContent === 'Discard'));
  await act(async () => {}); await tick();
  expect(onClose).not.toHaveBeenCalled(); expect(saveLocalDraft).not.toHaveBeenCalled();
  expect(deleteLocalDraft).toHaveBeenCalledWith({ draftId: 'stable-draft' });
  const status = screen.getByTestId('compose-terminal-status');
  expect(status.textContent).not.toContain('byte-proof');
  expect(screen.getByTestId('compose-send').disabled).toBe(true);
  fireEvent.click(status.querySelector('button')); await act(async () => {});
  expect(deleteLocalDraft).toHaveBeenCalledTimes(2); expect(onClose).toHaveBeenCalledTimes(1);
});


it('translates native draft save failures without exposing identity proof fields', async () => {
  saveLocalDraft.mockRejectedValueOnce(Error('draft receipt mismatch account=internal uid=42 sha256=private-proof'));
  render(<ComposeModal {...props} initialData={seed} />); await tick();
  const alert = screen.getByRole('alert').textContent;
  expect(alert).toContain('The draft could not be saved. Please retry.');
  expect(alert).not.toContain('sha256'); expect(alert).not.toContain('uid=42');
});


describe('App-used Outbox restore admission after accepted SMTP', () => {
  it.each(['complete', 'skipped', 'unknown'])('gates actual Cancel restoration during %s cleanup and preserves full compose context', async outcome => {
    const loader = () => Promise.resolve([]); const controls = { current: null }; const rpc = deferred();
    const discardThrough = vi.fn(() => rpc.promise); const { createComposeSlice } = await import('../../stores/slices/composeSlice');
    const oldQueue = mail.queueSend;
    const original = { uid: 9, messageId: '<reply-parent>', from: { address: 'them@example.test' }, subject: 'Parent' };
    const data = { ...nativeDraft, _draftId: 'cancel-admission', to: 'to@example.test', body: '<p>captured complete reply</p>', _replyTo: original };
    const composeState = { mode: 'reply', replyTo: original, initialData: data };
    const slice = createComposeSlice(update => Object.assign(mail, typeof update === 'function' ? update(mail) : update), () => mail);
    Object.assign(mail, slice);
    const api = await import('../../services/api'); api.sendStaged.mockClear();
    try {
      render(<HydrationHarness {...{ loader, controls }} persist={vi.fn()} showOutbox terminalOptions={{ discardThrough, flush: vi.fn() }} />);
      await act(async () => {});
      const { createComposeSend } = await import('../../services/composeSend');
      await act(async () => { mail.queueSend(composeState, createComposeSend({ snapshot: data, account, mode: 'reply', cleanupDraft: controls.current.terminalCleanup }), 0); });
      expect(discardThrough).toHaveBeenCalledTimes(1); expect(api.sendStaged).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId('outbox-bubble-sending').querySelector('button'));
      await act(async () => {});
      expect(mail.outboxItems).toEqual([]);
      expect(screen.queryByTestId('editor-stub')).toBeNull();
      if (outcome === 'unknown') {
        await act(async () => { rpc.reject(Error('lost cleanup ACK')); });
        expect(screen.queryByTestId('editor-stub')).toBeNull();
        const owner = controls.current.windows.find(window => window.snapshot?._draftCleanupOnly);
        expect(owner.snapshot._draftCleanupContender.body).toBe('<p>captured complete reply</p>');
        discardThrough.mockResolvedValueOnce({ draftId: 'cancel-admission', discarded: true, cleanup: 'complete' });
        await act(async () => { await controls.current.retryCleanup(owner.id); });
      } else await act(async () => { rpc.resolve(outcome === 'skipped'
        ? { draftId: 'cancel-admission', discarded: false, skipped: true, reason: 'newer_revision', newerRevision: 3 }
        : { draftId: 'cancel-admission', discarded: true, cleanup: 'complete' }); });
      const recovered = controls.current.windows.find(window => !window.snapshot?._draftCleanupOnly);
      expect(recovered.mode).toBe('reply'); expect(recovered.replyTo).toEqual(original);
      expect((recovered.snapshot || recovered.initialData).body).toBe('<p>captured complete reply</p>');
      expect((recovered.snapshot || recovered.initialData)._draftId === 'cancel-admission').toBe(outcome === 'skipped');
      expect(api.sendStaged).toHaveBeenCalledTimes(1);
    } finally { mail.queueSend = oldQueue; mail.outboxItems = []; mail.pendingSends = []; mail.pendingSend = null; }
  });
});
