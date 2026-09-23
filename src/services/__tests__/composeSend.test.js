// @vitest-environment jsdom
//
// The send closure is intentionally independent of a mounted compose window:
// an undo timer or detached window may outlive the editor that created it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  invoke, sendEmail, buildOutgoingMime, appendLocalIndex, deleteLocalDraft, markAnswered, markForwarded, createSchedule, ensureFreshToken,
  replaceSchedule, cancelSchedule, billing,
} = vi.hoisted(() => ({
  billing: { premium: true },
  replaceSchedule: vi.fn().mockResolvedValue(undefined),
  cancelSchedule: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue(undefined),
  sendEmail: vi.fn(),
  buildOutgoingMime: vi.fn(),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  deleteLocalDraft: vi.fn().mockResolvedValue(undefined),
  markAnswered: vi.fn().mockResolvedValue(undefined),
  markForwarded: vi.fn().mockResolvedValue(undefined),
  createSchedule: vi.fn().mockResolvedValue(undefined),
  ensureFreshToken: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../transport', () => ({ send: (...args) => invoke(...args) }));
vi.mock('../api', () => ({
  sendEmail: (...args) => sendEmail(...args),
  buildOutgoingMime: (...args) => buildOutgoingMime(...args),
  appendLocalIndex: (...args) => appendLocalIndex(...args),
  ensureSentMailbox: vi.fn().mockResolvedValue('Sent'),
}));
vi.mock('../db', () => ({ getCachedMailboxes: vi.fn().mockResolvedValue([]), saveAccount: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../authUtils', () => ({ ensureFreshToken: (...args) => ensureFreshToken(...args) }));
vi.mock('../localDrafts', () => ({ deleteLocalDraft: (...args) => deleteLocalDraft(...args) }));
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

beforeEach(() => {
  window.__TAURI__ = { core: { invoke } };
  invoke.mockClear();
  sendEmail.mockReset();
  buildOutgoingMime.mockReset();
  appendLocalIndex.mockClear();
  deleteLocalDraft.mockClear();
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
  const state = mailStore.useMailStore.getState();
  state.sentEmails = [];
  state.emails = [];
  buildOutgoingMime.mockResolvedValue({ rawBase64: 'raw', rawSize: 3, messageId: '<one@example.test>' });
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
});

describe('createComposeSend', () => {
  it('reuses the staged MIME and uid when the queued closure retries', async () => {
    sendEmail.mockRejectedValueOnce(new Error('offline'));
    sendEmail.mockResolvedValueOnce({ messageId: '<one@example.test>' });
    const sendFn = createComposeSend({ snapshot, mode: 'reply', replyTo: { uid: 7 }, account, settings: { displayName: 'Alias name' } });

    await expect(sendFn()).rejects.toThrow('offline');
    await sendFn();

    const stored = invoke.mock.calls.filter(([command]) => command === 'maildir_store').map(([, args]) => args.uid);
    expect(new Set(stored).size).toBe(1);
    expect(buildOutgoingMime).toHaveBeenCalledTimes(1);
    expect(buildOutgoingMime).toHaveBeenCalledWith(expect.objectContaining({
      email: 'me@example.test', fromEmail: 'alias@example.test', name: 'Alias name',
    }), expect.any(Object));
    expect(deleteLocalDraft).toHaveBeenCalledWith({ accountId: 'acct-1', mailbox: 'Drafts', uid: 42 });
    expect(mailStore.useMailStore.getState().sentEmails).toHaveLength(1);
    expect(mailStore.useMailStore.getState().sentEmails[0]).toMatchObject({
      messageId: '<one@example.test>', inReplyTo: '<parent@example.test>', references: ['<root@example.test>', '<parent@example.test>'],
    });
  });

  /// An edited scheduled email sent now instead: the row it came from must not
  /// fire as well, but only once the mail is really out.
  it('cancels the edited scheduled row only after the send succeeds', async () => {
    const edited = { ...snapshot, _editScheduledId: 'row-1', _editScheduledRow: { accountId: 'acct-1' } };
    sendEmail.mockRejectedValueOnce(new Error('offline'));
    const sendFn = createComposeSend({ snapshot: edited, mode: 'new', replyTo: null, account });

    await expect(sendFn()).rejects.toThrow('offline');
    expect(cancelSchedule).not.toHaveBeenCalled();

    sendEmail.mockResolvedValueOnce({ messageId: '<one@example.test>' });
    await sendFn();
    expect(cancelSchedule).toHaveBeenCalledWith('row-1');
  });

  it('does not fail a send that went out when cancelling the old row fails', async () => {
    sendEmail.mockResolvedValue({ messageId: '<one@example.test>' });
    cancelSchedule.mockRejectedValueOnce(new Error('daemon unavailable'));
    const edited = { ...snapshot, _editScheduledId: 'row-1', _editScheduledRow: { accountId: 'acct-1' } };

    await expect(createComposeSend({ snapshot: edited, mode: 'new', replyTo: null, account })()).resolves.toBeUndefined();
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

    sendEmail.mockResolvedValueOnce({ messageId: '<one@example.test>' });
    await sendFn();
    expect(cancelSchedule).toHaveBeenCalledTimes(1);
  });

  it('keeps an edited row due after the send delay queued until the send is out', async () => {
    const edited = { ...snapshot, _editScheduledId: 'row-1', _editScheduledRow: { accountId: 'acct-1', localTime: '2099-01-01T09:00', tz: 'UTC' } };
    const sendFn = createComposeSend({ snapshot: edited, mode: 'new', replyTo: null, account });
    expect(cancelSchedule).not.toHaveBeenCalled();

    sendEmail.mockResolvedValueOnce({ messageId: '<one@example.test>' });
    await sendFn();
    expect(cancelSchedule).toHaveBeenCalledWith('row-1');
  });

  it('never cancels a scheduled row for an ordinary send', async () => {
    sendEmail.mockResolvedValue({ messageId: '<one@example.test>' });
    await createComposeSend({ snapshot, mode: 'new', replyTo: null, account })();
    expect(cancelSchedule).not.toHaveBeenCalled();
  });

  it('deletes a draft from its original account after the sender changes', async () => {
    sendEmail.mockResolvedValue({ messageId: '<one@example.test>' });
    const sender = { id: 'acct-b', email: 'sender-b@example.test', name: 'Sender B' };
    const switchedDraft = { ...snapshot, _accountId: 'acct-b', _draftAccountId: 'acct-a' };

    await createComposeSend({ snapshot: switchedDraft, mode: 'new', replyTo: null, account: sender, settings: { displayName: 'Sender B' } })();

    expect(deleteLocalDraft).toHaveBeenCalledWith({ accountId: 'acct-a', mailbox: 'Drafts', uid: 42 });
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
    expect(deleteLocalDraft).not.toHaveBeenCalled();
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

    expect(deleteLocalDraft).not.toHaveBeenCalled();
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
    expect(deleteLocalDraft).toHaveBeenCalledWith({ accountId: 'acct-1', mailbox: 'Drafts', uid: 42 });
  });

  it('keeps everything when the daemon refuses the edit because the row already fired', async () => {
    replaceSchedule.mockRejectedValueOnce(new Error('E_SCHEDULED_NOT_EDITABLE: already being sent'));

    await expect(scheduleCompose({ snapshot: editSnapshot(), account })).rejects.toThrow('E_SCHEDULED_NOT_EDITABLE');

    expect(createSchedule).not.toHaveBeenCalled();
    expect(deleteLocalDraft).not.toHaveBeenCalled();
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
    expect(deleteLocalDraft).not.toHaveBeenCalled();
  });

  it('keeps the draft when the new row fails after the old one was cancelled', async () => {
    createSchedule.mockRejectedValueOnce(new Error('daemon unavailable'));

    await expect(scheduleCompose({ snapshot: editSnapshot('acct-other'), account })).rejects.toThrow('daemon unavailable');

    expect(cancelSchedule).toHaveBeenCalledWith('row-1');
    expect(deleteLocalDraft).not.toHaveBeenCalled();
  });
});
