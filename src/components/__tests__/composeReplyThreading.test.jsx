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
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { buildThreads } from '../../utils/emailParser';

const { invoke, sendEmail, buildOutgoingMime } = vi.hoisted(() => ({
  invoke: vi.fn(),
  sendEmail: vi.fn().mockResolvedValue({ messageId: '<mine@example.test>' }),
  buildOutgoingMime: vi.fn().mockResolvedValue({
    rawBase64: 'AAAA', messageId: '<mine@example.test>', rawSize: 4,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
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
vi.mock('../../services/localDrafts', () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft: vi.fn().mockResolvedValue(undefined),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
}));
vi.mock('../../services/workflows/messageMutations', () => ({
  markAnswered: vi.fn().mockResolvedValue(undefined),
  markForwarded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/api', () => ({
  sendEmail: (...a) => sendEmail(...a),
  buildOutgoingMime: (...a) => buildOutgoingMime(...a),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  ensureSentMailbox: vi.fn().mockResolvedValue('Sent'),
}));
vi.mock('../../services/db', () => ({
  getCachedMailboxes: vi.fn().mockResolvedValue([]),
  saveAccount: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/authUtils', () => ({ ensureFreshToken: vi.fn(async (a) => a) }));
vi.mock('../../utils/sendAsSuggestions', async (orig) => ({
  ...(await orig()),
  suggestSendAsAddresses: vi.fn().mockResolvedValue([]),
}));

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
  return { useSettingsStore: hook };
});

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
  mail.sentEmails = [];
  mail.emails = [];
  invoke.mockReset();
  sendEmail.mockClear();
  buildOutgoingMime.mockClear();
});
afterEach(() => cleanup());

async function send(mode, fill, composeProps = {}) {
  render(<ComposeModal mode={mode} replyTo={parent} {...composeProps} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
  const to = await screen.findByTestId('compose-to');
  if (fill) fireEvent.change(to, { target: { value: fill } });
  const btn = await screen.findByTestId('compose-send');
  btn.click();
  await waitFor(() => expect(sendEmail).toHaveBeenCalled());
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

    const payload = buildOutgoingMime.mock.calls[0][1];
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
    fireEvent.click(await screen.findByTestId('compose-send'));
    await waitFor(() => expect(sendEmail).toHaveBeenCalled());

    const payload = buildOutgoingMime.mock.calls[0][1];
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
