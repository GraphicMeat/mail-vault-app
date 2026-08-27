/**
 * `maildir_exists` and `maildir_list` answer the same question about the same
 * directory, and for a while they answered it from two different processes.
 *
 * transport.js routed `maildir_exists` to the daemon and left `maildir_list` on
 * Tauri, because only `maildir_list` had a documented shape mismatch. But the
 * daemon answers `{"exists": bool}` where Tauri answers a bare bool, and
 * `{exists: false}` is truthy — so once the daemon's heartbeat connected
 * mid-session, `isEmailSaved` said "already in the vault" about every message.
 * `saveEmailLocally` then took its already-cached branch, never copied anything,
 * and `archiveEmail` failed on a uid `maildir_list` had never seen:
 *
 *   Could not copy that email into your vault. Nothing was removed from the
 *   server. (Email UID 30 not found in Maildir)
 *
 * The route is gone. These hold the contract from the JS side, which is the
 * side that survives an older daemon binary still running the old shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

if (!globalThis.window) globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

let sendImpl = () => Promise.resolve(null);
const sent = [];

vi.mock('../../transport.js', () => ({
  send: (cmd, args) => {
    sent.push({ cmd, args });
    return sendImpl(cmd, args);
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

const db = await import('../emails.js');

beforeEach(() => {
  sent.length = 0;
  sendImpl = () => Promise.resolve(null);
});

describe('isEmailSaved answers a boolean, whatever the transport hands back', () => {
  it('is true for Tauri\'s bare true', async () => {
    sendImpl = () => Promise.resolve(true);
    expect(await db.isEmailSaved('a', 'INBOX', 30)).toBe(true);
  });

  it('is false for Tauri\'s bare false', async () => {
    sendImpl = () => Promise.resolve(false);
    expect(await db.isEmailSaved('a', 'INBOX', 30)).toBe(false);
  });

  it('is false for the daemon envelope {exists:false} — the truthy "no"', async () => {
    sendImpl = () => Promise.resolve({ exists: false });
    expect(await db.isEmailSaved('a', 'INBOX', 30)).toBe(false);
  });

  it('is false for an envelope it cannot read, rather than truthy', async () => {
    sendImpl = () => Promise.resolve({ exists: true });
    // Fail closed: an unrecognised shape means "not proven cached", which costs
    // one refetch. Reading it as cached costs the archive.
    expect(await db.isEmailSaved('a', 'INBOX', 30)).toBe(false);
  });
});

describe('archiveEmail and isEmailSaved agree about the uid type', () => {
  const summaries = [{ uid: 30, flags: ['seen'], isArchived: false, size: 10 }];

  it('finds a numeric summary when the caller holds the string "30"', async () => {
    sendImpl = (cmd) => Promise.resolve(cmd === 'maildir_list' ? summaries : null);
    await expect(db.archiveEmail('a', 'INBOX', '30')).resolves.toBeUndefined();

    const setFlags = sent.find(s => s.cmd === 'maildir_set_flags');
    expect(setFlags.args.uid).toBe(30);
    expect(setFlags.args.flags).toEqual(['seen', 'archived']);
  });

  it('still throws for a uid the vault really does not hold', async () => {
    sendImpl = (cmd) => Promise.resolve(cmd === 'maildir_list' ? summaries : null);
    await expect(db.archiveEmail('a', 'INBOX', 31)).rejects.toThrow('Email UID 31 not found in Maildir');
  });
});
