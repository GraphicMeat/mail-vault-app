import { describe, it, expect } from 'vitest';
import { _resolveUnifiedContext } from '../unifiedHelpers.js';

// A Graph account's Sent has a localized NAME and an English PATH. The
// mailbox that mutations act on is the path.
describe('_resolveUnifiedContext for a sent row without _mailbox', () => {
  const account = { id: 'a1', email: 'leia@mock.test' };
  const state = {
    accounts: [account],
    mailboxes: [
      { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
      { name: 'Gesendet', path: 'Sent', specialUse: '\\Sent' },
    ],
    emails: [{ uid: 7, _accountId: 'a1', _isSent: true }],
  };

  it('resolves the Sent folder by special use and returns its path', () => {
    expect(_resolveUnifiedContext('a1:7', state)).toMatchObject({ accountId: 'a1', mailbox: 'Sent', uid: 7 });
  });

  it('still finds an IMAP Sent by name when no special use is set', () => {
    const imap = { ...state, mailboxes: [{ name: 'Sent Items', path: 'Sent Items' }] };
    expect(_resolveUnifiedContext('a1:7', imap).mailbox).toBe('Sent Items');
  });

  // The two cases above cannot tell the path from the name: a Graph Sent is
  // keyed 'Sent', which is also the literal this helper falls back to. A
  // nested IMAP Sent can — and a mutation aimed at the leaf would miss.
  it('returns the path, not the leaf name, for a Sent folder under INBOX', () => {
    const nested = { ...state, mailboxes: [{ name: 'Sent', path: 'INBOX.Sent', specialUse: '\\Sent' }] };
    expect(_resolveUnifiedContext('a1:7', nested).mailbox).toBe('INBOX.Sent');
  });
});
