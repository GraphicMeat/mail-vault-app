/**
 * A vault row has to carry its own custody.
 *
 * `_origin` / `serverDeleted` / `serverAbsent` live in local-index.json and
 * nowhere else — the `.eml` on disk and the Maildir filename know nothing about
 * them. `getArchivedEmails` has always stamped them on. `getLocalEmails` did
 * not, so whichever of the two happened to build the row decided whether the
 * gold "your only copy" claim could be made at all: archive from a path that
 * refreshes through `getLocalEmails` and the mailbox silently went quiet.
 *
 * A comment at that return used to explain the omission as a performance
 * necessity ("left the message list loading forever"). That was a shared-runner
 * accident — a neighbouring e2e session's `pkill -x mock-imap-server` — not this
 * read; see the note there. This test is what should have been asked for
 * instead of the comment.
 */

import { describe, it, expect, vi } from 'vitest';

if (!globalThis.window) globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const INDEX = JSON.stringify([
  { uid: 7, source: 'local_sent' },
  { uid: 8, source: 'local', serverDeleted: true },
  { uid: 9, source: 'local', serverAbsent: true },
]);

vi.mock('../../transport.js', () => ({
  send: (cmd) => {
    if (cmd === 'maildir_list') {
      return Promise.resolve([7, 8, 9, 10].map(uid => ({ uid, flags: [], isArchived: true, size: 10 })));
    }
    if (cmd === 'maildir_read_light_batch') {
      return Promise.resolve([7, 8, 9, 10].map(uid => ({ uid, subject: `s${uid}` })));
    }
    if (cmd === 'local_index_read') return Promise.resolve(INDEX);
    if (cmd === 'maildir_repair_generation') {
      return Promise.resolve({ ran: false, rebound: [], orphaned: [], kept: 0, errors: 0, generation: 1 });
    }
    return Promise.resolve(null);
  },
}));

vi.mock('../accounts.js', () => ({
  initDB: () => Promise.resolve(),
  initBasic: () => Promise.resolve(),
  accountDir: () => 'acct',
}));

describe('getLocalEmails stamps custody', () => {
  it('carries origin, serverDeleted and serverAbsent off the local index', async () => {
    const { getLocalEmails } = await import('../emails.js');
    const byUid = new Map((await getLocalEmails('acct-1', 'INBOX')).map(r => [r.uid, r]));

    expect(byUid.get(7)._origin).toBe('local_sent');
    expect(byUid.get(8).serverDeleted).toBe(true);
    expect(byUid.get(9).serverAbsent).toBe(true);
    // A uid the index has never heard of is left exactly as it was — an absent
    // entry is not evidence of anything, and a `false` here would read as one.
    expect(byUid.get(10)).not.toHaveProperty('serverDeleted');
  });
});
