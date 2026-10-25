// A JMAP account stores its session host in imapHost, so the logical key
// (email + host) needs no JMAP branch: two JMAP accounts of one address on
// different servers stay two accounts, and a JMAP account never dedupes
// against the same address's IMAP account (existing Fastmail IMAP accounts
// are never converted).
import { describe, it, expect, vi } from 'vitest';

// accounts.js reaches the keychain, the daemon transport, plugin-fs and i18n
// at module load; stub them so the import stays hermetic. graphConfig.js
// stays real (accounts.js only reads isPersonalMicrosoftEmail from it).
vi.mock('../keychain.js', () => ({
  parseKeychainValue: (id, v) => JSON.parse(v),
  getAccountsFromKeychain: () => [],
  loadKeychain: vi.fn(async () => ({})),
  saveCredentials: vi.fn(async () => {}),
  deleteCredentials: vi.fn(async () => {}),
  updateCredentials: vi.fn(async () => true),
  assertNativeWriteAllowed: vi.fn(),
  beginNativeWrite: () => () => {},
  readCurrentCredentials: vi.fn(async () => ({})),
  assertLegacyWriteAllowed: vi.fn(),
  markNativeMutationUncertain: vi.fn(),
}));
vi.mock('../../keychainSession.js', () => ({ getStatus: () => 'granted', E_KEYCHAIN_UNAVAILABLE: 'E_KEYCHAIN_UNAVAILABLE', E_KEYCHAIN_WRITE: 'E_KEYCHAIN_WRITE' }));
vi.mock('../../transport.js', () => ({ send: vi.fn(async () => ({})) }));
vi.mock('../../../i18n/index.js', () => ({ t: (k) => k }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => false),
  readTextFile: vi.fn(async () => '[]'),
  writeTextFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  BaseDirectory: { AppData: 1 },
}));

const { accountLogicalKey } = await import('../accounts.js');

describe('accountLogicalKey for JMAP accounts', () => {
  it('keys two JMAP accounts with one address on different hosts apart', () => {
    const fastmail = {
      email: 'A@x.test', authType: 'password', imapHost: 'api.fastmail.com',
      jmapSessionUrl: 'https://api.fastmail.com/jmap/session', jmapAuth: 'bearer',
    };
    const stalwart = {
      email: 'a@x.test', authType: 'password', imapHost: 'mail.x.test',
      jmapSessionUrl: 'https://mail.x.test/.well-known/jmap', jmapAuth: 'basic',
    };
    expect(accountLogicalKey(fastmail)).toBe('a@x.test@api.fastmail.com');
    expect(accountLogicalKey(stalwart)).toBe('a@x.test@mail.x.test');
    expect(accountLogicalKey(fastmail)).not.toBe(accountLogicalKey(stalwart));
  });

  it('never folds a JMAP account into the same address\'s IMAP account', () => {
    const imap = { email: 'a@fastmail.com', authType: 'password', imapHost: 'imap.fastmail.com' };
    const jmap = {
      email: 'a@fastmail.com', authType: 'password', imapHost: 'api.fastmail.com',
      jmapSessionUrl: 'https://api.fastmail.com/jmap/session', jmapAuth: 'bearer',
    };
    expect(accountLogicalKey(imap)).not.toBe(accountLogicalKey(jmap));
  });
});

// The daemon dedupes `accounts.put {ifAbsent}` by the same key
// (`mailvault_core::accounts_doc::logical_key`): both read one fixture.
describe('accountLogicalKey matches the daemon', () => {
  it('answers every case of the shared fixture', async () => {
    const { readFileSync } = await import('node:fs');
    const cases = JSON.parse(readFileSync('src-core/tests/fixtures/account-logical-key-cases.json', 'utf8'));
    expect(cases.length).toBeGreaterThan(5);
    for (const { account, key } of cases) expect(accountLogicalKey(account), JSON.stringify(account)).toBe(key);
  });
});
