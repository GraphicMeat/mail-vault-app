import { describe, expect, it, vi } from 'vitest';

const folders = vi.hoisted(() => ({
  'acct-b': [{ path: 'INBOX' }, { path: 'Unwanted', specialUse: '\\JUNK' }],
}));
vi.mock('../../services/cacheManager', () => ({ getAccountCacheMailboxes: accountId => folders[accountId] }));
vi.mock('../../services/workflows/snooze', () => ({ canSnooze: () => false }));

const { isSpamMessage } = await import('../spamFolder');

const state = (activeMailbox, mailboxes = [{ path: 'INBOX' }]) => ({
  activeAccountId: 'acct-a', activeMailbox, mailboxes,
});
const mail = (overrides = {}) => ({ uid: 1, ...overrides });

describe('isSpamMessage', () => {
  it('is true for the folder the server marks Junk, whatever it is called, in any case', () => {
    const s = state('Unwanted', [{ path: 'INBOX' }, { path: 'Unwanted', specialUse: '\\Junk' }]);
    expect(isSpamMessage(mail(), s)).toBe(true);
    expect(isSpamMessage(mail({ _accountId: 'acct-b', _mailbox: 'Unwanted' }), state('INBOX'))).toBe(true);
  });

  it('is true for a folder named like spam, by its last path segment', () => {
    for (const mailbox of ['Spam', 'Junk', 'Junk E-mail', 'Junk Email', 'Bulk Mail', 'INBOX.Spam', '[Gmail]/Spam', 'spam']) {
      expect(isSpamMessage(mail({ _mailbox: mailbox }), state('INBOX')), mailbox).toBe(true);
    }
  });

  it('is false for the inbox and for a folder that only contains the word', () => {
    for (const mailbox of ['INBOX', 'Sent', 'Spam reports', 'Junkyard', 'Archive/Spam stuff']) {
      expect(isSpamMessage(mail({ _mailbox: mailbox }), state('INBOX')), mailbox).toBe(false);
    }
  });

  it('is false when the message cannot be placed', () => {
    expect(isSpamMessage(mail(), state('UNIFIED'))).toBe(false);
    expect(isSpamMessage(null, state('INBOX'))).toBe(false);
  });
});
