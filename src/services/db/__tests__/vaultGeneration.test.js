/**
 * The vault is keyed (accountId, mailbox, uid), and a uid only means anything
 * inside one UIDVALIDITY generation. `getSavedEmailIds` / `getArchivedEmailIds`
 * read that uid set straight off Maildir filenames, so after a reissue they
 * answer "yes, uid N is archived" about a message that is not the one in the
 * row.
 *
 * These assert the ORDER, not the end state: a repair that runs after the list
 * has been read leaves the same wrong answer on screen as no repair at all.
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
    if (cmd === 'maildir_list') return Promise.resolve([{ uid: 3, flags: ['archived'], isArchived: true, size: 10 }]);
    if (cmd === 'local_index_read') return Promise.resolve('[{"uid":3,"source":"local"}]');
    if (cmd === 'maildir_read_light_batch') return Promise.resolve([{ uid: 3, subject: 's' }]);
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
  it('repairs before reading the archived uid set off disk', async () => {
    await db.getArchivedEmailIds(ACCOUNT, 'INBOX');
    expect(calls).toEqual(['maildir_repair_generation', 'maildir_list']);
  });

  it('repairs before reading the saved uid set off disk', async () => {
    await db.getSavedEmailIds(ACCOUNT, 'INBOX');
    expect(calls).toEqual(['maildir_repair_generation', 'maildir_list']);
  });

  it('repairs before reading the local index the list renders from', async () => {
    await db.readLocalEmailIndex(ACCOUNT, 'INBOX');
    expect(calls).toEqual(['maildir_repair_generation', 'local_index_read']);
  });

  it('repairs before reading provenance for a destructive path', async () => {
    await db.getLocalIndexProvenance(ACCOUNT, 'INBOX');
    expect(calls).toEqual(['maildir_repair_generation', 'local_index_read']);
  });

  it('runs one repair when both getters are awaited together', async () => {
    // The real load path awaits these in a single Promise.all. Two concurrent
    // repairs would be two concurrent rename passes over the same directory.
    let release;
    const started = [];
    repairImpl = () => {
      started.push(1);
      return new Promise((resolve) => { release = () => resolve({ ran: true, rebound: [], orphaned: [], kept: 0, errors: 0, generation: 2 }); });
    };

    const both = Promise.all([
      db.getSavedEmailIds(ACCOUNT, 'INBOX'),
      db.getArchivedEmailIds(ACCOUNT, 'INBOX'),
    ]);
    // Flush every queued microtask so both getters are past their own awaits.
    await new Promise((r) => setTimeout(r, 0));
    expect(started.length).toBe(1);
    release();
    await both;

    expect(calls.filter(c => c === 'maildir_repair_generation').length).toBe(1);
    expect(calls.filter(c => c === 'maildir_list').length).toBe(2);
  });

  it('does not share a repair between two mailboxes', async () => {
    await Promise.all([
      db.getArchivedEmailIds(ACCOUNT, 'INBOX'),
      db.getArchivedEmailIds(ACCOUNT, 'Sent'),
    ]);
    expect(calls.filter(c => c === 'maildir_repair_generation').length).toBe(2);
  });

  it('still returns the uid set when the repair fails', async () => {
    // A repair that cannot run is a reason to warn, not a reason to blank the
    // mailbox: the pre-existing behaviour is no worse than it was.
    repairImpl = () => Promise.reject(new Error('vault unreadable'));
    const ids = await db.getArchivedEmailIds(ACCOUNT, 'INBOX');
    expect(ids.has(3)).toBe(true);
  });

  it('skips the repair when there is no mailbox to repair', async () => {
    await db.getArchivedEmailIds(ACCOUNT, '');
    expect(calls).toEqual(['maildir_list']);
  });
});
