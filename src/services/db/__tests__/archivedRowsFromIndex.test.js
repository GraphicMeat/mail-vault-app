/**
 * The archived list is built from three sources, cheapest first.
 *
 * The middle tier used to be `archived_headers.json`, a per-folder file this
 * function wrote itself. Nothing patched its flags and the startup import
 * renames it away, so it came back stale or not at all. The search index holds
 * the same rows for the same files, already parsed and keyed by uid, so the
 * tier now reads `vault_rows` and no cache is written at all.
 *
 * What matters per tier: each one is asked ONLY for what the one before it
 * missed (the point of the ordering), a tier that fails is not a missing row,
 * and every row that comes back carries its localId and custody whichever
 * source built it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

if (!globalThis.window) globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const DEFAULTS = {
  load_email_cache_by_uids: (args) => (args.uids.includes(30) ? [{ uid: 30, subject: 'from sidecar' }] : []),
  vault_rows: (args) => (args.uids.includes(20) ? [{ uid: 20, subject: 'from index', flags: ['\\Seen', 'archived'], isArchived: true }] : []),
  maildir_read_light_batch: (args) => args.uids.map((uid) => (uid === 10 ? { uid, subject: 'from eml' } : null)),
};
const ROWS = { ...DEFAULTS };
const calls = [];

vi.mock('../../transport.js', () => ({
  send: (cmd, args) => {
    if (cmd === 'local_index_read') return Promise.resolve(null);
    if (cmd === 'maildir_repair_generation') {
      return Promise.resolve({ ran: false, rebound: [], orphaned: [], kept: 0, errors: 0, generation: 1 });
    }
    calls.push({ cmd, args });
    // An unexpected command is a failure, not a no-op: the retired cache
    // commands must not be reachable from here any more.
    if (!ROWS[cmd]) return Promise.reject(new Error(`unexpected ${cmd}`));
    return Promise.resolve(ROWS[cmd](args));
  },
}));

vi.mock('../accounts.js', () => ({
  initDB: () => Promise.resolve(),
  initBasic: () => Promise.resolve(),
  accountDir: () => 'acct',
}));

describe('getArchivedEmails builds rows from sidecars, then the index, then the files', () => {
  beforeEach(() => {
    calls.length = 0;
    Object.assign(ROWS, DEFAULTS);
  });

  it('asks the index only for what the sidecars missed, and the files only for what the index missed', async () => {
    const { getArchivedEmails } = await import('../emails.js');
    const rows = await getArchivedEmails('acct', 'INBOX', new Set([10, 20, 30]));
    expect(rows.map((r) => [r.uid, r.subject])).toEqual([[30, 'from sidecar'], [20, 'from index'], [10, 'from eml']]);
    expect(calls.find((c) => c.cmd === 'vault_rows').args.uids).toEqual([20, 10]);
    expect(calls.find((c) => c.cmd === 'maildir_read_light_batch').args.uids).toEqual([10]);
    expect(rows.every((r) => r.isArchived === true && r.localId === `acct-INBOX-${r.uid}`)).toBe(true);
    // Nothing outside the three tiers is reached — the retired archived-cache
    // commands included. Naming them here would be the one thing
    // tests/unit/legacyCustodyCommands.test.js forbids, and that guard covers
    // the whole repo, not just this path.
    expect(calls.map((c) => c.cmd).filter((cmd) => !(cmd in DEFAULTS))).toEqual([]);
  });

  it('a failing index read is not a missing row: the files fill in', async () => {
    const { getArchivedEmails } = await import('../emails.js');
    ROWS.vault_rows = () => { throw new Error('index closed'); };
    ROWS.maildir_read_light_batch = (args) => args.uids.map((uid) => ({ uid, subject: `eml ${uid}` }));
    const rows = await getArchivedEmails('acct', 'INBOX', new Set([10, 20]));
    expect(rows.map((r) => r.uid).sort()).toEqual([10, 20]);
  });

  it('reports each tier to onBatch with the rows so far', async () => {
    const { getArchivedEmails } = await import('../emails.js');
    const seen = [];
    await getArchivedEmails('acct', 'INBOX', new Set([10, 20, 30]), (rows) => seen.push(rows.length));
    expect(seen).toEqual([1, 2, 3]);
  });
});
