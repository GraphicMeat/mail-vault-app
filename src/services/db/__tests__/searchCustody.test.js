/**
 * A search hit is the same message as the row in the folder list, and until now
 * it did not look like it. `custodySource` reads `_origin` / `serverDeleted` /
 * `serverAbsent` off the row it is handed, all three of which live in
 * local-index.json — and `getLocalEmails`, which search builds every row from,
 * deliberately never reads that file. So a message the server was ASKED about
 * and does not have rendered gold in the folder list and grey in search
 * results, from one query away.
 *
 * Two halves to the fix and the tests need both: the rows have to carry the
 * proof, AND `searchLocalEmails` has to stop stamping a flat `source: 'local'`
 * over it — `describeMessageState` reads that field first and only falls back
 * to `custodySource` when it is absent.
 *
 * The cost has to stay per MAILBOX. `getAllLocalEmails` walks every vault
 * directory, so an index read per row would be one file read per message in
 * the vault; the walk is already one pass per mailbox and the read rides there.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

if (!globalThis.window) globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

// uid 7 was swept: every folder answered, none had it. uid 8 is an ordinary
// archived copy. uid 9 lives in another mailbox and is ordinary too.
const INDEX = {
  INBOX: [
    { uid: 7, source: 'local', serverAbsent: true },
    { uid: 8, source: 'local' },
  ],
  'INBOX.Archive': [
    { uid: 9, source: 'local' },
  ],
};
const ROWS = {
  INBOX: [7, 8],
  'INBOX.Archive': [9],
};

const calls = [];

vi.mock('../../transport.js', () => ({
  send: (cmd, args) => {
    calls.push({ cmd, mailbox: args?.mailbox });
    if (cmd === 'maildir_list') {
      return Promise.resolve((ROWS[args.mailbox] || []).map(uid => ({ uid, flags: [], isArchived: true, size: 10 })));
    }
    if (cmd === 'maildir_read_light_batch') {
      return Promise.resolve(args.uids.map(uid => ({ uid, subject: `msg ${uid}`, from: { address: 'a@b.c' } })));
    }
    if (cmd === 'local_index_read') {
      return Promise.resolve(INDEX[args.mailbox] ? JSON.stringify(INDEX[args.mailbox]) : null);
    }
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

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: () => Promise.resolve([
    { name: 'INBOX', isDirectory: true },
    { name: 'INBOX.Archive', isDirectory: true },
  ]),
  exists: () => Promise.resolve(true),
  BaseDirectory: { AppData: 1 },
}));

const indexReads = () => calls.filter(c => c.cmd === 'local_index_read');

beforeEach(() => { calls.length = 0; });

describe('a search hit carries the same custody proof as its row in the list', () => {
  it('stamps the proof onto the rows search is built from, off one read per mailbox', async () => {
    const { getLocalEmails } = await import('../emails.js');
    const rows = await getLocalEmails('acct-1', 'INBOX');

    expect(rows.map(r => r.uid)).toEqual([7, 8]);
    expect(rows.find(r => r.uid === 7).serverAbsent).toBe(true);
    // uid 8 has an index entry carrying no proof at all, which is a different
    // thing from a proven absence and must not read as one.
    expect(rows.find(r => r.uid === 8).serverAbsent).toBe(false);
    // Two messages, one file read: the stamp is per mailbox, not per row.
    expect(indexReads()).toHaveLength(1);
  });

  it('stamps the proof on a single-folder search and calls that message the only copy', async () => {
    const { searchLocalEmails } = await import('../emails.js');
    const { custodySource } = await import('../../../stores/slices/custody.js');
    const hits = await searchLocalEmails('acct-1', 'msg', { mailbox: 'INBOX' });

    const swept = hits.find(e => e.uid === 7);
    const ordinary = hits.find(e => e.uid === 8);
    expect(swept.serverAbsent).toBe(true);
    expect(custodySource(swept)).toBe('local-only');
    // The field the icon actually reads, not just the one custody derives from.
    expect(swept.source).toBe('local-only');
    expect(ordinary.source).toBe('local');
  });

  it('stamps it across an all-folders search too', async () => {
    const { searchLocalEmails } = await import('../emails.js');
    const hits = await searchLocalEmails('acct-1', 'msg', { mailbox: 'all', mailboxes: [] });

    expect(hits.map(e => e.uid).sort()).toEqual([7, 8, 9]);
    expect(hits.find(e => e.uid === 7).source).toBe('local-only');
    expect(hits.find(e => e.uid === 9).source).toBe('local');
  });

  it('reads the index once per mailbox, not once per message', async () => {
    const { searchLocalEmails } = await import('../emails.js');
    await searchLocalEmails('acct-1', 'msg', { mailbox: 'all', mailboxes: [] });

    // Three messages across two vault directories.
    expect(indexReads().map(c => c.mailbox)).toEqual(['INBOX', 'INBOX.Archive']);
  });
});
