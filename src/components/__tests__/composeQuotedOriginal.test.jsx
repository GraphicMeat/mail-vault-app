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

const { buildOutgoingMime, saveLocalDraft, readAttachments } = vi.hoisted(() => ({
  buildOutgoingMime: vi.fn().mockResolvedValue({
    rawBase64: 'AAAA', messageId: '<mine@example.test>', rawSize: 4,
  }),
  saveLocalDraft: vi.fn().mockResolvedValue(undefined),
  readAttachments: vi.fn(),
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
vi.mock('../../services/transport', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, send: (cmd, args) => (cmd === 'maildir_read_attachments' ? readAttachments(args) : actual.send(cmd, args)) };
});

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
const { emailKey } = await import('../../stores/slices/unifiedHelpers');

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
  settings.aliases = {};
  settings.lastComposeIdentity = null;
  settings.composeContextVisible = true;
  settings.composeOpenMode = undefined;
  settings.composeContextSplit = null;
  settings.composeSize = null;
  settings.emailViewerTheme = 'light';
  settings.setComposeContextSplit.mockClear();
  settings.setComposeSize.mockClear();
  settings.setComposeOpenMode.mockClear();
  delete mail.getChatEmails;
  delete mail.sortedEmails;
  delete mail.selectedThread;
  delete mail.unifiedFolder;
  mail.activeMailbox = 'INBOX';
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

  // The From row lists the account's aliases by name, and a message leaves
  // under the name of the alias it is sent from.
  it('sends under the chosen alias\'s name, and under the account\'s name once From changes back', async () => {
    settings.aliases = { 'acct-1': [{ address: 'desk@example.test', name: 'Front Desk', source: 'provider' }] };
    settings.sendAsAddresses = { 'acct-1': 'desk@example.test' };
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);

    await screen.findByTestId('compose-from');
    expect(screen.getByRole('option', { name: 'Front Desk <desk@example.test>' })).not.toBeNull();
    fireEvent.change(screen.getByTestId('compose-to'), { target: { value: 'recipient@example.test' } });
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(buildOutgoingMime).toHaveBeenCalledTimes(1));
    expect(buildOutgoingMime.mock.calls[0][0]).toMatchObject({ name: 'Front Desk', fromEmail: 'desk@example.test' });
    cleanup();

    buildOutgoingMime.mockClear();
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
    fireEvent.change(await screen.findByTestId('compose-from'), { target: { value: 'acct-1 me@example.test' } });
    fireEvent.change(screen.getByTestId('compose-to'), { target: { value: 'recipient@example.test' } });
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(buildOutgoingMime).toHaveBeenCalledTimes(1));
    expect(buildOutgoingMime.mock.calls[0][0].name).toBe('Me');
    expect(buildOutgoingMime.mock.calls[0][0].fromEmail).toBeUndefined();
  });

  // Adding an alias happens in Settings > Accounts > Aliases; the From row
  // links there, for the account the message is from.
  it('links from the From row to the account\'s aliases, keeping the draft', async () => {
    const onMinimize = vi.fn();
    const onSaveState = vi.fn();
    mail.requestSettingsTab = vi.fn();
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={onMinimize} onSaveState={onSaveState} />);
    await screen.findByTestId('compose-from');
    fireEvent.click(screen.getByTestId('compose-add-address'));
    await waitFor(() => expect(mail.requestSettingsTab).toHaveBeenCalledWith('accounts', { accountId: 'acct-1', section: 'aliases' }));
    expect(onSaveState).toHaveBeenCalled();
    expect(onMinimize).toHaveBeenCalled();
    delete mail.requestSettingsTab;
  });

  it('leaves the link to a compose window\'s own owner when it has one', async () => {
    const onOpenAliases = vi.fn();
    mail.requestSettingsTab = vi.fn();
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onOpenAliases={onOpenAliases} />);
    fireEvent.click(await screen.findByTestId('compose-add-address'));
    await waitFor(() => expect(onOpenAliases).toHaveBeenCalledWith('acct-1'));
    expect(mail.requestSettingsTab).not.toHaveBeenCalled();
    delete mail.requestSettingsTab;
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

  // Open in new window is remembered: every compose after it opens in a
  // window of its own, until Settings switches it back.
  it('remembers a pop-out as where every compose after it opens', async () => {
    const onDetach = vi.fn().mockResolvedValue(undefined);
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);

    fireEvent.click(await screen.findByTestId('compose-detach'));
    await waitFor(() => expect(settings.setComposeOpenMode).toHaveBeenCalledWith('window'));
    expect(settings.setComposeOpenMode).toHaveBeenCalledTimes(1);
  });

  it('remembers nothing from a pop-out that failed', async () => {
    const onDetach = vi.fn().mockRejectedValue(new Error('Native window unavailable'));
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);

    fireEvent.click(await screen.findByTestId('compose-detach'));
    await waitFor(() => expect(screen.getByTestId('compose-error').textContent).toContain('Native window unavailable'));
    expect(settings.setComposeOpenMode).not.toHaveBeenCalled();
  });

  it('never writes the setting when it only follows it', async () => {
    settings.composeOpenMode = 'window';
    const onDetach = vi.fn().mockResolvedValue(undefined);
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);

    await waitFor(() => expect(onDetach).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(settings.setComposeOpenMode).not.toHaveBeenCalled();
  });

  // Why a radial reply waits for its body when compose opens in its own
  // window (RowQuickActions.jsx): the handoff carries the draft as it stands,
  // once, and a native window never gets the later fill (utils/sameReply.js).
  it('hands a header-only reply to its window without the body, and never hands it again', async () => {
    settings.composeOpenMode = 'window';
    const onDetach = vi.fn().mockResolvedValue(undefined);
    const header = { ...original, html: '', text: '' };
    const view = render(<ComposeModal mode="reply" replyTo={header} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);

    await waitFor(() => expect(onDetach).toHaveBeenCalledTimes(1));
    expect(onDetach.mock.calls[0][0]._quotedHtml).toContain('Quote request');
    expect(onDetach.mock.calls[0][0]._quotedHtml).not.toContain('much');

    view.rerender(<ComposeModal mode="reply" replyTo={original} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);
    await act(async () => {});
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it('allocates an owner draft uid before an empty compose detaches', async () => {
    const onDetach = vi.fn().mockResolvedValue(undefined);
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onDetach={onDetach} />);

    fireEvent.click(await screen.findByTestId('compose-detach'));
    await waitFor(() => expect(onDetach).toHaveBeenCalledTimes(1));
    expect(onDetach.mock.calls[0][0]).toMatchObject({ _draftUid: 1, _draftAccountId: 'acct-1' });
  });

  // A compose moved into a window of its own had no way back. The window now
  // offers one, mirroring the pop-out the main window's compose offers.
  it('offers the move back into the main window only in a window of its own', async () => {
    const onAttach = vi.fn().mockResolvedValue(undefined);
    const inMain = render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}}
      onDetach={vi.fn()} onAttach={onAttach} />);
    await screen.findByTestId('compose-detach');
    expect(screen.queryByTestId('compose-attach')).toBeNull();
    inMain.unmount();

    render(<ComposeModal mode="new" detached onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onAttach={onAttach} />);
    const back = await screen.findByTestId('compose-attach');
    expect(back.getAttribute('aria-label')).toBe(back.getAttribute('title'));
    expect(back.getAttribute('title')).toBeTruthy();
    expect(screen.queryByTestId('compose-detach')).toBeNull();
  });

  it('hands the draft as it stands to the main window and stays frozen until the window goes', async () => {
    const onAttach = vi.fn(() => new Promise(() => {}));
    render(<ComposeModal mode="new" detached initialData={{ to: 'before@example.test', subject: 'Kept', body: '<p>Body</p>', _baseline: null }}
      onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onAttach={onAttach} />);

    fireEvent.change(await screen.findByTestId('compose-to'), { target: { value: 'typed@example.test' } });
    fireEvent.click(screen.getByTestId('compose-attach'));
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    expect(onAttach.mock.calls[0][0]).toMatchObject({ to: 'typed@example.test', subject: 'Kept' });
    expect(screen.getByTestId('compose-modal').hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByTestId('compose-attach'));
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it('unfreezes with the error when the main window refuses the draft', async () => {
    const onAttach = vi.fn().mockRejectedValue(new Error('Main window busy'));
    render(<ComposeModal mode="new" detached initialData={{ to: 'before@example.test', body: '<p>Body</p>', _baseline: null }}
      onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onAttach={onAttach} />);

    fireEvent.click(await screen.findByTestId('compose-attach'));
    await waitFor(() => expect(screen.getByTestId('compose-error').textContent).toContain('Main window busy'));
    expect(screen.getByTestId('compose-modal').hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('compose-to').value).toBe('before@example.test');
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

  // The detached compose window gets the original as HTML (no store to thread
  // from) and shows that one body. Light runs nothing; dark runs Dark Reader
  // under the reading pane's nonce CSP, which runs only scripts carrying it.
  const openDetachedReply = (replyTo) => render(<ComposeModal mode="reply" detached replyTo={replyTo}
    onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);

  it('shows a light original in a frame whose sandbox runs no script', async () => {
    openDetachedReply(original);
    const frame = (await expandQuote()).querySelector('iframe');

    expect(frame).not.toBeNull();
    // allow-same-origin alone: the app can measure the frame, nothing inside
    // it can run. Any added token is a decision, not a drive-by.
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    const shown = new DOMParser().parseFromString(frame.getAttribute('srcdoc'), 'text/html');
    expect(shown.documentElement.getAttribute('data-mv-theme')).toBe('light');
    expect(shown.body.textContent).toContain('Original Message');
    expect(shown.body.querySelector('b')?.textContent).toBe('much');
    expect(screen.queryByTestId('original-thread')).toBeNull();
  });

  it('shows a dark original with Dark Reader, and only nonced scripts may run', async () => {
    settings.emailViewerTheme = 'dark';
    openDetachedReply(original);
    const frame = (await expandQuote()).querySelector('iframe');

    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts');
    const shown = new DOMParser().parseFromString(frame.getAttribute('srcdoc'), 'text/html');
    expect(shown.documentElement.getAttribute('data-mv-theme')).toBe('dark');
    const csp = shown.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    const nonce = /'nonce-([^']+)'/.exec(csp)[1];
    const scripts = [...shown.querySelectorAll('script')];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script.getAttribute('nonce')).toBe(nonce);
  });

  it('flips the detached frame between light and dark with its toggle', async () => {
    openDetachedReply(original);
    const theme = () => new DOMParser().parseFromString(
      screen.getByTestId('compose-quoted').querySelector('iframe').getAttribute('srcdoc'), 'text/html',
    ).documentElement.getAttribute('data-mv-theme');
    await expandQuote();
    const toggle = screen.getByTestId('compose-original-theme');
    expect(theme()).toBe('light');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    expect(theme()).toBe('dark');
    expect(screen.getByTestId('compose-original-theme').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows full reading context by default and hides it with one toggle', async () => {
    openReply(original);
    const toggle = await screen.findByTestId('compose-context-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByTestId('compose-context-panel')).not.toBeNull();
    // Lazy-loaded: the thread lands a tick after the panel.
    expect((await screen.findByTestId('original-thread')).closest('[data-testid="compose-quoted"]')).not.toBeNull();

    fireEvent.click(toggle);
    expect((await screen.findByTestId('compose-context-toggle')).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('compose-context-panel')).toBeNull();
  });

  it('puts the show/hide-original toggle in the header, immediately left of minimize, with no reserved space when off', async () => {
    openReply(original);
    const toggle = await screen.findByTestId('compose-context-toggle');
    const minimize = screen.getByTitle('Minimize');
    // Immediately left, in DOM/reading order, of the minimize button — not
    // buried inside the (removed) original-message panel.
    expect(toggle.nextElementSibling).toBe(minimize);
    expect(toggle.closest('[data-testid="compose-context"]')).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide original message');

    fireEvent.click(toggle);
    // Re-read: the motion mock is a new component type per render (see the
    // resize-drag tests above), so a stale node never reflects the update.
    const toggled = await screen.findByTestId('compose-context-toggle');
    expect(toggled.getAttribute('aria-pressed')).toBe('false');
    expect(toggled.getAttribute('aria-label')).toBe('Show original message');
    // Nothing left reserved for the old arrow strip.
    expect(screen.queryByTestId('compose-context')).toBeNull();
    expect(screen.queryByTestId('compose-resize')).toBeNull();
  });

  it('offers no original-message toggle for a fresh compose with nothing to show', async () => {
    render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
    await screen.findByTestId('compose-to');
    expect(screen.queryByTestId('compose-context-toggle')).toBeNull();
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

  describe('the remembered split', () => {
    let width;
    beforeEach(() => {
      width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
        return this.dataset.testid === 'compose-content' ? 1000 : 0;
      });
    });
    afterEach(() => width.mockRestore());

    // jsdom may lack PointerEvent, and a plain Event drops clientX.
    const pointer = (el, type, clientX) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      fireEvent(el, event);
    };
    const contextWidth = () => screen.getByTestId('compose-context').style.width;
    // Re-read every time: the motion mock is a new component type per render.
    const resize = () => screen.getByTestId('compose-resize');

    it('persists the split as a ratio from the buttons, the keys and the end of a drag', async () => {
      openReply(original);
      await screen.findByTestId('compose-resize');

      fireEvent.click(screen.getByTestId('compose-split-half'));
      expect(settings.setComposeContextSplit).toHaveBeenLastCalledWith(0.5);

      fireEvent.keyDown(resize(), { key: 'ArrowRight' });
      expect(contextWidth()).toBe('520px');
      expect(settings.setComposeContextSplit).toHaveBeenLastCalledWith(0.52);

      settings.setComposeContextSplit.mockClear();
      pointer(resize(), 'pointerdown', 500);
      pointer(resize(), 'pointermove', 400);
      expect(contextWidth()).toBe('620px');
      expect(settings.setComposeContextSplit).not.toHaveBeenCalled();
      pointer(resize(), 'pointerup', 400);
      expect(settings.setComposeContextSplit).toHaveBeenCalledOnce();
      expect(settings.setComposeContextSplit).toHaveBeenLastCalledWith(0.62);
    });

    it('never lets either side go below 10% of the layout', async () => {
      openReply(original);
      await screen.findByTestId('compose-resize');
      expect(resize().getAttribute('aria-valuemin')).toBe('100');
      expect(resize().getAttribute('aria-valuemax')).toBe('900');

      pointer(resize(), 'pointerdown', 500);
      pointer(resize(), 'pointermove', -5000);
      expect(contextWidth()).toBe('900px');
      expect(resize().getAttribute('aria-valuenow')).toBe('900');
      pointer(resize(), 'pointermove', 5000);
      expect(contextWidth()).toBe('100px');
      expect(resize().getAttribute('aria-valuenow')).toBe('100');
      pointer(resize(), 'pointerup', 5000);
      expect(settings.setComposeContextSplit).toHaveBeenLastCalledWith(0.1);
    });

    it('opens every new reply at the remembered split', async () => {
      settings.composeContextSplit = 0.3;
      openReply(original);
      await screen.findByTestId('compose-context');
      expect(contextWidth()).toBe('300px');
    });

    it('keeps the split a handed-off draft carries', async () => {
      settings.composeContextSplit = 0.3;
      render(<ComposeModal mode="reply" initialData={{
        to: 'them@example.test', subject: 'Re: Quote request', body: '<p>Draft</p>',
        _contextHtml: '<p>Original</p>', _showContext: true, _contextSplit: 0.6, _baseline: null,
      }} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
      await screen.findByTestId('compose-context-panel');
      expect(contextWidth()).toBe('600px');
    });
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

  describe('the remembered compose size', () => {
    it('reopens the embedded composer at the last size it was resized to', async () => {
      settings.composeSize = { width: 700, height: 650 };
      render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
      const modal = await screen.findByTestId('compose-modal');
      expect(modal.style.width).toBe('700px');
      expect(modal.style.height).toBe('650px');
    });

    it('floors a remembered size below 200x200 on reopen', async () => {
      settings.composeSize = { width: 50, height: 90 };
      render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
      const modal = await screen.findByTestId('compose-modal');
      expect(modal.style.width).toBe('200px');
      expect(modal.style.height).toBe('200px');
    });

    it('clamps a size saved on a bigger screen down to the current viewport on reopen', async () => {
      settings.composeSize = { width: 5000, height: 4000 };
      render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
      const modal = await screen.findByTestId('compose-modal');
      expect(modal.style.width).toBe(`${window.innerWidth - 32}px`);
      expect(modal.style.height).toBe(`${window.innerHeight - 32}px`);
    });

    it('lets a restored draft\'s own size win over the remembered global size', async () => {
      settings.composeSize = { width: 700, height: 650 };
      render(<ComposeModal mode="new" initialData={{
        to: 'saved@example.test', subject: '', body: '<p>Draft</p>',
        _composeSize: { width: 500, height: 420 }, _baseline: null,
      }} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
      const modal = await screen.findByTestId('compose-modal');
      expect(modal.style.width).toBe('500px');
      expect(modal.style.height).toBe('420px');
    });

    it('has no remembered size to apply by default, so a fresh install opens at the CSS default', async () => {
      render(<ComposeModal mode="new" onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
      const modal = await screen.findByTestId('compose-modal');
      expect(modal.style.width).toBe('');
      expect(modal.style.height).toBe('');
    });
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
    const pane = await screen.findByTestId('original-thread');
    expect(pane.getAttribute('data-subjects')).toBe('Quote request|Follow up');
    expect(pane.getAttribute('data-read-only')).toBe('true');
  });

  // The reading pane loads a message without its attachment bytes. A forward
  // of it went out with contentless attachments, which the daemon refused
  // ("Missing or invalid email"). A row in a single-account folder carries no
  // `_accountId` or `_mailbox`, so the bytes are read from where the view
  // locates it.
  it('forwards the original\'s attachments with their bytes read from where it lives', async () => {
    readAttachments.mockResolvedValue(['UERGMQ==', 'UERGMg==']);
    const light = { ...original, attachments: [
      { filename: 'a.pdf', contentType: 'application/pdf', size: 4 },
      { filename: 'b.pdf', contentType: 'application/pdf', size: 4 },
    ] };
    render(<ComposeModal mode="forward" replyTo={light} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
    await screen.findByText('b.pdf');

    fireEvent.change(screen.getByTestId('compose-to'), { target: { value: 'recipient@example.test' } });
    fireEvent.click(screen.getByTestId('compose-send'));
    await waitFor(() => expect(buildOutgoingMime).toHaveBeenCalled());

    expect(readAttachments).toHaveBeenCalledWith({ accountId: 'acct-1', mailbox: 'INBOX', uid: 10, attachmentIndices: [0, 1] });
    expect(buildOutgoingMime.mock.calls[0][1].attachments.map(a => [a.filename, a.content]))
      .toEqual([['a.pdf', 'UERGMQ=='], ['b.pdf', 'UERGMg==']]);
    readAttachments.mockReset();
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

    // The attribution sits above the blockquote, so a reader that folds the
    // quote still shows who wrote it.
    expect(sent.html.startsWith('<hr><p><strong>Original Message</strong><br>From: Them &lt;them@example.test&gt;<br>Date: ')).toBe(true);
    expect(sent.html.endsWith(`<br>Subject: Quote request<br>To: me@example.test</p><blockquote>${original.html}</blockquote>`)).toBe(true);
  });
});

describe('the original beside a reply', () => {
  const reply = {
    uid: 3,
    _mailbox: 'Sent',
    _accountId: 'acct-1',
    _fromSentFolder: true,
    messageId: '<reply@example.test>',
    inReplyTo: '<parent@example.test>',
    references: ['<parent@example.test>'],
    subject: 'Re: Quote request',
    from: { address: 'me@example.test', name: 'Me' },
    to: [{ address: 'them@example.test' }],
    date: '2026-09-08T09:00:00Z',
    flags: ['\\Seen'],
  };
  // Lazy-loaded, so found, not queried; always inside the pane.
  const pane = async () => {
    const thread = await screen.findByTestId('original-thread');
    expect(thread.closest('[data-testid="compose-quoted"]')).not.toBeNull();
    return thread;
  };

  it('shows the split choices as icons, still named for assistive tech', async () => {
    openReply(original);
    const half = await screen.findByTestId('compose-split-half');
    const quarter = screen.getByTestId('compose-split-quarter');

    expect(half.querySelector('[data-icon="Columns"]')).not.toBeNull();
    expect(quarter.querySelector('[data-icon="PanelRight"]')).not.toBeNull();
    expect(half.getAttribute('aria-label')).toBe('Split compose/original 50/50');
    expect(half.getAttribute('title')).toBe('Split compose/original 50/50');
    expect(quarter.getAttribute('aria-label')).toBe('Split compose/original 75/25');
    expect(quarter.getAttribute('title')).toBe('Split compose/original 75/25');
    expect(half.textContent).not.toContain('50/50');
    expect(quarter.textContent).not.toContain('75/25');
  });

  it('reads the replied message in the thread the list shows, Sent replies included', async () => {
    // The Sent reply lives only in the list's INBOX+Sent pool, and the replied
    // message carries no thread of its own: only the list can supply it.
    mail.getChatEmails = () => [reply, { ...original, _accountId: 'acct-1', _mailbox: 'INBOX' }];
    openReply({ ...original, _accountId: 'acct-1', _mailbox: 'INBOX' });

    const thread = await pane();
    expect(thread.getAttribute('data-read-only')).toBe('true');
    expect(thread.getAttribute('data-subjects').split('|').sort()).toEqual(['Quote request', 'Re: Quote request']);
    expect(thread.getAttribute('data-open-key')).toBe(emailKey({ ...original, _accountId: 'acct-1', _mailbox: 'INBOX' }));
  });

  it('reads a message the list does not hold as that one message', async () => {
    mail.getChatEmails = () => [reply];
    openReply(original);

    const thread = await pane();
    expect(thread.getAttribute('data-read-only')).toBe('true');
    expect(thread.getAttribute('data-subjects')).toBe('Quote request');
    expect(thread.getAttribute('data-open-key')).toBe(emailKey(original));
  });

  it('finds the list thread in All inboxes by a Message-ID spelled apart, with no folder on the body', async () => {
    // A fetched body names its account, not its folder, and All inboxes has
    // no folder to guess: only the canonical Message-ID can match.
    mail.activeMailbox = 'UNIFIED';
    mail.unifiedFolder = 'INBOX';
    mail.getChatEmails = () => [reply, { ...original, _accountId: 'acct-1', _mailbox: 'INBOX' }];
    openReply({ ...original, _accountId: 'acct-1', messageId: ' parent@example.test ' });

    const thread = await pane();
    expect(thread.getAttribute('data-subjects').split('|').sort()).toEqual(['Quote request', 'Re: Quote request']);
    expect(thread.getAttribute('data-open-key')).toBe(emailKey({ ...original, _accountId: 'acct-1', _mailbox: 'INBOX' }));
  });

  it('never takes another folder\'s row that shares the uid of a body with no folder', async () => {
    // Replying to my own Sent message from its body: uid 10 there is not
    // INBOX uid 10, whatever folder is open.
    mail.getChatEmails = () => [reply, { ...original, _accountId: 'acct-1', _mailbox: 'INBOX' }];
    const mine = { ...original, _accountId: 'acct-1', messageId: '<mine@example.test>', subject: 'My own', from: { address: 'me@example.test' }, to: [{ address: 'x@example.test' }] };
    openReply(mine);

    const thread = await pane();
    expect(thread.getAttribute('data-subjects')).toBe('My own');
    expect(thread.getAttribute('data-open-key')).toBe(emailKey(mine));
  });

  it('opens in the email theme the reader uses', async () => {
    settings.emailViewerTheme = 'dark';
    openReply(original);
    expect((await pane()).getAttribute('data-dark')).toBe('true');
    expect(screen.getByTestId('compose-original-theme').getAttribute('aria-pressed')).toBe('true');
  });

  it('flips light and dark for this compose only, with a pressed state and a name', async () => {
    openReply(original);
    const toggle = await screen.findByTestId('compose-original-theme');
    expect((await pane()).getAttribute('data-dark')).toBe('false');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('title')).toBe('Dark');
    expect(toggle.getAttribute('aria-label')).toBe('Dark');

    fireEvent.click(toggle);
    expect((await pane()).getAttribute('data-dark')).toBe('true');
    const pressed = screen.getByTestId('compose-original-theme');
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    expect(pressed.getAttribute('title')).toBe('Light');
    // A toggle keeps one name; its state is aria-pressed ("Dark, pressed").
    expect(pressed.getAttribute('aria-label')).toBe('Dark');
    // The setting the reader reads is untouched.
    expect(settings.emailViewerTheme).toBe('light');
  });

  it('keeps the flipped theme through a minimize or detach, and reopens in it', async () => {
    const onSaveState = vi.fn();
    render(<ComposeModal mode="reply" replyTo={original} onClose={() => {}} onMinimize={() => {}} onSaveState={onSaveState} />);
    fireEvent.click(await screen.findByTestId('compose-original-theme'));
    await waitFor(() => expect(onSaveState).toHaveBeenLastCalledWith(expect.objectContaining({ _originalDark: true })));
    cleanup();

    render(<ComposeModal mode="reply" initialData={{
      to: 'them@example.test', subject: 'Re: Quote request', body: '<p>Draft</p>', _replyTo: original,
      _contextHtml: '<p>Original</p>', _showContext: true, _originalDark: true, _baseline: null,
    }} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
    expect((await pane()).getAttribute('data-dark')).toBe('true');
  });
});
