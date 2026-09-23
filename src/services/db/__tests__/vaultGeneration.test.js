/**
 * The vault is keyed (accountId, mailbox, uid), and a uid only means anything
 * inside one UIDVALIDITY generation. After a reissue, a uid set read straight
 * off Maildir filenames answers "yes, uid N is archived" about a message that
 * is not the one in the row.
 *
 * The uid sets and the light rows now come from the daemon's registry, and the
 * daemon runs the generation repair itself, under the mailbox lock, before it
 * answers (`vault_uid_sets` / `vault_light_rows`). So those reads send no JS
 * repair and never list the folder. The custody readers still repair from JS
 * first, and those assert the ORDER: a repair that runs after the read leaves
 * the same wrong answer on screen as no repair at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

if (!globalThis.window) globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const calls = [];
let repairImpl = null;

vi.mock('../../transport.js', () => ({
  send: (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'maildir_repair_generation') {
      return repairImpl
        ? repairImpl(args)
        : Promise.resolve({ ran: false, rebound: [], orphaned: [], kept: 0, errors: 0, generation: 1 });
    }
    if (cmd === 'vault_uid_sets') return Promise.resolve({ saved: [3, 4], archived: [3] });
    if (cmd === 'vault_light_rows') return Promise.resolve([{ uid: 3, subject: 's', snippet: '', flags: ['archived'], isArchived: true }]);
    if (cmd === 'local_index_read') return Promise.resolve('[{"uid":3,"source":"local"}]');
    return Promise.resolve(null);
  },
}));

vi.mock('../accounts.js', () => ({
  initDB: () => Promise.resolve(),
  initBasic: () => Promise.resolve(),
  accountDir: () => 'acct',
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: () => Promise.resolve([]),
  exists: () => Promise.resolve(false),
  BaseDirectory: { AppData: 1 },
}));

let db;
beforeEach(async () => {
  calls.length = 0;
  repairImpl = null;
  db = await import('../emails.js');
});
afterEach(() => { vi.clearAllMocks(); });

const ACCOUNT = 'acc-1';

describe('vault generation repair', () => {
  it('leaves the uid sets to the daemon: one registry read, no JS repair, no listing', async () => {
    const sets = await db.getVaultUidSets(ACCOUNT, 'INBOX');
    expect(calls).toEqual(['vault_uid_sets']);
    expect([...sets.saved]).toEqual([3, 4]);
    expect([...sets.archived]).toEqual([3]);
  });

  it('reads the light rows before any JS repair; only the custody stamp repairs, for its own read', async () => {
    const rows = await db.getLocalEmails(ACCOUNT, 'INBOX');
    expect(rows.map(r => r.uid)).toEqual([3]);
    expect(calls).toEqual(['vault_light_rows', 'maildir_repair_generation', 'local_index_read']);
    expect(calls).not.toContain('maildir_list');
  });

  it('repairs before reading the local index the list renders from', async () => {
    await db.readLocalEmailIndex(ACCOUNT, 'INBOX');
    expect(calls).toEqual(['maildir_repair_generation', 'local_index_read']);
  });

  it('repairs before reading provenance for a destructive path', async () => {
    await db.getLocalIndexProvenance(ACCOUNT, 'INBOX');
    expect(calls).toEqual(['maildir_repair_generation', 'local_index_read']);
  });

  it('repairs before reading the single index entry a reopen needs', async () => {
    // Same reason as provenance: a uid only means anything inside one
    // generation, and this entry decides whether a row opens in compose.
    await db.getLocalIndexEntry(ACCOUNT, 'INBOX', 3);
    expect(calls).toEqual(['maildir_repair_generation', 'local_index_read']);
  });

  it('runs one repair when two custody readers are awaited together', async () => {
    // Two concurrent repairs would be two concurrent rename passes over the
    // same directory.
    let release;
    const started = [];
    repairImpl = () => {
      started.push(1);
      return new Promise((resolve) => { release = () => resolve({ ran: true, rebound: [], orphaned: [], kept: 0, errors: 0, generation: 2 }); });
    };

    const both = Promise.all([
      db.readLocalEmailIndex(ACCOUNT, 'INBOX'),
      db.getLocalIndexMeta(ACCOUNT, 'INBOX'),
    ]);
    // Flush every queued microtask so both readers are past their own awaits.
    await new Promise((r) => setTimeout(r, 0));
    expect(started.length).toBe(1);
    release();
    await both;

    expect(calls.filter(c => c === 'maildir_repair_generation').length).toBe(1);
    expect(calls.filter(c => c === 'local_index_read').length).toBe(2);
  });

  it('does not share a repair between two mailboxes', async () => {
    await Promise.all([
      db.readLocalEmailIndex(ACCOUNT, 'INBOX'),
      db.readLocalEmailIndex(ACCOUNT, 'Sent'),
    ]);
    expect(calls.filter(c => c === 'maildir_repair_generation').length).toBe(2);
  });

  it('still reads the custody entries when the repair fails', async () => {
    // A repair that cannot run is a reason to warn, not a reason to blank the
    // mailbox: the pre-existing behaviour is no worse than it was.
    repairImpl = () => Promise.reject(new Error('vault unreadable'));
    const rows = await db.readLocalEmailIndex(ACCOUNT, 'INBOX');
    expect(rows.map(r => r.uid)).toEqual([3]);
  });

  it('skips the repair when there is no mailbox to repair', async () => {
    await db.readLocalEmailIndex(ACCOUNT, '');
    expect(calls).toEqual(['local_index_read']);
  });
});

describe('getLocalIndexEntry', () => {
  it('returns the entry for that uid', async () => {
    expect(await db.getLocalIndexEntry(ACCOUNT, 'INBOX', 3)).toEqual({ uid: 3, source: 'local' });
  });

  it('matches a uid the caller passed as a string', async () => {
    // Row uids arrive from the DOM and from Maildir filenames — one side is a
    // string often enough that a === comparison would answer "no such draft".
    expect(await db.getLocalIndexEntry(ACCOUNT, 'INBOX', '3')).toEqual({ uid: 3, source: 'local' });
  });

  it('returns null for a uid the index does not carry', async () => {
    expect(await db.getLocalIndexEntry(ACCOUNT, 'INBOX', 99)).toBe(null);
  });
});
