// @vitest-environment jsdom
//
// The send closure is intentionally independent of a mounted compose window:
// an undo timer or detached window may outlive the editor that created it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  invoke, sendEmail, buildOutgoingMime, appendLocalIndex, deleteLocalDraft, markAnswered, markForwarded, createSchedule, ensureFreshToken,
} = vi.hoisted(() => ({
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
}));
vi.mock('../../stores/scheduledStore', () => ({
  useScheduledStore: { getState: () => ({ create: (...args) => createSchedule(...args) }) },
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
  ensureFreshToken.mockReset();
  ensureFreshToken.mockImplementation(async item => item);
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

  it('deletes a draft from its original account after the sender changes', async () => {
    sendEmail.mockResolvedValue({ messageId: '<one@example.test>' });
    const sender = { id: 'acct-b', email: 'sender-b@example.test', name: 'Sender B' };
    const switchedDraft = { ...snapshot, _accountId: 'acct-b', _draftAccountId: 'acct-a' };

    await createComposeSend({ snapshot: switchedDraft, mode: 'new', replyTo: null, account: sender, settings: { displayName: 'Sender B' } })();

    expect(deleteLocalDraft).toHaveBeenCalledWith({ accountId: 'acct-a', mailbox: 'Drafts', uid: 42 });
  });
});

describe('scheduleCompose', () => {
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
});
