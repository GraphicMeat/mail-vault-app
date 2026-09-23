/**
 * Final fix wave I-5: a vault read that failed (daemon not up yet, cold
 * start, mid vault-move) used to answer with an empty Set, the same shape as
 * "this account genuinely has nothing archived". Every caller that persists
 * that into the store then durably drops the serverDeleted/serverAbsent stamp
 * `stampVaultEntry` gates on it (see messageMutations.js). The fix is at the
 * source: `null` means "could not read", not "there are none".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

if (!globalThis.window) globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

// The registry reads' replies, per test: a value, or an Error to reject with.
let registryReply = {};

vi.mock('../../transport.js', () => ({
  send: (cmd) => {
    if (cmd === 'vault_uid_sets' || cmd === 'vault_light_rows') {
      const r = registryReply[cmd];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    if (cmd === 'maildir_repair_generation') return Promise.resolve({ ran: false, rebound: [], orphaned: [], kept: 0, errors: 0, generation: 1 });
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
  registryReply = {};
  db = await import('../emails.js');
});
afterEach(() => { vi.clearAllMocks(); });

const ACCOUNT = 'acc-1';

// Unknown is `null`, never an empty Set / empty list a caller would persist
// as fact.
describe('getVaultUidSets and getLocalEmails unknown reads', () => {
  const unavailable = () => new Error('E_VAULT_UNAVAILABLE: Mail storage folder unavailable: the vault is being moved');

  it('getVaultUidSets returns null when the call rejects', async () => {
    registryReply.vault_uid_sets = unavailable();
    expect(await db.getVaultUidSets(ACCOUNT, 'INBOX')).toBeNull();
  });

  it('getVaultUidSets returns null when the daemon answers null (unknown)', async () => {
    registryReply.vault_uid_sets = null;
    expect(await db.getVaultUidSets(ACCOUNT, 'INBOX')).toBeNull();
  });

  it('getVaultUidSets returns null on a malformed reply', async () => {
    registryReply.vault_uid_sets = { saved: [1] };
    expect(await db.getVaultUidSets(ACCOUNT, 'INBOX')).toBeNull();
  });

  it('control: getVaultUidSets returns both Sets, and a real empty stays empty', async () => {
    registryReply.vault_uid_sets = { saved: [3, 4], archived: [3] };
    expect(await db.getVaultUidSets(ACCOUNT, 'INBOX')).toEqual({ saved: new Set([3, 4]), archived: new Set([3]) });
    registryReply.vault_uid_sets = { saved: [], archived: [] };
    expect(await db.getVaultUidSets(ACCOUNT, 'INBOX')).toEqual({ saved: new Set(), archived: new Set() });
  });

  it('getLocalEmails returns null when the call rejects or the daemon answers null', async () => {
    registryReply.vault_light_rows = unavailable();
    expect(await db.getLocalEmails(ACCOUNT, 'INBOX')).toBeNull();
    registryReply.vault_light_rows = null;
    expect(await db.getLocalEmails(ACCOUNT, 'INBOX')).toBeNull();
  });

  it('control: getLocalEmails returns a real empty mailbox as []', async () => {
    registryReply.vault_light_rows = [];
    expect(await db.getLocalEmails(ACCOUNT, 'INBOX')).toEqual([]);
  });
});
