/**
 * ONE answer to "is this row that message". A uid names a message only inside
 * one (account, mailbox), so a row matches a target only when its own resolved
 * location AND uid are the target's. A row whose location cannot be resolved
 * matches nothing: an unknown location used to be a wildcard, which is how one
 * account's delete took another account's row, and a Sent copy merged into the
 * INBOX list, off the screen.
 */
import { describe, it, expect } from 'vitest';
import { rowIdentity, sameMessage, emailScopeKey } from '../unifiedHelpers';

const A = 'acctA';
const B = 'acctB';

const inboxView = {
  activeAccountId: A,
  activeMailbox: 'INBOX',
  getSentMailboxPath: () => 'Sent',
};
const unifiedView = { ...inboxView, activeMailbox: 'UNIFIED' };

describe('rowIdentity', () => {
  it('reads a stamped row off the row itself', () => {
    expect(rowIdentity({ uid: 7, _accountId: B, _mailbox: 'Archive' }, inboxView))
      .toEqual({ accountId: B, mailbox: 'Archive', uid: 7 });
  });

  it('resolves a null _mailbox against the view\'s mailbox, for the active account', () => {
    expect(rowIdentity({ uid: 7 }, inboxView)).toEqual({ accountId: A, mailbox: 'INBOX', uid: 7 });
    expect(rowIdentity({ uid: 7, _accountId: A }, { ...inboxView, activeMailbox: 'Archive' }))
      .toEqual({ accountId: A, mailbox: 'Archive', uid: 7 });
  });

  it('places an unstamped Sent copy at the Sent folder, not the view\'s', () => {
    expect(rowIdentity({ uid: 7, _fromSentFolder: true }, inboxView))
      .toEqual({ accountId: A, mailbox: 'Sent', uid: 7 });
  });

  it('honours _srcAccountId', () => {
    expect(rowIdentity({ uid: 7, _srcAccountId: B, _mailbox: 'INBOX' }, inboxView))
      .toEqual({ accountId: B, mailbox: 'INBOX', uid: 7 });
  });

  it('is null when a foreign account\'s row names no folder', () => {
    expect(rowIdentity({ uid: 7, _accountId: B }, inboxView)).toBeNull();
  });

  it('is null for an unstamped row in All inboxes: the view is no folder', () => {
    expect(rowIdentity({ uid: 7 }, unifiedView)).toBeNull();
  });

  it('is null for no row', () => {
    expect(rowIdentity(null, inboxView)).toBeNull();
  });
});

describe('sameMessage', () => {
  const target = { accountId: A, mailbox: 'INBOX', uid: 34 };

  it('matches the row of that message', () => {
    expect(sameMessage({ uid: 34, _accountId: A, _mailbox: 'INBOX' }, target, inboxView)).toBe(true);
  });

  it('matches an unstamped row of the view the target names', () => {
    expect(sameMessage({ uid: 34 }, target, inboxView)).toBe(true);
  });

  it('does not match the same uid in another folder of the account', () => {
    expect(sameMessage({ uid: 34, _accountId: A, _mailbox: 'Sent', _fromSentFolder: true }, target, inboxView)).toBe(false);
    expect(sameMessage({ uid: 34, _fromSentFolder: true }, target, inboxView)).toBe(false);
  });

  it('does not match the same uid and folder in another account', () => {
    expect(sameMessage({ uid: 34, _accountId: B, _mailbox: 'INBOX' }, target, unifiedView)).toBe(false);
  });

  it('does not match another uid', () => {
    expect(sameMessage({ uid: 35, _accountId: A, _mailbox: 'INBOX' }, target, inboxView)).toBe(false);
  });

  it('never treats an unresolvable location as a wildcard', () => {
    expect(sameMessage({ uid: 34, _accountId: B }, target, inboxView)).toBe(false);
    expect(sameMessage({ uid: 34 }, target, unifiedView)).toBe(false);
  });

  it('matches nothing when the target itself names no real folder', () => {
    expect(sameMessage({ uid: 34, _accountId: A, _mailbox: 'INBOX' }, { accountId: A, mailbox: 'UNIFIED', uid: 34 }, inboxView)).toBe(false);
    expect(sameMessage({ uid: 34, _accountId: A, _mailbox: 'INBOX' }, { accountId: A, mailbox: null, uid: 34 }, inboxView)).toBe(false);
    expect(sameMessage({ uid: 34, _accountId: A, _mailbox: 'INBOX' }, { accountId: null, mailbox: 'INBOX', uid: 34 }, inboxView)).toBe(false);
  });
});

describe('emailScopeKey', () => {
  it('is the row identity as one string, and null when unresolvable', () => {
    expect(emailScopeKey({ uid: 7, _accountId: B, _mailbox: 'Archive' }, inboxView)).toBe('acctB-Archive-7');
    expect(emailScopeKey({ uid: 7 }, inboxView)).toBe('acctA-INBOX-7');
    expect(emailScopeKey({ uid: 7, _accountId: B }, inboxView)).toBeNull();
  });
});
