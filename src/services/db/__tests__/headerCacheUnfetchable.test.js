/**
 * A mailbox can list UIDs whose headers the server never hands back (a FETCH
 * line that will not parse, a message the server lists but cannot serve). The
 * daemon remembers them and reports how many as `unfetchable`. Every read the
 * app makes counts them as accounted for, so a cache holding every message
 * the server can serve reads as complete: no "downloading" bar that never
 * ends, and no paging the server for mail that is already on disk.
 */
import { describe, it, expect, vi } from 'vitest';

const CACHE = {
  accountId: 'acct-1',
  mailbox: 'INBOX',
  totalEmails: 5,
  totalCached: 3,
  unfetchable: 2,
  lastSynced: 1,
  emails: [{ uid: 5 }, { uid: 4 }, { uid: 1 }],
};

vi.mock('../../transport.js', () => ({
  send: (cmd) => {
    if (['load_email_cache', 'load_email_cache_partial', 'load_email_cache_meta', 'load_email_cache_window'].includes(cmd)) {
      return Promise.resolve(JSON.stringify(CACHE));
    }
    return Promise.resolve(null);
  },
}));

const { getEmailHeadersPartial, getEmailHeadersMeta, getEmailHeadersWindow } =
  await import('../caches.js');

describe('a cache short only by messages the server cannot serve', () => {
  it.each([
    ['meta', () => getEmailHeadersMeta('acct-1', 'INBOX')],
    ['partial', () => getEmailHeadersPartial('acct-1', 'INBOX', 200)],
    ['window', () => getEmailHeadersWindow('acct-1', 'INBOX', 0, 200)],
  ])('reads as complete on the %s read', async (_name, read) => {
    const entry = await read();
    expect(entry.totalCached).toBe(5);
    expect(entry.totalEmails).toBe(5);
  });
});
