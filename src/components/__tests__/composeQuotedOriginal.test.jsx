// @vitest-environment jsdom
//
// A reply keeps the message it answers behind "Show original message". That
// message is someone else's markup, and the compose window is the app's own
// webview: `withGlobalTauri` puts the IPC bridge on its window and the CSP
// allows inline handlers. Nothing in the original may run there, and a
// plain-text original or a header field has to reach the quote as text. What
// leaves on the wire keeps the original as it arrived.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const { buildOutgoingMime, saveLocalDraft } = vi.hoisted(() => ({
  buildOutgoingMime: vi.fn().mockResolvedValue({
    rawBase64: 'AAAA', messageId: '<mine@example.test>', rawSize: 4,
  }),
  saveLocalDraft: vi.fn().mockResolvedValue(undefined),
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
  RichTextEditor: ({ editorRef }) => {
    const ref = React.useRef(null);
    React.useEffect(() => {
      // `state.doc` is real enough for signatureCaretPos: Tab out of the
      // subject reads the document to find the signature separator.
      editorRef.current = {
        state: { doc: { forEach: () => {} } },
        chain: () => ({ focus: () => ({ run: () => ref.current?.focus() }) }),
      };
    }, [editorRef]);
    return React.createElement('div', { ref, tabIndex: -1, 'data-testid': 'editor-stub' });
  },
}));
vi.mock('../ContactsPicker', () => ({ ContactsPickerButton: () => null, ContactsAutocomplete: () => null }));
vi.mock('../../services/localDrafts', () => ({
  resolveDraftsMailbox: vi.fn().mockResolvedValue('Drafts'),
  saveLocalDraft,
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  newDraftUid: () => 1,
}));
vi.mock('../../services/workflows/messageMutations', () => ({
  markAnswered: vi.fn().mockResolvedValue(undefined),
  markForwarded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/api', () => ({
  sendEmail: vi.fn().mockResolvedValue({ messageId: '<mine@example.test>' }),
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

// Marks the app document when it runs. Through `document`, not `window`: vitest
// hands the spec Node's global as `window`, while jsdom runs an inline handler
// against its own Window, so a flag on `window` is never seen here.
const RAN = 'document.documentElement.dataset.quoteRan = "yes"';
const BROKEN_IMG = `<img src="missing.png" onerror='${RAN}'>`;

const original = {
  uid: 10,
  messageId: '<parent@example.test>',
  subject: 'Quote request',
  from: { address: 'them@example.test', name: 'Them' },
  to: [{ address: 'me@example.test' }],
  date: '2026-09-07T09:00:00Z',
  text: 'How much?',
  html: '<p>How <b>much</b>?</p>',
  flags: ['\\Seen'],
};

function openReply(replyTo) {
  render(<ComposeModal mode="reply" replyTo={replyTo} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
}

async function expandQuote() {
  return screen.findByTestId('compose-quoted');
}

/** Send the reply untouched; resolves with the message handed to the MIME builder. */
async function sendReplyTo(replyTo) {
  openReply(replyTo);
  (await screen.findByTestId('compose-send')).click();
  await waitFor(() => expect(buildOutgoingMime).toHaveBeenCalled());
  return buildOutgoingMime.mock.calls[0][1];
}

beforeEach(() => {
  delete document.documentElement.dataset.quoteRan;
  mail.sentEmails = [];
  mail.emails = [];
  buildOutgoingMime.mockClear();
  saveLocalDraft.mockReset();
  saveLocalDraft.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('the quoted original in a reply', () => {
  it('does not publish an autosave snapshot after unmount', async () => {
    let resolveSave;
    saveLocalDraft.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
    const onSaveState = vi.fn();
    const { unmount } = render(<ComposeModal mode="new" initialData={{
      to: 'recipient@example.test',
      subject: 'Saved subject',
      body: '<p>Saved body</p>',
      _baseline: null,
    }} onClose={() => {}} onMinimize={() => {}} onSaveState={onSaveState} />);

    await waitFor(() => expect(saveLocalDraft).toHaveBeenCalledTimes(1));
    unmount();
    onSaveState.mockClear();
    resolveSave();
    await Promise.resolve();
    await Promise.resolve();

    expect(onSaveState).not.toHaveBeenCalled();
  });

  it('runs nothing from the original in the app window', async () => {
    openReply({
      ...original,
      from: { address: 'them@example.test', name: `${BROKEN_IMG}Them` },
      html: `<p>How much?</p>${BROKEN_IMG}`,
    });
    await expandQuote();

    // jsdom never fetches an image: fire the error a real engine fires for a
    // broken one, on every image the app document holds. This pins the app
    // document only; jsdom never loads a srcdoc, so the frame's own sandbox is
    // pinned by the next case and proven in WebKit by the e2e.
    document.querySelectorAll('img').forEach((img) => img.dispatchEvent(new Event('error')));

    expect(document.documentElement.dataset.quoteRan).toBeUndefined();
    expect(document.querySelector('[onerror]')).toBeNull();
  });

  it('shows the original in a frame whose sandbox runs no script', async () => {
    openReply(original);
    const frame = (await expandQuote()).querySelector('iframe');

    expect(frame).not.toBeNull();
    // allow-same-origin alone: the app can measure the frame, nothing inside
    // it can run. Any added token is a decision, not a drive-by.
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    const shown = new DOMParser().parseFromString(frame.getAttribute('srcdoc'), 'text/html');
    expect(shown.body.textContent).toContain('Original Message');
    expect(shown.body.querySelector('b')?.textContent).toBe('much');
  });

  it('shows full reading context by default and hides it with one toggle', async () => {
    openReply(original);
    const toggle = await screen.findByTestId('compose-context-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByTestId('compose-context-panel')).not.toBeNull();
    expect((await screen.findByTestId('compose-quoted')).querySelector('iframe')).not.toBeNull();

    fireEvent.click(toggle);
    expect((await screen.findByTestId('compose-context-toggle')).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('compose-context-panel')).toBeNull();
  });

  it('moves forward Tab from Subject into the editor but leaves Shift-Tab native', async () => {
    openReply(original);
    const subject = await screen.findByTestId('compose-subject');
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    fireEvent(subject, forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('editor-stub'));

    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    fireEvent(subject, backward);
    expect(backward.defaultPrevented).toBe(false);
  });

  it('keeps every originating thread message in reading context', async () => {
    openReply({
      ...original,
      _threadContext: [
        original,
        { ...original, uid: 11, subject: 'Follow up', html: '<p>Second message</p>' },
      ],
    });
    const frame = (await screen.findByTestId('compose-quoted')).querySelector('iframe');
    const shown = new DOMParser().parseFromString(frame.getAttribute('srcdoc'), 'text/html');
    expect(shown.body.textContent).toContain('Quote request');
    expect(shown.body.textContent).toContain('Second message');
  });

  it('quotes a plain-text original as the characters it holds', async () => {
    const text = `On Monday, Ann <ann@example.com> wrote:\n${BROKEN_IMG}`;
    const sent = await sendReplyTo({ ...original, html: '', text });

    expect(sent.html).toContain('<p>On Monday, Ann &lt;ann@example.com&gt; wrote:</p>');
    expect(sent.html).not.toContain('<img');
    expect(sent.text.endsWith(`\n${text}`)).toBe(true);
  });

  it('sends only the selected reply excerpt while context keeps the full source', async () => {
    const sent = await sendReplyTo({ ...original, _selectedQuoteHtml: 'only<br>this' });

    expect(sent.html).toContain('only<br>this');
    expect(sent.html).not.toContain(original.html);
  });

  it('writes the header fields into the quote as text', async () => {
    const sent = await sendReplyTo({
      ...original,
      from: { address: 'them@example.test', name: '<b>Them</b> & co' },
      to: [{ address: 'me@example.test' }, { address: '<i>x</i>@example.test' }],
      subject: 'Price <script>x()</script>',
    });

    expect(sent.html).toContain('From: &lt;b&gt;Them&lt;/b&gt; &amp; co &lt;them@example.test&gt;');
    expect(sent.html).toContain('Subject: Price &lt;script&gt;x()&lt;/script&gt;');
    expect(sent.html).toContain('To: me@example.test, &lt;i&gt;x&lt;/i&gt;@example.test');
    expect(sent.text).toContain('From: <b>Them</b> & co <them@example.test>');
  });

  // A guard, green before the fix too: rendering the quote inertly must not
  // change what the recipient gets.
  it('sends an HTML original on the wire as it arrived', async () => {
    const sent = await sendReplyTo(original);

    expect(sent.html.startsWith('<hr><blockquote><p><strong>Original Message</strong><br>From: Them &lt;them@example.test&gt;<br>Date: ')).toBe(true);
    expect(sent.html.endsWith(`<br>Subject: Quote request<br>To: me@example.test</p>${original.html}</blockquote>`)).toBe(true);
  });
});
