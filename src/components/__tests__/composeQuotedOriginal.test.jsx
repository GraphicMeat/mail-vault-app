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
import { act, render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

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
    return React.createElement('div', {
      ref, tabIndex: -1, 'data-testid': 'editor-stub', 'data-content': content,
      onClick: () => onUpdate('<p>Typed body survives setting changes</p>'),
    });
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
  return render(<ComposeModal mode="reply" replyTo={replyTo} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
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
  settings.sendAsAddresses = {};
  settings.lastComposeIdentity = null;
  settings.composeContextVisible = true;
  settings.composeOpenMode = undefined;
  buildOutgoingMime.mockClear();
  saveLocalDraft.mockReset();
  saveLocalDraft.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('the quoted original in a reply', () => {
  it('freezes the configured default From address into the queued snapshot', async () => {
    settings.sendAsAddresses = { 'acct-1': 'alias@example.test' };
    const onQueueSend = vi.fn().mockResolvedValue(undefined);
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onQueueSend={onQueueSend} />);

    fireEvent.change(await screen.findByTestId('compose-to'), { target: { value: 'recipient@example.test' } });
    fireEvent.click(screen.getByTestId('compose-send'));

    await waitFor(() => expect(onQueueSend).toHaveBeenCalled());
    expect(onQueueSend.mock.calls[0][0]._fromAddress).toBe('alias@example.test');
  });

  it('freezes editing and Escape while a detached window request is pending, then recovers on failure', async () => {
    let rejectDetach;
    const onDetach = vi.fn(() => new Promise((_resolve, reject) => { rejectDetach = reject; }));
    const onClose = vi.fn();
    render(<ComposeModal mode="new" initialData={{ to: 'before@example.test', body: '<p>Body</p>', _baseline: null }}
      onClose={onClose} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);

    fireEvent.click(await screen.findByTestId('compose-detach'));
    await waitFor(() => expect(onDetach).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('compose-modal').hasAttribute('inert')).toBe(true);

    const to = screen.getByTestId('compose-to');
    fireEvent.change(to, { target: { value: 'after@example.test' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(to.value).toBe('before@example.test');
    expect(onClose).not.toHaveBeenCalled();

    rejectDetach(new Error('Native window unavailable'));
    await waitFor(() => expect(screen.getByTestId('compose-error').textContent).toContain('Native window unavailable'));
    expect(screen.getByTestId('compose-modal').hasAttribute('inert')).toBe(false);
    expect(to.value).toBe('before@example.test');
  });

  it('hands an initialized reply straight to its own window when set to always open one', async () => {
    settings.composeOpenMode = 'window';
    const onDetach = vi.fn().mockResolvedValue(undefined);
    render(<ComposeModal mode="reply" replyTo={original} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);

    await waitFor(() => expect(onDetach).toHaveBeenCalledTimes(1));
    expect(onDetach.mock.calls[0][0]).toMatchObject({ to: 'them@example.test', subject: 'Re: Quote request' });
    expect(document.querySelector('[data-auto-detach="true"]').style.visibility).toBe('hidden');
  });

  it('shows the compose it could not hand to a window, with the error', async () => {
    settings.composeOpenMode = 'window';
    const onDetach = vi.fn().mockRejectedValue(new Error('Native window unavailable'));
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);

    await waitFor(() => expect(screen.getByTestId('compose-error').textContent).toContain('Native window unavailable'));
    expect(document.querySelector('[data-auto-detach]')).toBeNull();
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it('allocates an owner draft uid before an empty compose detaches', async () => {
    const onDetach = vi.fn().mockResolvedValue(undefined);
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);

    fireEvent.click(await screen.findByTestId('compose-detach'));
    await waitFor(() => expect(onDetach).toHaveBeenCalledTimes(1));
    expect(onDetach.mock.calls[0][0]).toMatchObject({ _draftUid: 1, _draftAccountId: 'acct-1' });
  });

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

  it('does not reinitialize a typed reply when the global context default changes', async () => {
    const view = openReply(original);
    fireEvent.click(screen.getByTestId('editor-stub'));
    expect(screen.getByTestId('editor-stub').getAttribute('data-content')).toContain('Typed body survives');

    settings.composeContextVisible = false;
    view.rerender(<ComposeModal mode="reply" replyTo={original} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);

    expect(screen.getByTestId('editor-stub').getAttribute('data-content')).toContain('Typed body survives');
  });

  it('keeps full original context beside the complete composer, not below its editor', async () => {
    openReply(original);
    const shell = await screen.findByTestId('compose-content');
    const composer = screen.getByTestId('compose-main');
    const context = screen.getByTestId('compose-context');

    expect(composer.parentElement).toBe(shell);
    expect(context.parentElement).toBe(shell);
    expect(screen.getByRole('heading', { name: 'Reply' }).closest('[data-testid="compose-main"]')).toBe(composer);
    expect(screen.getByTestId('compose-send').closest('[data-testid="compose-main"]')).toBe(composer);
  });

  it('splits the compose surface equally or 75/25 and keeps manual resize available', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
      return this.dataset.testid === 'compose-content' ? 896 : 0;
    });
    try {
      openReply(original);
      await screen.findByTestId('compose-context');

      fireEvent.click(screen.getByTestId('compose-split-half'));
      expect(screen.getByTestId('compose-context').style.width).toBe('448px');
      expect(screen.getByTestId('compose-split-half').getAttribute('aria-pressed')).toBe('true');

      fireEvent.click(screen.getByTestId('compose-split-quarter'));
      expect(screen.getByTestId('compose-context').style.width).toBe('224px');
      expect(screen.getByTestId('compose-split-quarter').getAttribute('aria-pressed')).toBe('true');

      fireEvent.keyDown(screen.getByTestId('compose-resize'), { key: 'ArrowRight' });
      expect(screen.getByTestId('compose-context').style.width).toBe('244px');
      expect(screen.getByTestId('compose-split-quarter').getAttribute('aria-pressed')).toBe('false');
    } finally {
      width.mockRestore();
    }
  });

  it('groups the original window action with the original panel controls', async () => {
    openReply(original);
    const popout = await screen.findByTestId('compose-original-detach');
    expect(popout.closest('[data-testid="compose-context"]')).not.toBeNull();
    expect(popout.querySelector('[data-icon="ExternalLink"]')).not.toBeNull();

    fireEvent.click(screen.getByTestId('compose-context-toggle'));
    expect(screen.queryByTestId('compose-original-detach')).toBeNull();
    expect(screen.queryByTestId('compose-split-half')).toBeNull();
    expect(screen.queryByTestId('compose-split-quarter')).toBeNull();
    expect(screen.getByTestId('compose-context-toggle').getAttribute('aria-pressed')).toBe('false');
  });

  it('offers an accessible keyboard resize control for an embedded composer', async () => {
    openReply(original);
    const resize = await screen.findByTestId('compose-resize');
    expect(resize.getAttribute('role')).toBe('separator');
    expect(resize.getAttribute('aria-orientation')).toBe('vertical');
    expect(resize.tabIndex).toBe(0);
    const windowResize = screen.getByTestId('compose-window-resize');
    expect(windowResize.getAttribute('role')).toBe('separator');
    // Two key events can arrive in one browser turn. Functional state updates
    // must compose them instead of applying the second event to stale size.
    act(() => {
      windowResize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      windowResize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(screen.getByTestId('compose-modal').style.width).toBe('664px');
    expect(screen.getByTestId('compose-modal').style.height).toBe('496px');
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

  it('keeps reading context available while forwarding without adding a second outgoing quote', async () => {
    render(<ComposeModal mode="forward" replyTo={original} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
    expect(await screen.findByTestId('compose-context-panel')).not.toBeNull();
    expect(screen.getByTestId('compose-quoted')).not.toBeNull();
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
