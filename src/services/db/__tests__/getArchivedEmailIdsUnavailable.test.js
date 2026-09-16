/**
 * Final fix wave I-5: `getArchivedEmailIds` used to answer a failed read
 * (daemon not up yet, cold start, mid vault-move) with an empty Set — the
 * same shape as "this account genuinely has nothing archived". Every caller
 * that persists that into the store then durably drops the
 * serverDeleted/serverAbsent stamp `stampVaultEntry` gates on it (see
 * messageMutations.js). The fix is at the source: `null` means "could not
 * read", not "there are none".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

if (!globalThis.window) globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

let listShouldFail = false;

vi.mock('../../transport.js', () => ({
  send: (cmd) => {
    if (cmd === 'maildir_repair_generation') return Promise.resolve({ ran: false, rebound: [], orphaned: [], kept: 0, errors: 0, generation: 1 });
    if (cmd === 'maildir_list') {
      return listShouldFail
        ? Promise.reject(new Error('E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the vault is being moved'))
        : Promise.resolve([{ uid: 3, flags: ['archived'], isArchived: true, size: 10 }]);
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
  readDir: () => Promise.resolve([]),
  exists: () => Promise.resolve(false),
  BaseDirectory: { AppData: 1 },
}));

let db;
beforeEach(async () => {
  listShouldFail = false;
  db = await import('../emails.js');
});
afterEach(() => { vi.clearAllMocks(); });

const ACCOUNT = 'acc-1';

describe('getArchivedEmailIds unavailable read (I-5)', () => {
  it('RED on the old code: a failed read returns null, not an empty Set', async () => {
    listShouldFail = true;
    const result = await db.getArchivedEmailIds(ACCOUNT, 'INBOX');
    expect(result).toBeNull();
  });

  it('control: a successful read still returns the real Set', async () => {
    listShouldFail = false;
    const result = await db.getArchivedEmailIds(ACCOUNT, 'INBOX');
    expect(result).toEqual(new Set([3]));
  });
});
