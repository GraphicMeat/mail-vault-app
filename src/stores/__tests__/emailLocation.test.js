import { describe, it, expect } from 'vitest';
import { resolveEmailLocation, bodyMatchesHeader, emailKey, vaultDirName, mailboxPathFromVaultDir } from '../slices/unifiedHelpers';

// A UID is unique only within one (account, mailbox). Every case here is a way
// the old "guess from the active view" resolution read a real but different
// message — the wrong-mailbox body bug.

const state = (over = {}) => ({
  activeAccountId: 'acct-1',
  activeMailbox: 'INBOX',
  getSentMailboxPath: () => 'Sent',
  ...over,
});

describe('resolveEmailLocation', () => {
  it('prefers the folder tagged on the message over the active view', () => {
    const email = { uid: 2, _accountId: 'acct-2', _mailbox: 'Archive' };
    expect(resolveEmailLocation(email, state())).toEqual({ accountId: 'acct-2', mailbox: 'Archive' });
  });

  it('resolves a sent message of the active account to the Sent path', () => {
    const email = { uid: 2, _fromSentFolder: true };
    expect(resolveEmailLocation(email, state())).toEqual({ accountId: 'acct-1', mailbox: 'Sent' });
  });

  it('returns null for a sent message when the Sent path is unknown', () => {
    const email = { uid: 2, _fromSentFolder: true };
    expect(resolveEmailLocation(email, state({ getSentMailboxPath: () => null }))).toBeNull();
  });

  it('returns null for another account\'s untagged message instead of guessing INBOX', () => {
    const email = { uid: 2, _accountId: 'acct-2' };
    expect(resolveEmailLocation(email, state())).toBeNull();
  });

  it('pins the account the list was built for, not the one active later', () => {
    const email = { uid: 2, _srcAccountId: 'acct-1', _mailbox: 'INBOX' };
    const drifted = state({ activeAccountId: 'acct-99' });
    expect(resolveEmailLocation(email, drifted)).toEqual({ accountId: 'acct-1', mailbox: 'INBOX' });
  });

  it('never returns the virtual UNIFIED mailbox', () => {
    const email = { uid: 2 };
    expect(resolveEmailLocation(email, state({ activeMailbox: 'UNIFIED' }))).toBeNull();
  });
});

describe('emailKey', () => {
  it('separates the same UID across mailboxes and accounts', () => {
    const keys = new Set([
      emailKey({ uid: 2, _srcAccountId: 'acct-1', _mailbox: 'INBOX' }),
      emailKey({ uid: 2, _srcAccountId: 'acct-1', _mailbox: 'Sent', _fromSentFolder: true }),
      emailKey({ uid: 2, _accountId: 'acct-2', _mailbox: 'INBOX' }),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe('bodyMatchesHeader', () => {
  it('rejects a body belonging to a different message', () => {
    expect(bodyMatchesHeader({ messageId: '<a@x>' }, { messageId: '<b@x>' })).toBe(false);
  });

  it('accepts the matching body, snake_case included', () => {
    expect(bodyMatchesHeader({ messageId: '<a@x>' }, { message_id: '<a@x>' })).toBe(true);
  });

  it('allows the pairing when either side has no Message-ID', () => {
    expect(bodyMatchesHeader({ messageId: '<a@x>' }, {})).toBe(true);
    expect(bodyMatchesHeader({}, { messageId: '<a@x>' })).toBe(true);
  });
});

describe('vault directory names', () => {
  const SERVER_PATH = 'INBOX.Archive.Projekt Nystart.Lieferanten.CRM Centralstation';
  const VAULT_DIR = 'INBOX.Archive.Projekt_Nystart.Lieferanten.CRM_Centralstation';
  const boxes = [{ path: 'INBOX', children: [{ path: SERVER_PATH, children: [] }] }];

  it('sanitises the way maildir_cur_path does — spaces out, dots kept', () => {
    expect(vaultDirName(SERVER_PATH)).toBe(VAULT_DIR);
    expect(vaultDirName('[Gmail]/Sent Mail')).toBe('_Gmail__Sent_Mail');
  });

  it('keeps non-ASCII letters, because Rust is_alphanumeric does', () => {
    // "Entw_rfe" would be a different directory from the one Rust writes.
    expect(vaultDirName('INBOX.Entwürfe')).toBe('INBOX.Entwürfe');
  });

  it('recovers the server path from a directory name', () => {
    expect(mailboxPathFromVaultDir(VAULT_DIR, boxes)).toBe(SERVER_PATH);
  });

  it('returns an unmatched directory unchanged rather than guessing', () => {
    expect(mailboxPathFromVaultDir('INBOX.Gone', boxes)).toBe('INBOX.Gone');
  });
});
