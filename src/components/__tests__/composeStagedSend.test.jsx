// @vitest-environment jsdom
//
// What the Sent list is allowed to claim, and when.
//
// The daemon archives the outgoing bytes to the vault BEFORE the send
// (`compose.stage`) — that is the safety net and it stays. What it must not do is put a row in
// `sentEmails` before the message has left: a send that fails then leaves a
// copy sitting in the Sent folder (and, since threading headers were added to
// it, inside the conversation) claiming to be a message you sent.
//
// The retry half of the same story: `retryOutbox` re-runs THIS closure. The
// daemon mints a fresh Message-ID and uid on every `compose.stage`, so staging
// per attempt leaves the previous attempt's .eml, index entry and row behind —
// and puts two copies of one message on the wire that no recipient can pair up.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const { invoke, sendStaged, stageOutgoing, listen } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  sendStaged: vi.fn(),
  stageOutgoing: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: (...a) => listen(...a) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a) => invoke(...a) }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ label: 'main' }) }));
// maildir_store/maildir_delete/local_index_remove now route through
// transport.js (Task 2.1); delegate to the same `invoke` mock so
// storedUids() and every existing assertion below still see them.
vi.mock('../../services/transport', () => ({ send: (...a) => invoke(...a) }));
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
  RichTextEditor: ({ placeholder }) => React.createElement('div', { className: 'ProseMirror', 'data-testid': 'editor-stub' }, placeholder),
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
  activeMailbox: 'Sent',
  mailboxes: [{ path: 'INBOX', name: 'INBOX' }, { path: 'Sent', name: 'Sent', specialUse: '\\Sent' }],
  sentEmails: [],
  emails: [],
  totalEmails: 0,
  updateSortedEmails: vi.fn(),
  loadSentHeaders: vi.fn(),
  // Send now, and keep the closure: retryOutbox re-runs this exact function.
  queueSend: (_state, sendFn) => {
    mail._sendFn = sendFn;
    mail._sendError = null;
    mail._inFlight = sendFn().catch((err) => { mail._sendError = err; });
  },
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
// to host its body loader.
vi.mock('../email/ThreadView', () => ({ ThreadView: () => null }));

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

/** Rust mints a new Message-ID per build — model that, or the test cannot see a rebuild. */
let mimeSeq = 0;

beforeEach(() => {
  mail.sentEmails = [];
  mail.emails = [];
  mail._sendFn = null;
  mail._sendError = null;
  mimeSeq = 0;
  window.__TAURI__ = { core: { invoke } };
  invoke.mockClear();
  settings.setLastComposeIdentity.mockClear();
  listen.mockClear();
  sendStaged.mockReset();
  stageOutgoing.mockReset();
  stageOutgoing.mockImplementation(async () => {
    mimeSeq += 1;
    const messageId = `<mine-${mimeSeq}@example.test>`;
    const uid = 1000 + mimeSeq;
    return {
      uid, mailbox: 'Sent', messageId,
      entry: { uid, message_id: messageId, in_reply_to: '<parent@example.test>', flags: ['draft', 'seen'], source: 'local_draft' },
    };
  });
});
afterEach(() => { cleanup(); delete window.__TAURI__; });

/** Open a reply and hit Send. Resolves once the send attempt has settled. */
async function sendReply() {
  render(<ComposeModal mode="reply" replyTo={parent} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} />);
  (await screen.findByTestId('compose-send')).click();
  await waitFor(() => expect(sendStaged).toHaveBeenCalled());
  await mail._inFlight;
}

/** The staged uid every send attempt named, in order. */
const storedUids = () => sendStaged.mock.calls.map(([, , params]) => params.uid);

describe('a send that fails', () => {
  it('puts nothing in the Sent list — the message never left', async () => {
    sendStaged.mockRejectedValue(new Error('Connection refused'));

    await sendReply();

    expect(mail._sendError).toBeTruthy();
    expect(mail.sentEmails).toEqual([]);
    expect(mail.emails).toEqual([]);
  });

  it('still archives the bytes to the vault first — the safety net is untouched', async () => {
    sendStaged.mockRejectedValue(new Error('Connection refused'));

    await sendReply();

    expect(stageOutgoing).toHaveBeenCalledTimes(1);
    expect(stageOutgoing.mock.calls[0][2]).toMatchObject({ accountId: 'acct-1', mailbox: 'Sent' });
    expect(stageOutgoing.mock.invocationCallOrder[0]).toBeLessThan(sendStaged.mock.invocationCallOrder[0]);
    expect(storedUids()).toEqual([1001]);
  });

  it('does not move the remembered compose identity', async () => {
    sendStaged.mockRejectedValue(new Error('Connection refused'));

    await sendReply();

    // "The identity that sent last" has to mean sent — an attempt that never
    // left would otherwise redirect the next new message on a failure.
    expect(settings.setLastComposeIdentity).not.toHaveBeenCalled();
  });
});

describe('a send that succeeds', () => {
  it('shows the row once the message is out, not flagged as a draft', async () => {
    sendStaged.mockResolvedValue({ messageId: '<mine-1@example.test>' });

    await sendReply();

    expect(mail.sentEmails).toHaveLength(1);
    expect(mail.sentEmails[0].flags).toEqual(['\\Seen']);
    // The row still has to thread — that is what put it in the conversation.
    expect(mail.sentEmails[0].inReplyTo).toBe('<parent@example.test>');
    expect(mail.emails).toHaveLength(1);
  });

  it('remembers the identity that sent it', async () => {
    sendStaged.mockResolvedValue({ messageId: '<mine-1@example.test>' });

    await sendReply();

    expect(settings.setLastComposeIdentity).toHaveBeenCalledWith('acct-1', 'me@example.test');
  });
});

describe('the Sent reconcile', () => {
  it('is listening for the server APPEND before the message is handed to SMTP', async () => {
    // Rust spawns the Sent APPEND the moment SMTP returns, and it can complete
    // before a subscription opened afterwards exists — on a server that answers
    // fast (Proton Mail Bridge on loopback, the e2e mock) the event was simply
    // missed, and with it the local-copy cleanup, the optimistic-row swap and
    // the Sent re-read. Assert the order rather than the effect: the effect is
    // a race and would pass on a slow enough mock.
    let subscribedFirst = null;
    sendStaged.mockImplementation(async () => {
      subscribedFirst = listen.mock.calls.some(([name]) => name === 'send-server-append-complete');
      return { messageId: '<mine-1@example.test>' };
    });

    await sendReply();

    expect(subscribedFirst).toBe(true);
  });
});

describe('onSend', () => {
  // The bug-report cooldown (BugReportDialog.jsx) stamps off this callback, on
  // whichever compose window App.jsx flagged `bugReport: true`. It has to fire
  // the moment Send commits the message to the queue — not on mere open, and
  // not gated on the eventual SMTP result, which lands later via `_inFlight`.
  it('fires once Send has queued the message, whether or not it later succeeds', async () => {
    sendStaged.mockRejectedValue(new Error('Connection refused'));
    const onSend = vi.fn();
    render(<ComposeModal mode="reply" replyTo={parent} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onSend={onSend} />);
    (await screen.findByTestId('compose-send')).click();
    // handleSend awaits the draft save chain before queueing, so onSend lands
    // a tick after the click, not synchronously with it.
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sendStaged).toHaveBeenCalled());
    await mail._inFlight;
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('never fires just from opening the window', async () => {
    const onSend = vi.fn();
    render(<ComposeModal mode="reply" replyTo={parent} onClose={() => {}} onMinimize={() => {}} onSaveState={() => {}} onSend={onSend} />);
    await screen.findByTestId('compose-send');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('a retry after a failure', () => {
  it('reuses the staged copy instead of leaving the first attempt behind', async () => {
    sendStaged.mockRejectedValueOnce(new Error('Connection refused'));
    sendStaged.mockResolvedValueOnce({ messageId: '<mine-1@example.test>' });

    await sendReply();
    expect(mail.sentEmails).toEqual([]);

    // What retryOutbox does: re-run the same closure.
    await mail._sendFn();

    // One message, one identity: the vault was written under one uid, and the
    // wire carried one Message-ID.
    expect(new Set(storedUids()).size).toBe(1);
    expect(stageOutgoing).toHaveBeenCalledTimes(1);
    expect(mail.sentEmails).toHaveLength(1);
    expect(mail.sentEmails[0].messageId).toBe('<mine-1@example.test>');
  });
});
