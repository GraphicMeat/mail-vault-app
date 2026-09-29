import { describe, it, expect } from 'vitest';
import { isFromUser, getCorrespondent, identitySet, computeReplyRecipients, groupByCorrespondent, groupBySender } from '../emailParser';
import { ownAddresses } from '../ownAddresses';

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

// Every "is this mine" decision takes the same list, from ownAddresses: the
// login, the default From and every alias the account holds.
describe('identity checks across every alias', () => {
  const OWN = ownAddresses({
    account: { id: 'a1', email: 'me@example.test' },
    sendAsAddress: '',
    aliases: [{ address: 'desk@example.test', name: 'Desk' }, { address: 'sales@example.test', name: '' }],
  });

  it('counts a message sent from any alias as mine', () => {
    expect(isFromUser(mail('Sales@Example.test'), OWN)).toBe(true);
    expect(isFromUser(mail('desk@example.test'), OWN)).toBe(true);
    expect(isFromUser(mail('stranger@example.test'), OWN)).toBe(false);
  });

  it('knows a dotted Gmail login when the header drops the dots', () => {
    expect(isFromUser(mail('jdoe@gmail.com'), ['j.doe@gmail.com'])).toBe(true);
    expect(getCorrespondent(mail('jdoe@gmail.com', ['friend@example.com']), ['j.doe@gmail.com']).email)
      .toBe('friend@example.com');
  });

  it('drops every alias from Reply All', () => {
    const replyTo = {
      from: { address: 'friend@example.com' },
      to: [{ address: 'me@example.test' }, { address: 'DESK@example.test' }, { address: 'third@example.com' }],
      cc: [{ address: 'sales@example.test' }, { address: 'fourth@example.com' }],
    };
    expect(computeReplyRecipients(replyTo, 'replyAll', OWN)).toEqual({
      to: 'friend@example.com, third@example.com',
      cc: 'fourth@example.com',
    });
  });

  it('groups a reply sent from an alias with the user\'s side of the chat', () => {
    const groups = groupByCorrespondent([
      { ...mail('friend@example.com', ['me@example.test']), date: '2026-09-01T10:00:00Z' },
      { ...mail('sales@example.test', ['friend@example.com']), date: '2026-09-01T11:00:00Z' },
    ], OWN);
    expect([...groups.keys()]).toEqual(['friend@example.com']);
    expect(groups.get('friend@example.com').emails).toHaveLength(2);
  });

  it('never shows an alias as the correspondent of a sender-grouped thread', () => {
    const groups = groupBySender([
      { ...mail('sales@example.test', ['friend@example.com']), subject: 'Quote', messageId: '<q1@example.test>', date: '2026-09-01T11:00:00Z' },
    ], OWN);
    expect(groups.map(g => g.senderEmail)).toEqual(['friend@example.com']);
  });
});
