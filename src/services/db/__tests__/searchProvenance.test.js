/**
 * A search result is the one row in the app that is guaranteed NOT to belong to
 * the folder on screen — search spans folders by design. Nothing stamped where
 * these rows came from, so opening one fetched the uid from `activeMailbox`,
 * and the server answered, correctly, that the uid is not there.
 *
 * Reported by bson73 (discussion #1) against v2.10.1:
 *   "Message UID 34 is no longer in INBOX.Archive.Projekt Nystart.Lieferanten.CRM Centralstation"
 * — the mailbox named is his SELECTED folder, not the hit's folder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

if (!globalThis.window) globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

const listed = [];

vi.mock('../../transport.js', () => ({
  send: (cmd, args) => {
    if (cmd === 'maildir_list') {
      listed.push(args.mailbox);
      return Promise.resolve([{ uid: 34, flags: [], isArchived: true, size: 10 }]);
    }
    if (cmd === 'maildir_read_light_batch') {
      return Promise.resolve([{ uid: 34, subject: 'Angebot', from: { address: 'a@b.c' } }]);
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

// One vault directory, sanitised the way maildir_cur_path sanitises it.
const VAULT_DIR = 'INBOX.Archive.Projekt_Nystart.Lieferanten.CRM_Centralstation';
const SERVER_PATH = 'INBOX.Archive.Projekt Nystart.Lieferanten.CRM Centralstation';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: () => Promise.resolve([{ name: VAULT_DIR, isDirectory: true }]),
  exists: () => Promise.resolve(true),
  BaseDirectory: { AppData: 1 },
}));

const MAILBOXES = [
  { name: 'INBOX', path: 'INBOX', children: [
    { name: 'Archive', path: 'INBOX.Archive', children: [
      { name: 'Projekt Nystart', path: 'INBOX.Archive.Projekt Nystart', children: [
        { name: 'Lieferanten', path: 'INBOX.Archive.Projekt Nystart.Lieferanten', children: [
          { name: 'CRM Centralstation', path: SERVER_PATH, children: [] },
        ] },
      ] },
    ] },
  ] },
];

beforeEach(() => { listed.length = 0; });

describe('local vault rows carry their own location', () => {
  it('stamps _mailbox and _accountId on every row getLocalEmails returns', async () => {
    const { getLocalEmails } = await import('../emails.js');
    const rows = await getLocalEmails('acct-1', 'INBOX.Archive');
    expect(rows).toHaveLength(1);
    expect(rows[0]._mailbox).toBe('INBOX.Archive');
    expect(rows[0]._accountId).toBe('acct-1');
  });

  it('un-sanitises the vault directory back into a path IMAP can SELECT', async () => {
    const { getAllLocalEmails } = await import('../emails.js');
    const rows = await getAllLocalEmails('acct-1', MAILBOXES);
    // The directory name has underscores where the mailbox has spaces. A row
    // stamped with the directory name is a row that cannot be fetched.
    expect(rows[0]._mailbox).toBe(SERVER_PATH);
    expect(listed).toEqual([SERVER_PATH]);
  });

  it('keeps an unknown directory as itself rather than inventing a path', async () => {
    const { getAllLocalEmails } = await import('../emails.js');
    const rows = await getAllLocalEmails('acct-1', []);
    expect(rows[0]._mailbox).toBe(VAULT_DIR);
  });
});
