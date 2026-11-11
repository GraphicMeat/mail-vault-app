// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [] }));

const { useMailStore } = await import('../../mailStore');
const { useSettingsStore } = await import('../../settingsStore');
const { buildThreads } = await import('../../../utils/emailParser');

const parent = {
  uid: 10, _accountId: 'acct-1', _mailbox: 'INBOX', messageId: '<parent@example.test>',
  subject: 'Quote request', from: { address: 'them@example.test' },
  to: [{ address: 'me@example.test' }], date: '2026-09-07T09:00:00Z', flags: ['\\Seen'],
};
const reply = {
  uid: 20, _accountId: 'acct-1', _mailbox: 'Sent', _fromSentFolder: true,
  messageId: '<mine@example.test>', inReplyTo: parent.messageId, references: [parent.messageId],
  subject: 'Re: Quote request', from: { address: 'me@example.test' },
  to: [{ address: 'them@example.test' }], date: '2026-09-07T09:05:00Z', flags: ['\\Seen'],
};
const threads = () => buildThreads([parent, reply]);

beforeEach(() => {
  useSettingsStore.setState({ threadMode: 'expandable', hideViewMail: false });
  useMailStore.setState({ activeAccountId: 'acct-1', activeMailbox: 'INBOX',
    selectedEmailId: 10, selectedEmail: parent, selectedThread: null, followReply: null });
});

describe('followSentReply', () => {
  it('follows a reply sent from the single open message', () => {
    useMailStore.getState().followSentReply(parent, reply.messageId);
    useMailStore.getState().syncSelectedThread(threads());
    expect(useMailStore.getState().selectedThread.messageCount).toBe(2);
    expect(useMailStore.getState().followReply).toBeNull();
  });

  it('does not follow in flat thread mode', () => {
    useSettingsStore.setState({ threadMode: 'flat' });
    useMailStore.getState().followSentReply(parent, reply.messageId);
    useMailStore.getState().syncSelectedThread(threads());
    expect(useMailStore.getState().followReply).toBeNull();
    expect(useMailStore.getState().selectedThread).toBeNull();
  });

  it('does not follow when the original is not the open message', () => {
    useMailStore.getState().followSentReply({ ...parent, uid: 99 }, reply.messageId);
    expect(useMailStore.getState().followReply).toBeNull();
  });

  it('selectThread and closeEmail drop a pending follow', () => {
    useMailStore.getState().followSentReply(parent, reply.messageId);
    useMailStore.getState().selectThread([...threads().values()][0]);
    expect(useMailStore.getState().followReply).toBeNull();
    useMailStore.setState({ selectedThread: null, selectedEmailId: 10, selectedEmail: parent });
    useMailStore.getState().followSentReply(parent, reply.messageId);
    useMailStore.getState().closeEmail();
    expect(useMailStore.getState().followReply).toBeNull();
  });
});
