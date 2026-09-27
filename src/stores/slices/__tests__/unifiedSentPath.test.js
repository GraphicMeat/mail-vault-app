import { describe, it, expect } from 'vitest';
import { _resolveUnifiedContext, _resolveMailboxPath } from '../unifiedHelpers.js';

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

  // Gmail LISTs a user label "Sent" before [Gmail]/Sent Mail (byte order).
  it('prefers the declared Sent over a folder merely named Sent listed first', () => {
    const gmail = { ...state, mailboxes: [
      { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
      { name: 'Sent', path: 'Sent' },
      { name: 'Sent Mail', path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
    ] };
    expect(_resolveUnifiedContext('a1:7', gmail).mailbox).toBe('[Gmail]/Sent Mail');
  });

  it('finds Gmail\'s "Sent Mail" by name', () => {
    const gmail = { ...state, mailboxes: [{ name: 'Sent Mail', path: '[Gmail]/Sent Mail' }] };
    expect(_resolveUnifiedContext('a1:7', gmail).mailbox).toBe('[Gmail]/Sent Mail');
  });

  // Outbox matches by name too; the folder the server marks \Sent wins.
  it('prefers the special-use Sent over an Outbox listed first', () => {
    const outlook = { ...state, mailboxes: [{ name: 'Outbox', path: 'Outbox' }, { name: 'Sent Items', path: 'Sent Items', specialUse: '\\Sent' }] };
    expect(_resolveUnifiedContext('a1:7', outlook).mailbox).toBe('Sent Items');
  });
});

// Unified Drafts / Trash / Sent resolve each account's folder by role.
describe('_resolveMailboxPath prefers the declared role over a name match', () => {
  // Gmail, byte order: user labels before [Gmail]/...
  const gmail = [
    { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
    { name: 'Drafts', path: 'Drafts' },
    { name: 'Bin', path: '[Gmail]/Bin', specialUse: '\\Trash' },
    { name: 'Drafts', path: '[Gmail]/Drafts', specialUse: '\\Drafts' },
    { name: 'Trash', path: '[Imap]/Trash' },
  ];

  it('picks [Gmail]/Drafts, not the Drafts label listed before it', () => {
    expect(_resolveMailboxPath(gmail, 'Drafts')).toBe('[Gmail]/Drafts');
    expect(_resolveMailboxPath(gmail, 'Trash')).toBe('[Gmail]/Bin');
  });

  it('still falls back to the name when nothing declares the role', () => {
    const plain = [{ name: 'INBOX', path: 'INBOX' }, { name: 'Drafts', path: 'INBOX.Drafts' }];
    expect(_resolveMailboxPath(plain, 'Drafts')).toBe('INBOX.Drafts');
  });
});
