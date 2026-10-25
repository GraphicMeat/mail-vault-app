// @vitest-environment jsdom
//
// The send closure is intentionally independent of a mounted compose window:
// an undo timer or detached window may outlive the editor that created it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  invoke, stageOutgoing, sendStaged, cleanupDraftFor, markAnswered, markForwarded, createSchedule, ensureFreshToken,
  replaceSchedule, cancelSchedule, billing, listeners, daemonCall,
} = vi.hoisted(() => ({
  daemonCall: vi.fn().mockResolvedValue({}),
  // Every `listen` subscription: its event name, handler, and unlisten spy.
  listeners: [],
  billing: { premium: true },
  replaceSchedule: vi.fn().mockResolvedValue(undefined),
  cancelSchedule: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue(undefined),
  stageOutgoing: vi.fn(),
  sendStaged: vi.fn(),
  cleanupDraftFor: vi.fn().mockResolvedValue(undefined),
  markAnswered: vi.fn().mockResolvedValue(undefined),
  markForwarded: vi.fn().mockResolvedValue(undefined),
  createSchedule: vi.fn().mockResolvedValue(undefined),
  ensureFreshToken: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name, handler) => {
    const entry = { name, handler, unlisten: vi.fn() };
    listeners.push(entry);
    return entry.unlisten;
  }),
}));
vi.mock('../transport', () => ({ send: (...args) => invoke(...args) }));
vi.mock('../daemonClient', () => ({ daemonCall: (...args) => daemonCall(...args) }));
vi.mock('../api', () => ({
  stageOutgoing: (...args) => stageOutgoing(...args),
  sendStaged: (...args) => sendStaged(...args),
  ensureSentMailbox: vi.fn().mockResolvedValue('Sent'),
}));
vi.mock('../db', () => ({ getCachedMailboxes: vi.fn().mockResolvedValue([]), saveAccount: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../authUtils', () => ({ ensureFreshToken: (...args) => ensureFreshToken(...args) }));
vi.mock('../localDrafts', () => ({ cleanupDraftFor: (...args) => cleanupDraftFor(...args) }));
vi.mock('../workflows/messageMutations', () => ({
  markAnswered: (...args) => markAnswered(...args),
  markForwarded: (...args) => markForwarded(...args),
}));
vi.mock('../../stores/mailStore', () => {
  const state = {
    activeAccountId: 'acct-1', activeMailbox: 'Sent',
    mailboxes: [{ path: 'Sent', specialUse: '\\Sent' }], sentEmails: [], emails: [], localEmails: [],
    updateSortedEmails: vi.fn(), loadSentHeaders: vi.fn(),
  };
  const hook = vi.fn(selector => selector(state));
  hook.getState = () => state;
  hook.setState = update => Object.assign(state, typeof update === 'function' ? update(state) : update);
  return { useMailStore: hook };
});
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ setLastComposeIdentity: vi.fn() }) },
  hasPremiumAccess: () => billing.premium,
}));
vi.mock('../../stores/scheduledStore', () => ({
  useScheduledStore: { getState: () => ({
    create: (...args) => createSchedule(...args),
    replace: (...args) => replaceSchedule(...args),
    cancel: (...args) => cancelSchedule(...args),
  }) },
}));
vi.mock('../../components/RichTextEditor', () => ({
  htmlToText: html => (html || '').replace(/<[^>]*>/g, ''),
  inlineComposeSpacing: html => html,
}));
vi.mock('../../utils/inlineImages', () => ({ extractInlineImages: html => ({ html, attachments: [] }) }));

const { buildOutgoingPayload, createComposeSend, scheduleCompose } = await import('../composeSend');
const mailStore = await import('../../stores/mailStore');

const account = { id: 'acct-1', email: 'me@example.test', name: 'Account name' };
const snapshot = {
  to: 'recipient@example.test', cc: '', bcc: '', subject: 'A subject', body: '<p>Hello</p>',
  inReplyTo: '<parent@example.test>', references: '<root@example.test> <parent@example.test>',
  attachments: [], _accountId: 'acct-1', _fromAddress: 'alias@example.test',
  _quotedHtml: '<p>Prior message</p>', _draftUid: 42, _draftMailbox: 'Drafts',
};

// What the daemon answers: the staged copy, then the row of the sent one.
const STAGED_UID = 1_700_000_000;
const row = (extra = {}) => ({
  uid: STAGED_UID, from: { address: 'alias@example.test', name: 'Alias name' },
  to: [{ address: 'recipient@example.test', name: '' }], subject: 'A subject', date: '2026-10-18T09:00:00.000Z',
  has_attachments: false, message_id: '<one@example.test>', in_reply_to: '<parent@example.test>',
  references: ['<root@example.test>', '<parent@example.test>'], snippet: 'Hello', ...extra,
});
const stagedReply = () => ({
  uid: STAGED_UID, mailbox: 'Sent', messageId: '<one@example.test>',
  entry: row({ flags: ['draft', 'seen'], source: 'local_draft' }),
});
const sentReply = () => ({ success: true, messageId: '250 OK', entry: row({ flags: ['archived', 'seen'], source: 'local_sent' }) });

beforeEach(() => {
  window.__TAURI__ = { core: { invoke } };
  invoke.mockClear();
  stageOutgoing.mockReset();
  stageOutgoing.mockImplementation(async () => stagedReply());
  sendStaged.mockReset();
  sendStaged.mockImplementation(async () => sentReply());
  cleanupDraftFor.mockReset().mockResolvedValue(undefined);
  markAnswered.mockClear();
  markForwarded.mockClear();
  createSchedule.mockReset();
  createSchedule.mockResolvedValue(undefined);
  replaceSchedule.mockReset();
  replaceSchedule.mockResolvedValue(undefined);
  cancelSchedule.mockReset();
  cancelSchedule.mockResolvedValue(undefined);
  ensureFreshToken.mockReset();
  ensureFreshToken.mockImplementation(async item => item);
  billing.premium = true;
  daemonCall.mockReset();
  daemonCall.mockResolvedValue({});
  const state = mailStore.useMailStore.getState();
  state.sentEmails = [];
  state.emails = [];
  listeners.length = 0;
  vi.useRealTimers();
});

describe('buildOutgoingPayload', () => {
  it('builds the quoted wire payload from the serializable compose snapshot', async () => {
    const built = await buildOutgoingPayload({ snapshot, account, settings: { displayName: 'Alias name' } });

    expect(built.fromAddress).toBe('alias@example.test');
    expect(built.sendAsEmail).toBe('alias@example.test');
    expect(built.outgoingPayload).toMatchObject({
      to: 'recipient@example.test', subject: 'A subject', inReplyTo: '<parent@example.test>',
      references: '<root@example.test> <parent@example.test>',
    });
    expect(built.outgoingPayload.html).toContain('<blockquote><p>Prior message</p></blockquote>');
    expect(built.outgoingPayload.text).toContain('Original Message');
  });

  it('puts the quote header above the blockquote, not inside it', async () => {
    const header = '<p><strong>Original Message</strong><br>From: Them &lt;them@example.test&gt;</p>';
    const built = await buildOutgoingPayload({
      snapshot: { ...snapshot, _quotedHtml: `${header}<p>Prior message</p>` }, account, settings: {},
    });

    expect(built.outgoingPayload.html.endsWith(`<hr data-mailvault-quote="reply">${header}<blockquote><p>Prior message</p></blockquote>`)).toBe(true);
  });

  // A forward copies the original's attachment list, and the light fetch that
  // loaded it carries no bytes. Without them the daemon refused the whole
  // payload ("Missing or invalid email") and the forward could not be sent.
  it('reads a forwarded attachment\'s bytes back from the original message', async () => {
    const source = index => ({ accountId: 'acct-2', mailbox: 'INBOX', uid: 9, attachmentIndex: index });
    invoke.mockImplementation(async (cmd) => (cmd === 'maildir_read_attachments' ? ['UERGMQ==', 'UERGMg=='] : undefined));
    const built = await buildOutgoingPayload({
      snapshot: { ...snapshot, attachments: [
        { filename: 'mine.txt', contentType: 'text/plain', content: 'aGk=' },
        { filename: 'a.pdf', contentType: 'application/pdf', _source: source(1) },
        { filename: 'b.pdf', contentType: 'application/pdf', _source: source(3) },
      ] },
      account, settings: {},
    });

    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'maildir_read_attachments'))
      .toEqual([['maildir_read_attachments', { accountId: 'acct-2', mailbox: 'INBOX', uid: 9, attachmentIndices: [1, 3] }]]);
    expect(built.outgoingPayload.attachments.map(a => [a.filename, a.content]))
      .toEqual([['mine.txt', 'aGk='], ['a.pdf', 'UERGMQ=='], ['b.pdf', 'UERGMg==']]);
    invoke.mockImplementation(async () => undefined);
  });

  it('refuses, naming the file, when a forwarded attachment cannot be read', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'maildir_read_attachments' ? [null] : undefined));
    await expect(buildOutgoingPayload({
      snapshot: { ...snapshot, attachments: [
        { filename: 'gone.pdf', _source: { accountId: 'acct-1', mailbox: 'INBOX', uid: 9, attachmentIndex: 0 } },
      ] },
      account, settings: {},
    })).rejects.toThrow('gone.pdf');
    await expect(buildOutgoingPayload({
      snapshot: { ...snapshot, attachments: [{ filename: 'nowhere.pdf' }] }, account, settings: {},
    })).rejects.toThrow('nowhere.pdf');
    invoke.mockImplementation(async () => undefined);
  });
});

// Graph and JMAP file their own Sent copy, so the daemon is told not to
// APPEND one: `sentMailbox` is null for them, the folder path for IMAP.
describe('the Sent folder a send names', () => {
  it('is null for a JMAP account, whose server saves the copy itself', async () => {
    const jmap = { ...account, jmapSessionUrl: 'https://api.example.test/jmap/session', jmapAuth: 'bearer' };
    const built = await buildOutgoingPayload({ snapshot, account: jmap, settings: {} });
    expect(built.sentMailbox).toBeNull();
  });

  it('is null for a Graph account and the folder for an IMAP one', async () => {
    expect((await buildOutgoingPayload({ snapshot, account: { ...account, oauth2Transport: 'graph' }, settings: {} })).sentMailbox).toBeNull();
    expect((await buildOutgoingPayload({ snapshot, account, settings: {} })).sentMailbox).toBe('Sent');
  });
});

const sendParams = () => sendStaged.mock.calls.map(([, , params]) => params);

describe('createComposeSend', () => {
  it('stages once and sends the same uid and Message-ID when the queued closure retries', async () => {
    sendStaged.mockRejectedValueOnce(new Error('offline'));
    const sendFn = createComposeSend({ snapshot, mode: 'reply', replyTo: { uid: 7 }, account, settings: { displayName: 'Alias name' } });

    await expect(sendFn()).rejects.toThrow('offline');
    await sendFn();

    expect(stageOutgoing).toHaveBeenCalledTimes(1);
    expect(stageOutgoing).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'me@example.test', fromEmail: 'alias@example.test', name: 'Alias name' }),
      expect.objectContaining({ to: 'recipient@example.test', subject: 'A subject' }),
      { accountId: 'acct-1', mailbox: 'Sent', snippet: 'Hello', hasAttachments: false },
    );
    expect(sendParams().map(p => [p.uid, p.messageId, p.mailbox])).toEqual([
      [STAGED_UID, '<one@example.test>', 'Sent'], [STAGED_UID, '<one@example.test>', 'Sent'],
    ]);
    expect(cleanupDraftFor).toHaveBeenCalledWith(snapshot);
    expect(mailStore.useMailStore.getState().sentEmails).toHaveLength(1);
    expect(mailStore.useMailStore.getState().sentEmails[0]).toMatchObject({
      uid: STAGED_UID, messageId: '<one@example.test>', inReplyTo: '<parent@example.test>',
      references: ['<root@example.test>', '<parent@example.test>'], flags: ['\\Seen'], _optimistic: true,
    });
    expect(mailStore.useMailStore.getState().sentEmails[0].source).toBeUndefined();
  });

  /// The daemon owns the copy now: the app writes no vault file, no index row
  /// and makes no SMTP call of its own on any path of a send.
  it('leaves the vault, the index and the transport to the daemon', async () => {
    await createComposeSend({ snapshot, mode: 'reply', replyTo: { uid: 7 }, account })();
    const { handler } = listeners.find(l => l.name === 'send-server-append-complete');
    await handler({ payload: { accountId: 'me@example.test', mailbox: 'Sent', ok: true, messageIdHeader: 'one@example.test' } });

    const commands = invoke.mock.calls.map(([command]) => command);
    for (const command of ['maildir_store', 'maildir_delete', 'local_index_append', 'local_index_remove', 'smtp_build_mime', 'smtp_send_email']) {
      expect(commands).not.toContain(command);
    }
  });

  it('says what could not be prepared or kept, in compose\'s own words', async () => {
    stageOutgoing.mockRejectedValueOnce(new Error('E_COMPOSE_BUILD: Invalid to address: no recipients'));
    await expect(createComposeSend({ snapshot, mode: 'new', replyTo: null, account })())
      .rejects.toThrow('Could not prepare the outgoing email: Invalid to address: no recipients');
    stageOutgoing.mockRejectedValueOnce(new Error('E_COMPOSE_STAGE: disk full'));
    await expect(createComposeSend({ snapshot, mode: 'new', replyTo: null, account })())
      .rejects.toThrow('Could not archive the outgoing email locally: disk full');
    expect(sendStaged).not.toHaveBeenCalled();
  });

  /// compose.stage can also refuse without a code (a malformed payload, a
  /// lost worker): it still reads as compose's own "could not prepare".
  it('wraps an untagged stage refusal in compose\'s words, once', async () => {
    stageOutgoing.mockRejectedValueOnce(new Error('Invalid email: missing field `content`'));
    await expect(createComposeSend({ snapshot, mode: 'new', replyTo: null, account })())
      .rejects.toThrow(/^Could not prepare the outgoing email: Invalid email: missing field `content`$/);
    stageOutgoing.mockRejectedValueOnce(new Error('Could not archive the outgoing email locally: disk full'));
    await expect(createComposeSend({ snapshot, mode: 'new', replyTo: null, account })())
      .rejects.toThrow(/^Could not archive the outgoing email locally: disk full$/);
    expect(sendStaged).not.toHaveBeenCalled();
  });

  /// An edited scheduled email sent now instead: the daemon cancels its row
  /// once the mail is really out (src-daemon handlers/compose.rs).
  it('hands the edited scheduled row to the daemon to cancel after the send', async () => {
    const edited = { ...snapshot, _editScheduledId: 'row-1', _editScheduledRow: { accountId: 'acct-1' } };
    await createComposeSend({ snapshot: edited, mode: 'new', replyTo: null, account })();
    expect(cancelSchedule).not.toHaveBeenCalled();
    expect(sendParams()[0].cancelScheduledId).toBe('row-1');
  });

  /// Due inside the undo window: the row would fire while this copy waits, so
  /// it goes at hand-off, and an Undo reopens compose as a new email.
  it('cancels an edited row due within the send delay at hand-off, not after the send', async () => {
    const soon = new Date(Date.now() + 2 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const localTime = `${soon.getUTCFullYear()}-${pad(soon.getUTCMonth() + 1)}-${pad(soon.getUTCDate())}T${pad(soon.getUTCHours())}:${pad(soon.getUTCMinutes())}`;
    const edited = { ...snapshot, _editScheduledId: 'row-1', _editScheduledRow: { accountId: 'acct-1', localTime, tz: 'UTC' } };

    const sendFn = createComposeSend({ snapshot: edited, mode: 'new', replyTo: null, account });
    expect(cancelSchedule).toHaveBeenCalledWith('row-1');
    expect(edited._editScheduledId).toBeUndefined();
    expect(edited._editScheduledRow).toBeUndefined();

    await sendFn();
    expect(cancelSchedule).toHaveBeenCalledTimes(1);
    expect(sendParams()[0].cancelScheduledId).toBeNull();
  });

  it('keeps an edited row due after the send delay queued until the send is out', async () => {
    const edited = { ...snapshot, _editScheduledId: 'row-1', _editScheduledRow: { accountId: 'acct-1', localTime: '2099-01-01T09:00', tz: 'UTC' } };
    const sendFn = createComposeSend({ snapshot: edited, mode: 'new', replyTo: null, account });
    expect(cancelSchedule).not.toHaveBeenCalled();

    await sendFn();
    expect(sendParams()[0].cancelScheduledId).toBe('row-1');
  });

  it('never names a scheduled row for an ordinary send', async () => {
    await createComposeSend({ snapshot, mode: 'new', replyTo: null, account })();
    expect(cancelSchedule).not.toHaveBeenCalled();
    expect(sendParams()[0].cancelScheduledId).toBeNull();
  });

  it('deletes a draft from its original account after the sender changes', async () => {
    const sender = { id: 'acct-b', email: 'sender-b@example.test', name: 'Sender B' };
    const switchedDraft = { ...snapshot, _accountId: 'acct-b', _draftAccountId: 'acct-a' };

    await createComposeSend({ snapshot: switchedDraft, mode: 'new', replyTo: null, account: sender, settings: { displayName: 'Sender B' } })();

    expect(cleanupDraftFor).toHaveBeenCalledWith(expect.objectContaining({ _draftAccountId: 'acct-a', _draftUid: 42 }));
  });
});

describe('the Sent copy the send leaves behind', () => {
  const appendListener = () => listeners.find(l => l.name === 'send-server-append-complete');
  const appendEvent = (payload) => ({ payload: { accountId: 'me@example.test', mailbox: 'Sent', ok: true, ...payload } });
  const sentRows = () => mailStore.useMailStore.getState().sentEmails;

  /// One message, one Message-ID: the wire copy carries the id the local
  /// Sent copy was staged with.
  it('sends under the Message-ID the local copy was staged with', async () => {
    await createComposeSend({ snapshot, mode: 'reply', replyTo: { uid: 7 }, account })();

    expect(sendParams()[0]).toMatchObject({ messageId: '<one@example.test>', sentMailbox: 'Sent', accountId: 'acct-1' });
    // Only the send carries it: the stage mints the id in the first place.
    expect(stageOutgoing.mock.calls[0][1].messageId).toBeUndefined();
  });

  /// Graph and JMAP report their own Sent copy before compose.send answers:
  /// the listener is up before the send, or that report is lost.
  it('listens before it sends', async () => {
    sendStaged.mockImplementationOnce(async () => {
      expect(appendListener()).toBeTruthy();
      return sentReply();
    });
    await createComposeSend({ snapshot, mode: 'new', replyTo: null, account })();
  });

  /// The daemon gives the Sent APPEND up to 60 s and its re-check 15 s more.
  it('keeps listening for the Sent APPEND past the daemon\'s 60 s timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await createComposeSend({ snapshot, mode: 'new', replyTo: null, account })();
    const { unlisten } = appendListener();

    vi.advanceTimersByTime(61_000);
    expect(unlisten).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(unlisten).toHaveBeenCalled();
  });

  /// Same account, another message (a scheduled send, a second reply): its
  /// APPEND says nothing about this row, so the row stays.
  it('drops its row only on its own message\'s APPEND', async () => {
    await createComposeSend({ snapshot, mode: 'new', replyTo: null, account })();
    const { handler, unlisten } = appendListener();

    await handler(appendEvent({ messageId: '250 OK' }));
    await handler(appendEvent({ messageIdHeader: 'someone-else@example.test' }));
    expect(sentRows()).toHaveLength(1);
    expect(unlisten).not.toHaveBeenCalled();

    await handler(appendEvent({ messageIdHeader: 'one@example.test' }));
    expect(sentRows()).toEqual([]);
    expect(unlisten).toHaveBeenCalled();
  });
});

// All inboxes: a reply leaves from the account the conversation is in, which is
// often not the active one. Its staged copy has to say where it lives — the
// merge used to stamp the ACTIVE account's Sent path on any row without one —
// and the refresh after the APPEND has to ask THAT account for its Sent.
describe('a reply sent from an account that is not the active one', () => {
  const other = { id: 'acct-b', email: 'yoda@example.test', name: 'Yoda' };
  const otherSnapshot = { ...snapshot, _accountId: 'acct-b', _fromAddress: 'yoda@example.test', _draftUid: null, _draftMailbox: null };

  it('stages a copy stamped with its own account and Sent folder', async () => {
    await createComposeSend({ snapshot: otherSnapshot, mode: 'reply', replyTo: { uid: 7 }, account: other })();

    expect(stageOutgoing.mock.calls[0][2]).toMatchObject({ accountId: 'acct-b', mailbox: 'Sent' });
    expect(mailStore.useMailStore.getState().sentEmails[0]).toMatchObject({
      _accountId: 'acct-b', _accountEmail: 'yoda@example.test', _mailbox: 'Sent', _optimistic: true,
    });
  });

  it('reloads that account\'s Sent once the APPEND lands', async () => {
    const state = mailStore.useMailStore.getState();
    state.loadSentHeaders.mockClear();

    await createComposeSend({ snapshot: otherSnapshot, mode: 'reply', replyTo: { uid: 7 }, account: other })();
    const { handler } = listeners.find(l => l.name === 'send-server-append-complete');
    await handler({ payload: { accountId: 'yoda@example.test', mailbox: 'Sent', ok: true, messageIdHeader: 'one@example.test' } });

    expect(state.loadSentHeaders).toHaveBeenCalledWith('acct-b');
  });
});

// "Remind me if no reply": the daemon records it once the send is out, under
// the Message-ID the message was staged with, never on Graph (src-daemon
// handlers/compose.rs). The app's part is the Premium gate and the
// account's own addresses.
describe('a send with a follow-up reminder', () => {
  it('asks the daemon for the reminder with the account\'s own addresses', async () => {
    await createComposeSend({ snapshot: { ...snapshot, _remindDays: 3 }, mode: 'new', account, settings: {} })();

    expect(sendParams()[0].remindDays).toBe(3);
    expect(sendParams()[0].ownAddresses).toEqual(expect.arrayContaining(['me@example.test']));
  });

  it('asks for it on a JMAP and a Graph account alike: the daemon knows which it can check', async () => {
    const jmap = { ...account, jmapSessionUrl: 'https://api.example.test/jmap/session', jmapAuth: 'bearer' };
    await createComposeSend({ snapshot: { ...snapshot, _remindDays: 2 }, mode: 'new', account: jmap, settings: {} })();
    await createComposeSend({ snapshot: { ...snapshot, _remindDays: 3 }, mode: 'new', account: { ...account, oauth2Transport: 'graph' }, settings: {} })();
    expect(sendParams().map(p => p.remindDays)).toEqual([2, 3]);
  });

  it('asks for none without the reminder or without Premium', async () => {
    await createComposeSend({ snapshot, mode: 'new', account, settings: {} })();
    await createComposeSend({ snapshot: { ...snapshot, _remindDays: 0 }, mode: 'new', account, settings: {} })();
    billing.premium = false;
    await createComposeSend({ snapshot: { ...snapshot, _remindDays: 3 }, mode: 'new', account, settings: {} })();
    expect(sendParams().map(p => p.remindDays)).toEqual([0, 0, 0]);
  });

  it('a scheduled send carries the reminder to the daemon, which records it when it goes out', async () => {
    const scheduled = { ...snapshot, _remindDays: 7, _scheduleDraft: { localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' } };
    await scheduleCompose({ snapshot: scheduled, account, settings: {} });
    expect(createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      remindDays: 7, ownAddresses: expect.arrayContaining(['me@example.test']),
    }));
    await scheduleCompose({ snapshot: { ...scheduled, _remindDays: 3, _editScheduledId: 'row-1', _editScheduledRow: { accountId: 'acct-1' } }, account, settings: {} });
    expect(replaceSchedule).toHaveBeenCalledWith('row-1', expect.objectContaining({ remindDays: 3 }));
  });
});

describe('scheduleCompose', () => {
  /// The Premium gate every Schedule goes through, in-window or detached: a
  /// panel left open past a lapsed subscription still cannot queue or edit.
  it('refuses a free user before touching credentials, the queue or the draft', async () => {
    billing.premium = false;
    const scheduled = { ...snapshot, _scheduleDraft: { localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' } };

    await expect(scheduleCompose({ snapshot: scheduled, account })).rejects.toThrow('Scheduling an email for a set time is part of Premium.');
    await expect(scheduleCompose({ snapshot: { ...scheduled, _editScheduledId: 'row-1', _editScheduledRow: { accountId: 'acct-1' } }, account }))
      .rejects.toThrow('part of Premium');

    expect(ensureFreshToken).not.toHaveBeenCalled();
    expect(createSchedule).not.toHaveBeenCalled();
    expect(replaceSchedule).not.toHaveBeenCalled();
    expect(cleanupDraftFor).not.toHaveBeenCalled();
  });

  it('rejects an incomplete schedule before touching account credentials', async () => {
    await expect(scheduleCompose({
      snapshot: { ...snapshot, _scheduleDraft: { localTime: '', tz: 'Europe/Vilnius' } },
      account,
    })).rejects.toThrow();

    expect(ensureFreshToken).not.toHaveBeenCalled();
    expect(createSchedule).not.toHaveBeenCalled();
  });

  it('rejects when scheduling fails and leaves the draft in place', async () => {
    createSchedule.mockRejectedValueOnce(new Error('daemon unavailable'));
    const scheduledSnapshot = {
      ...snapshot,
      _scheduleDraft: { localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' },
    };

    await expect(scheduleCompose({ snapshot: scheduledSnapshot, account, settings: { displayName: 'Alias name' } }))
      .rejects.toThrow('daemon unavailable');

    expect(cleanupDraftFor).not.toHaveBeenCalled();
  });

  const editSnapshot = (accountId = 'acct-1') => ({
    ...snapshot,
    _scheduleDraft: { localTime: '2026-10-02T10:00', tz: 'Europe/Vilnius' },
    _editScheduledId: 'row-1',
    _editScheduledRow: { accountId, localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' },
  });

  /// Saving an edit replaces the row it came from, never schedules a second
  /// copy beside it, and still drops the autosaved draft.
  it('saves an edited scheduled email over its own row', async () => {
    await scheduleCompose({ snapshot: editSnapshot(), account, settings: { displayName: 'Alias name' } });

    expect(createSchedule).not.toHaveBeenCalled();
    expect(cancelSchedule).not.toHaveBeenCalled();
    expect(replaceSchedule).toHaveBeenCalledWith('row-1', expect.objectContaining({
      account: expect.objectContaining({ email: 'me@example.test', fromEmail: 'alias@example.test' }),
      email: expect.objectContaining({ to: 'recipient@example.test', subject: 'A subject' }),
      localTime: '2026-10-02T10:00', tz: 'Europe/Vilnius', fireAt: expect.any(Number), sentMailbox: 'Sent',
    }));
    expect(cleanupDraftFor).toHaveBeenCalledWith(snapshot);
  });

  it('keeps everything when the daemon refuses the edit because the row already fired', async () => {
    replaceSchedule.mockRejectedValueOnce(new Error('E_SCHEDULED_NOT_EDITABLE: already being sent'));

    await expect(scheduleCompose({ snapshot: editSnapshot(), account })).rejects.toThrow('E_SCHEDULED_NOT_EDITABLE');

    expect(createSchedule).not.toHaveBeenCalled();
    expect(cleanupDraftFor).not.toHaveBeenCalled();
  });

  /// A row is bound to the account whose vault holds it: an edit moved to
  /// another From account is a new row. The old one is cancelled first, and
  /// that cancel is checked: a row already sending must not also get a copy.
  it('cancels the old row of an edit moved to another account, then schedules it as a new row', async () => {
    const order = [];
    createSchedule.mockImplementationOnce(async () => { order.push('create'); });
    cancelSchedule.mockImplementationOnce(async () => { order.push('cancel'); });

    await scheduleCompose({ snapshot: editSnapshot('acct-other'), account });

    expect(replaceSchedule).not.toHaveBeenCalled();
    expect(createSchedule).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1' }));
    expect(cancelSchedule).toHaveBeenCalledWith('row-1');
    expect(order).toEqual(['cancel', 'create']);
  });

  it('schedules nothing when the old row can no longer be cancelled, and keeps the draft', async () => {
    cancelSchedule.mockRejectedValueOnce(new Error('E_SCHEDULED_NOT_EDITABLE: already being sent'));

    await expect(scheduleCompose({ snapshot: editSnapshot('acct-other'), account })).rejects.toThrow('E_SCHEDULED_NOT_EDITABLE');

    expect(createSchedule).not.toHaveBeenCalled();
    expect(cleanupDraftFor).not.toHaveBeenCalled();
  });

  it('keeps the draft when the new row fails after the old one was cancelled', async () => {
    createSchedule.mockRejectedValueOnce(new Error('daemon unavailable'));

    await expect(scheduleCompose({ snapshot: editSnapshot('acct-other'), account })).rejects.toThrow('daemon unavailable');

    expect(cancelSchedule).toHaveBeenCalledWith('row-1');
    expect(cleanupDraftFor).not.toHaveBeenCalled();
  });
});


describe('accepted delivery is separate from terminal cleanup', () => {
  it.each(['unknown', 'pending'])('keeps sent success and Sent bookkeeping after %s cleanup', async state => {
    const cleanupDraft = vi.fn(state === 'unknown' ? async () => { throw Error('cleanup RPC lost'); }
      : async () => ({ discarded: true, cleanup: 'pending' }));
    const frozen = { ...snapshot, _draftId: 'captured', _draftUid: null, _draftAccountId: 'old-account' };
    const send = createComposeSend({ snapshot: frozen, account, mode: 'reply', replyTo: { uid: 7 }, cleanupDraft });
    expect(cleanupDraft).not.toHaveBeenCalled();
    await expect(send()).resolves.toBeUndefined();
    expect(sendStaged).toHaveBeenCalledTimes(1); expect(stageOutgoing).toHaveBeenCalledTimes(1);
    expect(cleanupDraft).toHaveBeenCalledWith(expect.objectContaining({ _draftId: 'captured', _draftAccountId: 'old-account' }), 'sent');
    expect(mailStore.useMailStore.getState().sentEmails).toHaveLength(1); expect(markAnswered).toHaveBeenCalledTimes(1);
  });
  it('uses the canonical captured ID without a UID in the standalone send fallback', async () => {
    await createComposeSend({ snapshot: { ...snapshot, _draftId: 'no-uid', _draftUid: null }, account })();
    expect(cleanupDraftFor).toHaveBeenCalledWith(expect.objectContaining({ _draftId: 'no-uid', _draftUid: null }));
  });
  it.each([false, true])('keeps accepted schedule create/replace after cleanup rejects (edit=%s)', async edit => {
    const cleanupDraft = vi.fn().mockRejectedValue(Error('lost cleanup'));
    const data = { ...snapshot, _draftId: 'schedule-draft', _scheduleDraft: { localTime: '2099-01-01T09:00', tz: 'UTC' },
      ...(edit ? { _editScheduledId: 'row-1', _editScheduledRow: { accountId: 'acct-1' } } : {}) };
    await expect(scheduleCompose({ snapshot: data, account, cleanupDraft })).resolves.toBeUndefined();
    expect(edit ? replaceSchedule : createSchedule).toHaveBeenCalledTimes(1); expect(cancelSchedule).not.toHaveBeenCalled();
    expect(cleanupDraft).toHaveBeenCalledWith(expect.objectContaining({ _draftId: 'schedule-draft' }), 'scheduled');
  });
  it('never starts terminal cleanup for an unaccepted send or schedule', async () => {
    const cleanupDraft = vi.fn(); sendStaged.mockRejectedValueOnce(Error('offline'));
    await expect(createComposeSend({ snapshot, account, cleanupDraft })()).rejects.toThrow('offline');
    createSchedule.mockRejectedValueOnce(Error('schedule offline'));
    await expect(scheduleCompose({ snapshot: { ...snapshot, _scheduleDraft: { localTime: '2099-01-01T09:00', tz: 'UTC' } }, account, cleanupDraft })).rejects.toThrow('schedule offline');
    expect(cleanupDraft).not.toHaveBeenCalled();
  });
});


// With the existing physical UID path, a lost discard RPC used to reject an
// already accepted send and invite the real outbox's transport retry.
describe('accepted physical draft cleanup cannot become a delivery failure', () => {
  it('keeps SMTP acceptance and Sent projection when the actual draft deletion rejects', async () => {
    cleanupDraftFor.mockRejectedValueOnce(Error('discard acknowledgement lost'));
    await expect(createComposeSend({ snapshot, account, mode: 'new' })()).resolves.toBeUndefined();
    expect(sendStaged).toHaveBeenCalledTimes(1); expect(cleanupDraftFor).toHaveBeenCalledTimes(1);
    expect(mailStore.useMailStore.getState().sentEmails).toHaveLength(1);
  });
  it('keeps an accepted schedule when the actual draft deletion rejects', async () => {
    cleanupDraftFor.mockRejectedValueOnce(Error('discard acknowledgement lost'));
    await expect(scheduleCompose({ snapshot: { ...snapshot, _scheduleDraft: { localTime: '2099-01-01T09:00', tz: 'UTC' } }, account })).resolves.toBeUndefined();
    expect(createSchedule).toHaveBeenCalledTimes(1); expect(cleanupDraftFor).toHaveBeenCalledTimes(1);
    expect(cancelSchedule).not.toHaveBeenCalled();
  });
});


it('the actual outbox finishes accepted mail after cleanup error and Undo never cleans a draft', async () => {
  const { createComposeSlice } = await import('../../stores/slices/composeSlice');
  let state;
  const get = () => state;
  const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; };
  state = createComposeSlice(set, get);
  const cleanupDraft = vi.fn().mockRejectedValue(Error('cleanup acknowledgement lost'));
  const data = { ...snapshot, _draftId: 'outbox-owned' };
  const compose = { mode: 'new', initialData: data };
  state.queueSend(compose, createComposeSend({ snapshot: data, account, cleanupDraft }), 60);
  expect(state.cancelPendingSend()).toBe(compose);
  expect(cleanupDraft).not.toHaveBeenCalled(); expect(sendStaged).not.toHaveBeenCalled();
  state.queueSend(compose, createComposeSend({ snapshot: data, account, cleanupDraft }), 0);
  await vi.waitFor(() => expect(state.outboxItems[0]?.status).toBe('sent'));
  expect(sendStaged).toHaveBeenCalledTimes(1); expect(cleanupDraft).toHaveBeenCalledTimes(1);
  expect(state.outboxItems[0].error).toBeNull();
});
