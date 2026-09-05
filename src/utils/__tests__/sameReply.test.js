import { describe, it, expect } from 'vitest';
import { sameReply } from '../sameReply';

// One window per (message, mode): a second Reply to the message already open
// comes forward instead of stacking — the full-width header is a compose
// trigger now, and a double-click would otherwise open two.
describe('sameReply', () => {
  const msg = { uid: 7, messageId: '<a@x>', _accountId: 'acct-1', _mailbox: 'INBOX' };

  it('matches the same message in the same mode', () => {
    expect(sameReply({ mode: 'reply', replyTo: msg }, { mode: 'reply', replyTo: { ...msg } })).toBe(true);
  });

  it('a different mode is a different window', () => {
    expect(sameReply({ mode: 'reply', replyTo: msg }, { mode: 'forward', replyTo: msg })).toBe(false);
  });

  it('tells messages apart by Message-ID before uid', () => {
    expect(sameReply({ mode: 'reply', replyTo: msg }, { mode: 'reply', replyTo: { ...msg, messageId: '<b@x>' } })).toBe(false);
  });

  it('without a Message-ID the same uid in another account or folder is another message', () => {
    const bare = { uid: 7, _accountId: 'acct-1', _mailbox: 'INBOX' };
    expect(sameReply({ mode: 'reply', replyTo: bare }, { mode: 'reply', replyTo: { ...bare } })).toBe(true);
    expect(sameReply({ mode: 'reply', replyTo: bare }, { mode: 'reply', replyTo: { ...bare, _accountId: 'acct-2' } })).toBe(false);
    expect(sameReply({ mode: 'reply', replyTo: bare }, { mode: 'reply', replyTo: { ...bare, _mailbox: 'Sent' } })).toBe(false);
  });

  it('a new or prefilled compose never matches anything', () => {
    expect(sameReply({ initialData: { to: 'a@x' } }, { initialData: { to: 'a@x' } })).toBe(false);
    expect(sameReply({ mode: 'reply', replyTo: msg }, { initialData: { to: 'a@x' } })).toBe(false);
  });
});
