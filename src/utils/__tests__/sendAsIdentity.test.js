import { describe, it, expect } from 'vitest';
import { isFromUser, getCorrespondent, identitySet } from '../emailParser';

const LOGIN = 'abc@fastmail.fm';
const ALIAS = 'def@fastmail.fm';

const mail = (from, to = []) => ({
  from: { address: from, name: '' },
  to: to.map(address => ({ address, name: '' })),
});

describe('identity checks with a send-as alias', () => {
  it('treats a message sent from the alias as the user\'s own', () => {
    // Without this, the user's own sent mail reads as a stranger's.
    expect(isFromUser(mail(ALIAS), [LOGIN, ALIAS])).toBe(true);
    expect(isFromUser(mail(LOGIN), [LOGIN, ALIAS])).toBe(true);
    expect(isFromUser(mail('someone@else.com'), [LOGIN, ALIAS])).toBe(false);
  });

  it('still accepts a plain string identity (every existing caller)', () => {
    expect(isFromUser(mail(LOGIN), LOGIN)).toBe(true);
    expect(isFromUser(mail(ALIAS), LOGIN)).toBe(false);
  });

  it('picks the recipient as correspondent for alias-sent mail', () => {
    const c = getCorrespondent(mail(ALIAS, ['friend@example.com']), [LOGIN, ALIAS]);
    expect(c.email).toBe('friend@example.com');
  });

  it('is case-insensitive and ignores blanks', () => {
    expect(isFromUser(mail(ALIAS), ['DEF@FASTMAIL.FM'])).toBe(true);
    expect(isFromUser(mail(ALIAS), ['', null, undefined])).toBe(false);
    expect([...identitySet([' A@b.com ', 'A@B.com'])]).toEqual(['a@b.com']);
  });

  it('returns false for a message with no from address', () => {
    expect(isFromUser({ from: null }, [LOGIN])).toBe(false);
  });
});
