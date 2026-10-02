import { describe, it, expect } from 'vitest';
import { captureTargetOf, isCaptureTarget } from '../captureTarget';

const state = { activeAccountId: 'acct-a', activeMailbox: 'INBOX' };

describe('captureTargetOf', () => {
  it('names a message by its account, folder and uid, as the reader places it', () => {
    expect(captureTargetOf({ uid: 7 }, state)).toEqual({ uid: 7, accountId: 'acct-a', mailbox: 'INBOX' });
    expect(captureTargetOf({ uid: 7, _accountId: 'acct-b', _mailbox: 'Junk' }, state)).toEqual({ uid: 7, accountId: 'acct-b', mailbox: 'Junk' });
  });

  it('is null for a message that cannot be placed', () => {
    expect(captureTargetOf({ uid: 7 }, { activeAccountId: 'acct-a', activeMailbox: 'UNIFIED' })).toBeNull();
  });
});

describe('isCaptureTarget', () => {
  const target = { uid: 7, accountId: 'acct-b', mailbox: 'Junk' };

  it('is true for the same uid in the same account and folder only', () => {
    expect(isCaptureTarget({ uid: 7, _accountId: 'acct-b', _mailbox: 'Junk' }, target, state)).toBe(true);
    expect(isCaptureTarget({ uid: 7, _accountId: 'acct-b', _mailbox: 'INBOX' }, target, state)).toBe(false);
    expect(isCaptureTarget({ uid: 7, _accountId: 'acct-a', _mailbox: 'Junk' }, target, state)).toBe(false);
    expect(isCaptureTarget({ uid: 8, _accountId: 'acct-b', _mailbox: 'Junk' }, target, state)).toBe(false);
  });

  it('compares only what the target names', () => {
    expect(isCaptureTarget({ uid: 7 }, { uid: 7 }, state)).toBe(true);
    expect(isCaptureTarget({ uid: 7 }, { uid: 7, mailbox: 'INBOX' }, state)).toBe(true);
    expect(isCaptureTarget({ uid: 7 }, { uid: 7, mailbox: 'Junk' }, state)).toBe(false);
  });

  it('is false with no target, no email or an unplaceable email', () => {
    expect(isCaptureTarget({ uid: 7 }, null, state)).toBe(false);
    expect(isCaptureTarget(null, target, state)).toBe(false);
    expect(isCaptureTarget({ uid: 7 }, { uid: 7 }, { activeAccountId: 'a', activeMailbox: 'UNIFIED' })).toBe(false);
  });
});
