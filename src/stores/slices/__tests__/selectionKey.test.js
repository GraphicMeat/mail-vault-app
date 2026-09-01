/**
 * A selection key has to name a message. `accountId:uid` does not: the unified
 * list merges each account's INBOX with its Sent folder, and a uid is unique
 * only inside one mailbox — so one account's INBOX 34 and its Sent 34 are two
 * different messages sharing one key.
 *
 * Same shape as the bug that made a search hit open a different message, one
 * level down: there the uid was read against the selected folder, here it is
 * read against the account.
 */
import { describe, it, expect } from 'vitest';
import { _selKey, _parseSelKey } from '../unifiedHelpers';

const row = (accountId, mailbox, uid) => ({ _accountId: accountId, _mailbox: mailbox, uid });

describe('_selKey', () => {
  it('separates the same uid in two folders of one account', () => {
    const inbox = row('acct-1', 'INBOX', 34);
    const sent = row('acct-1', 'Sent', 34);
    expect(_selKey(inbox)).not.toBe(_selKey(sent));
  });

  it('still separates the same uid in two accounts', () => {
    expect(_selKey(row('acct-1', 'INBOX', 34))).not.toBe(_selKey(row('acct-2', 'INBOX', 34)));
  });

  it('gives one message one key', () => {
    expect(_selKey(row('acct-1', 'INBOX', 34))).toBe(_selKey(row('acct-1', 'INBOX', 34)));
  });

  it('round-trips through the parser', () => {
    const email = row('acct-1', 'INBOX.Lieferanten.Technik', 34);
    const parsed = _parseSelKey(_selKey(email));
    expect(parsed).toMatchObject({ accountId: 'acct-1', mailbox: 'INBOX.Lieferanten.Technik', uid: 34 });
  });

  it('reads a bare uid as a bare uid, for the single-folder list', () => {
    expect(_parseSelKey(34)).toMatchObject({ accountId: null, uid: 34 });
    expect(_parseSelKey('34')).toMatchObject({ accountId: null, uid: 34 });
  });

  it('survives a folder name containing the separator', () => {
    const email = row('acct-1', 'Weird:Name', 7);
    expect(_parseSelKey(_selKey(email))).toMatchObject({ accountId: 'acct-1', uid: 7 });
  });
});
