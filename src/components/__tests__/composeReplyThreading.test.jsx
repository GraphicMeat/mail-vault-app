// @vitest-environment jsdom
//
// The copy of your reply that the app shows the instant you hit Send is built
// in the compose window, before SMTP. It has to carry the same threading
// headers as the message that leaves — otherwise the list and the open thread
// see an orphan "Re: …" and the reply reads as a conversation of its own until
// the server round-trip replaces it (seconds later at best, never if the
// APPEND is refused).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { buildThreads } from '../../utils/emailParser';

const { invoke, sendStaged, stageOutgoing, preparation } = vi.hoisted(() => ({
  invoke: vi.fn(),
  preparation: { gate: null, calls: [], failure: false },
  sendStaged: vi.fn().mockResolvedValue({ messageId: '<mine@example.test>' }),
  // compose.stage's answer: the staged copy and the row the daemon wrote.
  stageOutgoing: vi.fn(async (_account, email) => ({
    uid: 1, mailbox: 'Sent', messageId: '<mine@example.test>',
    entry: {
      uid: 1, message_id: '<mine@example.test>', in_reply_to: email.inReplyTo || null,
      references: email.references ? email.references.split(/\s+/) : null, flags: ['draft', 'seen'], source: 'local_draft',
    },
  })),
}));

vi.mock('../../stores/safeStorage', async original => ({ ...(await original()), flushSafeStorage: vi.fn(async () => 0) }));
vi.mock('../../services/transport', () => ({ send: async (method, params) => {
  if (method !== 'compose.reply_context') return;
  preparation.calls.push(params);
  if (preparation.gate) await preparation.gate;
  if (preparation.failure) { preparation.failure = false; throw new Error('compose.preparationUnavailable'); }
  const { prepareDemoCompose } = await import('../../demo/composePrep');
  return prepareDemoCompose(params, { accounts: mail.accounts, values: { 'mailvault-settings': { state: settings } }, version: 0 });
} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});
vi.mock('framer-motion', () => {
  const cache = new Map();
  return { motion: new Proxy({}, { get: (_target, tag) => {
    if (!cache.has(tag)) cache.set(tag, React.forwardRef(({ children, initial, animate, exit, ...props }, ref) => React.createElement(tag, { ...props, ref }, children)));
    return cache.get(tag);
  } }), AnimatePresence: ({ children }) => children };
});
vi.mock('../RichTextEditor', () => ({
  RichTextEditor: ({ content, onUpdate }) => React.createElement('textarea', {
    className: 'ProseMirror', 'data-testid': 'editor-stub', value: content,
    onChange: (event) => onUpdate(event.target.value),
  }),
  insertImages: vi.fn(),
  textToHtml: (s) => s || '',
  htmlToText: (h) => (h || '').replace(/<[^>]*>/g, ''),
  inlineComposeSpacing: (h) => h,
}));
vi.mock('../ContactsPicker', () => ({ ContactsPickerButton: () => null, ContactsAutocomplete: () => null }));
vi.mock('../../services/localDrafts', async () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft: vi.fn((await import('../../test/draftReply')).savedDraftReply),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  cleanupDraftFor: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
  newDraftId: () => "stable-draft",
}));
vi.mock('../../services/workflows/messageMutations', () => ({
  markAnswered: vi.fn().mockResolvedValue(undefined),
  markForwarded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/api', () => ({
  sendStaged: (...a) => sendStaged(...a),
  stageOutgoing: (...a) => stageOutgoing(...a),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  ensureSentMailbox: vi.fn().mockResolvedValue('Sent'),
}));
vi.mock('../../services/db', () => ({
  getCachedMailboxes: vi.fn().mockResolvedValue([]),
  saveAccount: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: vi.fn(async (a) => a) }));

const account = { id: 'acct-1', email: 'me@example.test', name: 'Me' };
const mail = {
  accounts: [account],
  activeAccountId: 'acct-1',
  lastSelectedAccountId: 'acct-1',
  activeMailbox: 'INBOX',
  mailboxes: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Sent', name: 'Sent', specialUse: '\\Sent' }],
  sentEmails: [],
  emails: [],
  // Send now: the optimistic row is what the next assertion reads.
  queueSend: (_state, sendFn) => sendFn(),
  updateSortedEmails: vi.fn(),
  loadSentHeaders: vi.fn(),
};
const settings = {
  getSignature: () => '', getDisplayName: () => 'Me', getOrderedAccounts: (accounts) => accounts,
  sendAsAddresses: {}, sendDelay: 0, emailTemplates: [], spellcheckEnabled: true,
  addEmailTemplate: vi.fn(), lastComposeIdentity: null, setLastComposeIdentity: vi.fn(),
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
  return { useSettingsStore: hook, isTrackerBlockingActive: (s) => !!(s || settings).trackerBlockingEnabled };
});

// The original's pane is a read-only ThreadView with its own specs
// (ThreadViewReadOnly, composeQuotedOriginal); this suite's stores are too thin
// to host its body loader. The stub records what the pane was handed.
const { threadViewProps } = vi.hoisted(() => ({ threadViewProps: [] }));
vi.mock('../email/ThreadView', () => ({ ThreadView: (props) => { threadViewProps.push(props); return null; } }));

const { ComposeModal } = await import('../ComposeModal');

const parent = {
  uid: 10,
  messageId: '<parent@example.test>',
  subject: 'Quote request',
  from: { address: 'them@example.test', name: 'Them' },
  to: [{ address: 'me@example.test' }],
  date: '2026-09-07T09:00:00Z',
  text: 'How much?',
  flags: ['\\Seen'],
};

beforeEach(() => {
  preparation.gate = null; preparation.calls = []; preparation.failure = false;
  mail.sentEmails = [];
  mail.emails = [];
  invoke.mockReset();
  sendStaged.mockClear();
  stageOutgoing.mockClear();
});
afterEach(() => cleanup());

async function send(mode, fill, composeProps = {}) {
  render(<ComposeModal mode={mode} replyTo={parent} {...composeProps} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
  const to = await screen.findByTestId('compose-to');
  if (fill) fireEvent.change(to, { target: { value: fill } });
  const btn = await screen.findByTestId('compose-send');
  await waitFor(() => expect(screen.getByTestId('compose-send').closest('form').dataset.preparationReady).toBe('true'));
  btn.click();
  await waitFor(() => expect(sendStaged).toHaveBeenCalled());
  await waitFor(() => expect(mail.sentEmails).toHaveLength(1));
  return mail.sentEmails[0];
}

const sendReply = () => send('reply');

describe('the reply the compose window stages for the UI', () => {
  it('carries the threading headers it sent on the wire', async () => {
    const staged = await sendReply();

    expect(staged.inReplyTo).toBe('<parent@example.test>');
    expect(staged.references).toEqual(['<parent@example.test>']);
    expect(staged.messageId).toBe('<mine@example.test>');
  });

  it('starts a reply with the selected template while keeping reply recipients and headers', async () => {
    await send('reply', undefined, { templateBody: 'Thanks for reaching out.' });

    const payload = stageOutgoing.mock.calls[0][1];
    expect(payload.to).toBe('them@example.test');
    expect(payload.inReplyTo).toBe('<parent@example.test>');
    expect(payload.references).toBe('<parent@example.test>');
    expect(payload.text).toContain('Thanks for reaching out.');
    expect(payload.text).toContain('Original Message');
  });

  it('keeps the template body through StrictMode effect replay', async () => {
    const templateBody = 'Thanks for reaching out.';
    render(
      <React.StrictMode>
        <ComposeModal mode="reply" replyTo={parent} templateBody={templateBody}
          onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />
      </React.StrictMode>
    );

    const editor = await screen.findByTestId('editor-stub');
    await waitFor(() => expect(editor.value).toBe(templateBody));
  });

  it('keeps edited reply text when the original message is rehydrated', async () => {
    const templateBody = 'Thanks for reaching out.';
    const props = { mode: 'reply', replyTo: parent, templateBody, onClose: () => {}, onMinimize: () => {}, onSaveState: () => {} };
    const { rerender } = render(<ComposeModal {...props} />);
    const editor = await screen.findByTestId('editor-stub');
    fireEvent.change(editor, { target: { value: 'Edited reply' } });

    rerender(<ComposeModal {...props} replyTo={{ ...parent, html: '<p>How much?</p>' }} />);

    await waitFor(() => expect(editor.value).toBe('Edited reply'));
    await waitFor(() => expect(screen.getByTestId('compose-send').closest('form').dataset.preparationReady).toBe('true'));
    fireEvent.click(await screen.findByTestId('compose-send'));
    await waitFor(() => expect(sendStaged).toHaveBeenCalled());

    const payload = stageOutgoing.mock.calls[0][1];
    expect(payload.text).toContain('Edited reply');
    expect(payload.text).not.toContain(templateBody);
    expect(payload.text).toContain('How much?');
    expect(payload.to).toBe('them@example.test');
    expect(payload.inReplyTo).toBe('<parent@example.test>');
    expect(payload.references).toBe('<parent@example.test>');
  });

  it('keeps the original dirty baseline when the reply is rehydrated', async () => {
    const props = { mode: 'reply', replyTo: parent, templateBody: 'Thanks for reaching out.', onClose: () => {}, onMinimize: () => {}, onSaveState: () => {} };
    const { rerender } = render(<ComposeModal {...props} />);
    const editor = await screen.findByTestId('editor-stub');
    fireEvent.change(editor, { target: { value: 'Edited reply' } });

    rerender(<ComposeModal {...props} replyTo={{ ...parent, html: '<p>How much?</p>' }} />);
    await waitFor(() => expect(editor.value).toBe('Edited reply'));
    fireEvent.click(screen.getByTitle('Close'));

    expect(await screen.findByTestId('compose-discard-dialog')).toBeTruthy();
  });

  it('joins the conversation it answers instead of opening a second one', async () => {
    const staged = await sendReply();

    const threads = buildThreads([parent, staged]);
    expect(threads.size).toBe(1);
    expect([...threads.values()][0].emails).toHaveLength(2);
  });

  it('leaves a forward out of it — a forward starts its own conversation', async () => {
    // Not an oversight the way the reply's missing headers were: compose sets
    // In-Reply-To/References empty for `forward` on purpose, and the staged
    // copy has to say the same thing the wire copy does.
    const staged = await send('forward', 'someone-else@example.test');

    expect(staged.inReplyTo).toBeFalsy();
    expect(staged.references).toBeFalsy();
  });
});

// A radial reply/replyAll opens on the header alone (RowQuickActions.jsx)
// and App's openCompose patches in the resolved body once it lands — as a
// `replyTo` prop change on the same, already-mounted ComposeModal. The quote
// panel has to pick that up, and whatever was typed while the fetch was
// still in flight must come through untouched.
describe('the quote fill-in effect (radial reply)', () => {
  it('fills the quote once the body resolves, keeping the typed reply as it is', async () => {
    const headerOnly = { ...parent, text: undefined };
    // Detached: the one surface whose pane is the quote HTML itself. In the
    // app window the pane is a read-only ThreadView that loads its own body.
    const props = { mode: 'reply', detached: true, replyTo: headerOnly, onClose: () => {}, onMinimize: () => {}, onSaveState: () => {} };
    const { rerender } = render(<ComposeModal {...props} />);
    const editor = await screen.findByTestId('editor-stub');

    fireEvent.change(editor, { target: { value: 'Thanks, will check.' } });

    const quotedIframeHtml = () => screen.getByTestId('compose-quoted').querySelector('iframe').getAttribute('srcdoc');
    expect(quotedIframeHtml()).not.toContain('How much?');

    rerender(<ComposeModal {...props} replyTo={{ ...parent, text: 'How much?' }} />);

    await waitFor(() => expect(quotedIframeHtml()).toContain('How much?'));
    expect(editor.value).toBe('Thanks, will check.');
  });

  // In the app window the pane is the read-only thread, resolved once from the
  // header: ThreadView's loader fetches the body (no `_bodyLoaded` on a header),
  // and the patched `replyTo` neither re-resolves it nor touches the typed reply.
  // The outgoing quote still fills in from the patched body.
  it('in the app window reads a header-only original through the thread loader, resolved once', async () => {
    threadViewProps.length = 0;
    const headerOnly = { ...parent, text: undefined };
    const props = { mode: 'reply', replyTo: headerOnly, onClose: () => {}, onMinimize: () => {}, onSaveState: () => {} };
    const { rerender } = render(<ComposeModal {...props} />);
    const editor = await screen.findByTestId('editor-stub');
    fireEvent.change(editor, { target: { value: 'Thanks, will check.' } });

    await waitFor(() => expect(threadViewProps.length).toBeGreaterThan(0));
    const first = threadViewProps.at(-1);
    expect(first.readOnly).toBe(true);
    expect(first.thread.emails).toHaveLength(1);
    expect(first.thread.emails[0].messageId).toBe(parent.messageId);
    expect(first.thread.emails[0]._bodyLoaded).toBeUndefined();

    rerender(<ComposeModal {...props} replyTo={{ ...parent, text: 'How much?' }} />);
    await waitFor(() => expect(screen.getByTestId('compose-quoted')).not.toBeNull());
    expect(threadViewProps.at(-1).thread).toBe(first.thread);
    expect(editor.value).toBe('Thanks, will check.');

    await waitFor(() => expect(screen.getByTestId('compose-send').closest('form').dataset.preparationReady).toBe('true'));
    screen.getByTestId('compose-send').click();
    await waitFor(() => expect(stageOutgoing).toHaveBeenCalled());
    expect(stageOutgoing.mock.calls.at(-1)[1].html).toContain('How much?');
  });
});

// Download modes (H5): a reader's snippet stand-in (`_bodyLoading`) reaching
// Compose is not the message. It is never quoted; the quote waits for the real
// body, the way a radial reply's does.
describe('a reply opened on the index snippet', () => {
  it('never quotes the snippet, and quotes the body once it arrives', async () => {
    const snippet = { ...parent, text: 'How mu', _bodyLoading: true };
    const props = { mode: 'reply', onClose: () => {}, onMinimize: () => {}, onSaveState: () => {} };
    const { rerender } = render(<ComposeModal {...props} replyTo={snippet} />);
    await screen.findByTestId('compose-to');

    rerender(<ComposeModal {...props} replyTo={{ ...parent, text: 'How much is the whole order?' }} />);
    await waitFor(() => expect(screen.getByTestId('compose-send').closest('form').dataset.preparationReady).toBe('true'));
    fireEvent.click(await screen.findByTestId('compose-send'));
    await waitFor(() => expect(sendStaged).toHaveBeenCalled());

    const payload = stageOutgoing.mock.calls[0][1];
    expect(payload.text).toContain('How much is the whole order?');
    expect(payload.to).toBe('them@example.test');
  });

  it('sends no snippet quote when the body never arrives', async () => {
    const snippet = { ...parent, text: 'Snippet only words', _bodyLoading: true };
    render(<ComposeModal mode="reply" replyTo={snippet} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('compose-send').closest('form').dataset.preparationReady).toBe('true'));
    fireEvent.click(await screen.findByTestId('compose-send'));
    await waitFor(() => expect(sendStaged).toHaveBeenCalled());
    expect(stageOutgoing.mock.calls[0][1].text).not.toContain('Snippet only words');
  });
});

it('keeps authored fields while native reply defaults are pending', async () => {
  let release;
  preparation.gate = new Promise(resolve => { release = resolve; });
  render(<ComposeModal mode="reply" replyTo={parent} templateBody="Preset reply" onClose={() => {}} />);
  const to = screen.getByLabelText(/To/i, { selector: 'input' });
  expect(screen.getByTestId('compose-subject').value).toBe('');
  expect(screen.queryAllByTestId('recipient-chip')).toHaveLength(0);
  expect(to.value).toBe('');
  fireEvent.change(to, { target: { value: 'typed@example.test' } });
  const subject = screen.getByLabelText(/Subject/i);
  fireEvent.change(subject, { target: { value: 'Authored subject' } });
  fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>Authored body</p>' } });
  fireEvent.submit(to.closest('form'));
  expect(stageOutgoing).not.toHaveBeenCalled();
  await act(async () => { release(); });
  await waitFor(() => expect(screen.getByTestId('compose-subject').closest('form').dataset.preparationReady).toBe('true'));
  expect(to.value).toBe('typed@example.test');
  expect(subject.value).toBe('Authored subject');
  expect(screen.getByTestId('editor-stub').value).toBe('<p>Authored body</p>');
});

it('coalesces a stale header preparation into a complete large late fill without touching edits', async () => {
  let release; preparation.gate = new Promise(r => { release = r; });
  const snapshots = [];
  const props = { mode: 'reply', onClose: () => {}, onSaveState: data => snapshots.push(data) };
  const header = { ...parent, text: '', html: '' };
  const { rerender } = render(<ComposeModal {...props} replyTo={header} />);
  await waitFor(() => expect(preparation.calls).toHaveLength(1));
  fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>Typed while loading</p>' } });
  fireEvent.change(screen.getByTestId('compose-subject'), { target: { value: 'My subject' } });
  const large = '<p>' + '界'.repeat(750000) + 'FINAL_LARGE</p>';
  const context = Array.from({ length: 70 }, (_, i) => ({ ...parent, date: `2026-10-${String(i % 25 + 1).padStart(2, '0')}T12:00:00Z`, html: `<p>context-${i}</p>` }));
  rerender(<ComposeModal {...props} replyTo={{ ...parent, html: large, _threadContext: context }} />);
  expect(preparation.calls).toHaveLength(1);
  await act(async () => { release(); });
  await waitFor(() => expect(screen.getByTestId('compose-subject').closest('form').dataset.preparationReady).toBe('true'));
  expect(preparation.calls).toHaveLength(2);
  expect(preparation.calls[1].original.html).toBe(large);
  expect(preparation.calls[1].threadContext).toHaveLength(70);
  await waitFor(() => expect(snapshots.at(-1)?._quotedHtml?.endsWith(large)).toBe(true), { timeout: 5000 });
  expect(snapshots.at(-1)._contextHtml).toContain('context-69');
  expect(snapshots.at(-1).subject).toBe('My subject');
  expect(screen.getByTestId('editor-stub').value).toBe('<p>Typed while loading</p>');
});
it('keeps the selected sender and re-prepares after account and alias changes during RPC', async () => {
  let release; preparation.gate = new Promise(r => { release = r; });
  const second = { id: 'acct-2', email: 'second@example.test', name: 'Second' };
  const originalAccounts = mail.accounts; const originalAliases = settings.aliases;
  mail.accounts = [account, second];
  const message = { ...parent, to: [...parent.to, { address: 'newalias@example.test' }, { address: 'friend@example.test' }] };
  const snapshots = [];
  const props = { mode: 'replyAll', replyTo: message, onClose: () => {}, onSaveState: data => snapshots.push(data) };
  try {
    const { rerender } = render(<ComposeModal {...props} />);
    await waitFor(() => expect(preparation.calls).toHaveLength(1));
    fireEvent.change(screen.getByTestId('compose-from'), { target: { value: 'acct-2 second@example.test' } });
    settings.aliases = { 'acct-2': [{ address: 'newalias@example.test' }] };
    rerender(<ComposeModal {...props} />);
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId('compose-subject').closest('form').dataset.preparationReady).toBe('true'));
    expect(preparation.calls.at(-1).accountId).toBe('acct-2');
    await waitFor(() => expect(snapshots.at(-1)?._accountId).toBe('acct-2'));
    expect(snapshots.at(-1)._fromAddress).toBe('second@example.test');
    expect(snapshots.at(-1).to).toBe('them@example.test, friend@example.test');
  } finally { mail.accounts = originalAccounts; settings.aliases = originalAliases; }
});
it('retains editable content and readiness guard on preparation failure, then retries explicitly', async () => {
  preparation.failure = true;
  const snapshots = [];
  render(<ComposeModal mode="reply" replyTo={parent} onClose={() => {}} onSaveState={d => snapshots.push(d)} />);
  fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>Keep this</p>' } });
  await screen.findByText('Could not prepare this message. Please try again.');
  fireEvent.submit(screen.getByTestId('compose-subject').closest('form'));
  expect(stageOutgoing).not.toHaveBeenCalled();
  await waitFor(() => expect(snapshots.at(-1)?._preparationPending).toBe(true));
  expect(screen.getByTestId('editor-stub').value).toBe('<p>Keep this</p>');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByTestId('compose-subject').closest('form').dataset.preparationReady).toBe('true'));
  expect(screen.getByTestId('editor-stub').value).toBe('<p>Keep this</p>');
});

it('applies App-prepared full body immediately while an old header RPC finishes later', async () => {
  let release; preparation.gate = new Promise(r => { release = r; });
  const snapshots = []; const header = { ...parent, text: '', html: '' };
  const props = { mode: 'reply', onClose: () => {}, onSaveState: d => snapshots.push(d) };
  const { rerender } = render(<ComposeModal {...props} replyTo={header} />);
  await waitFor(() => expect(preparation.calls).toHaveLength(1));
  fireEvent.change(screen.getByTestId('editor-stub'), { target: { value: '<p>Keep authored text</p>' } });
  const full = { ...parent, html: '<p>Full body first</p>' };
  const { prepareDemoCompose } = await import('../../demo/composePrep');
  const { messagePreparation, preparationIdentity } = await import('../../services/composePrep');
  const result = prepareDemoCompose({ ...messagePreparation({ replyTo: full, mode: 'reply', accountId: account.id }), requestId: 'app-fill' }, { accounts: mail.accounts, values: {}, version: 0 });
  const preparedQuote = { source: full, result, identityGeneration: preparationIdentity({ accountId: account.id, fromAddress: account.email, accounts: mail.accounts, aliases: settings.aliases || {}, sendAsAddresses: settings.sendAsAddresses }) };
  rerender(<ComposeModal {...props} replyTo={full} preparedQuote={preparedQuote} />);
  await waitFor(() => expect(screen.getByTestId('compose-send').closest('form').dataset.preparationReady).toBe('true'));
  expect(preparation.calls).toHaveLength(1);
  await waitFor(() => expect(snapshots.at(-1)?._quotedHtml).toContain('Full body first'));
  await act(async () => { release(); });
  expect(snapshots.at(-1)._quotedHtml).toContain('Full body first');
  expect(screen.getByTestId('editor-stub').value).toBe('<p>Keep authored text</p>');
});
