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

// ── Which lists span more than one mailbox ─────────────────────────────────
import { spansMailboxes } from '../unifiedHelpers';

describe('spansMailboxes', () => {
  it('is false for an ordinary folder, where activeMailbox names the location', () => {
    expect(spansMailboxes({ activeMailbox: 'INBOX', mailboxScope: null })).toBe(false);
  });

  it('is true for the unified inbox', () => {
    expect(spansMailboxes({ activeMailbox: 'UNIFIED', mailboxScope: null })).toBe(true);
  });

  it('is true for a folder subtree', () => {
    // Same consequence as unified: a row's location has to be read off the row.
    expect(spansMailboxes({
      activeMailbox: 'Kunden',
      mailboxScope: { root: 'Kunden', paths: ['Kunden', 'Kunden/Company XY'] },
    })).toBe(true);
  });

  it('does not fall over on a half-built state', () => {
    expect(spansMailboxes(null)).toBe(false);
    expect(spansMailboxes({})).toBe(false);
  });
});

// ── One producer, or the checkbox and the store disagree ───────────────────
// The list built the key inline, the store built it inline, and the helper
// built a third. They agreed only by coincidence: correcting the helper alone
// left the checkbox writing a key nothing else could read, and no test saw it.
describe('nothing builds a selection key by hand', () => {
  it('leaves no inline `accountId:uid` template outside the helper', async () => {
    const { execSync } = await import('node:child_process');
    // Only keys that END in a uid — `${accountId}:${mailbox}` is a cache key
    // for a whole folder and is a different thing entirely.
    const out = execSync(
      "grep -rnE '[$][{][A-Za-z_.]*[Aa]ccountId[}]:[$][{][A-Za-z_.]*[Uu]id[}]' "
      + "src --include='*.js' --include='*.jsx' "
      + "| grep -v __tests__ | grep -v unifiedHelpers.js | grep -v loadUnifiedInbox.js || true",
      { encoding: 'utf8' }
    ).trim();
    // One exclusion: loadUnifiedInbox's is a different key with a different
    // job — it dedupes rows within one folder per account, and says so where it
    // is defined. `selectedEmailId` used to be excluded too; it goes through
    // rowKey now.
    expect(out).toBe('');
  });
});
