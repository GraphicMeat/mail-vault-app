/**
 * The header sidecar is per (account, mailbox) — so is what comes out of it.
 *
 * A branch listing merges rows from every folder in the scope and stamps each
 * with its own `_mailbox`. That list was written into the branch ROOT's
 * sidecar, and the root is a real folder ('INBOX' on bson73's INBOX-prefixed
 * server, discussion #1): his INBOX cache holds ~26 000 rows belonging to 58
 * other folders, and every cache-first paint puts them back on screen. Fixing
 * the write does nothing for the caches already on disk — the read has to
 * refuse rows that say, in their own field, that they came from elsewhere.
 */
import { describe, it, expect, vi } from 'vitest';

const CACHE = {
  accountId: 'acct-1',
  mailbox: 'INBOX',
  totalEmails: 26000,
  totalCached: 5,
  lastSynced: 1,
  emails: [
    { uid: 1, subject: 'Filed in the inbox' },
    { uid: 2, subject: 'Also the inbox', _mailbox: 'INBOX', _accountId: 'acct-1' },
    { uid: 3, subject: 'From Kunden', _mailbox: 'INBOX.Kunden', _accountId: 'acct-1' },
    { uid: 4, subject: 'From Trash', _mailbox: 'INBOX.Trash' },
    { uid: 5, subject: 'From the other account', _accountId: 'acct-2' },
  ],
};

vi.mock('../../transport.js', () => ({
  send: (cmd) => {
    if (cmd === 'load_email_cache' || cmd === 'load_email_cache_partial') {
      return Promise.resolve(JSON.stringify(CACHE));
    }
    if (cmd === 'load_email_cache_by_uids') return Promise.resolve(CACHE.emails);
    return Promise.resolve(null);
  },
}));

const { getEmailHeaders, getEmailHeadersPartial, getEmailHeadersByUids } =
  await import('../caches.js');

const subjects = (rows) => (rows || []).map(e => e.subject);

describe('reading a header cache another folder wrote into', () => {
  it('returns only the rows this mailbox owns', async () => {
    const entry = await getEmailHeaders('acct-1', 'INBOX');

    expect(subjects(entry.emails)).toEqual(['Filed in the inbox', 'Also the inbox']);
    // The count is the server's, not a row count — a polluted list never
    // justified rewriting it, and neither does cleaning one up.
    expect(entry.totalEmails).toBe(26000);
  });

  it('does the same on the partial read the cache-first paint uses', async () => {
    const entry = await getEmailHeadersPartial('acct-1', 'INBOX', 200);

    expect(subjects(entry.emails)).toEqual(['Filed in the inbox', 'Also the inbox']);
    expect(entry.totalEmails).toBe(26000);
  });

  it('does the same for a by-uid read', async () => {
    const rows = await getEmailHeadersByUids('acct-1', 'INBOX', [1, 2, 3, 4, 5]);

    expect(subjects(rows)).toEqual(['Filed in the inbox', 'Also the inbox']);
  });

  it('lets an untagged row through whatever mailbox asked', async () => {
    // The normal case: a single-folder load stamps nothing at all, so an
    // ordinary cache loses nothing to this guard. Only a row that names
    // another folder is refused.
    const entry = await getEmailHeaders('acct-1', 'INBOX.Kunden');

    expect(subjects(entry.emails)).toEqual(['Filed in the inbox', 'From Kunden']);
  });
});
