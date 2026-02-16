import { describe, it, expect } from 'vitest';
import { parseKeychainValue, getAccountsFromKeychain } from '../../src/services/keychainUtils.js';

// ── parseKeychainValue ──────────────────────────────────────────────

describe('parseKeychainValue', () => {
  it('parses valid JSON with email field', () => {
    const value = JSON.stringify({
      id: 'abc-123',
      email: 'luke@example.com',
      imapServer: 'imap.example.com',
      smtpServer: 'smtp.example.com',
      password: 'secret',
    });
    const result = parseKeychainValue('abc-123', value);
    expect(result.email).toBe('luke@example.com');
    expect(result.password).toBe('secret');
    expect(result.id).toBe('abc-123');
  });

  it('returns legacy object for plain password string', () => {
    const result = parseKeychainValue('abc-123', 'my-plain-password');
    expect(result).toEqual({ id: 'abc-123', password: 'my-plain-password' });
    expect(result.email).toBeUndefined();
  });

  it('falls through when JSON has no email field', () => {
    const value = JSON.stringify({ id: 'abc-123', password: 'secret' });
    const result = parseKeychainValue('abc-123', value);
    expect(result).toEqual({ id: 'abc-123', password: value });
    expect(result.email).toBeUndefined();
  });

  it('handles empty string value', () => {
    const result = parseKeychainValue('abc-123', '');
    expect(result).toEqual({ id: 'abc-123', password: '' });
  });

  it('handles malformed JSON', () => {
    const result = parseKeychainValue('abc-123', '{bad json');
    expect(result).toEqual({ id: 'abc-123', password: '{bad json' });
  });
});

// ── getAccountsFromKeychain ─────────────────────────────────────────

describe('getAccountsFromKeychain', () => {
  it('returns array of accounts from mixed keychain data', () => {
    const data = {
      'acc-1': JSON.stringify({ id: 'acc-1', email: 'alice@example.com', password: 'pass1' }),
      'acc-2': 'plain-password-legacy',
    };
    const accounts = getAccountsFromKeychain(data);
    expect(accounts).toHaveLength(2);
    expect(accounts[0].email).toBe('alice@example.com');
    expect(accounts[1]).toEqual({ id: 'acc-2', password: 'plain-password-legacy' });
  });

  it('returns empty array for empty object', () => {
    expect(getAccountsFromKeychain({})).toEqual([]);
  });

  it('correctly distinguishes new-format from legacy accounts', () => {
    const data = {
      'new-1': JSON.stringify({ id: 'new-1', email: 'a@b.com', password: 'x' }),
      'new-2': JSON.stringify({ id: 'new-2', email: 'c@d.com', password: 'y' }),
      'legacy-1': 'oldpass',
    };
    const accounts = getAccountsFromKeychain(data);
    const withEmail = accounts.filter(a => a.email);
    const withoutEmail = accounts.filter(a => !a.email);
    expect(withEmail).toHaveLength(2);
    expect(withoutEmail).toHaveLength(1);
  });
});

// ── Legacy cleanup logic ────────────────────────────────────────────
// The cleanup in initDB() iterates keychain entries, parses each with
// parseKeychainValue, and removes entries where !account.email.
// We test this pattern by composing the exported pure functions.

describe('legacy cleanup logic', () => {
  function identifyKeysToRemove(data) {
    return Object.keys(data).filter(key => {
      const account = parseKeychainValue(key, data[key]);
      return !account.email;
    });
  }

  it('identifies legacy entries to remove from mixed data', () => {
    const data = {
      'valid-1': JSON.stringify({ id: 'valid-1', email: 'a@b.com', password: 'x' }),
      'legacy-1': 'oldpass',
      'legacy-2': JSON.stringify({ id: 'legacy-2', password: 'y' }),
    };
    const keysToRemove = identifyKeysToRemove(data);
    expect(keysToRemove).toEqual(expect.arrayContaining(['legacy-1', 'legacy-2']));
    expect(keysToRemove).not.toContain('valid-1');
    expect(keysToRemove).toHaveLength(2);
  });

  it('leaves valid accounts untouched', () => {
    const data = {
      'acc-1': JSON.stringify({ id: 'acc-1', email: 'a@b.com', password: 'x' }),
      'acc-2': JSON.stringify({ id: 'acc-2', email: 'c@d.com', password: 'y' }),
    };
    const keysToRemove = identifyKeysToRemove(data);
    expect(keysToRemove).toHaveLength(0);
  });

  it('removes all entries when all are legacy', () => {
    const data = {
      'old-1': 'pass1',
      'old-2': 'pass2',
      'old-3': JSON.stringify({ id: 'old-3', password: 'pass3' }),
    };
    const keysToRemove = identifyKeysToRemove(data);
    expect(keysToRemove).toHaveLength(3);
  });

  it('handles empty keychain (no-op)', () => {
    const keysToRemove = identifyKeysToRemove({});
    expect(keysToRemove).toHaveLength(0);
  });

  it('produces clean data after removing legacy entries', () => {
    const data = {
      'valid-1': JSON.stringify({ id: 'valid-1', email: 'a@b.com', password: 'x' }),
      'legacy-1': 'oldpass',
    };
    const keysToRemove = identifyKeysToRemove(data);
    for (const key of keysToRemove) {
      delete data[key];
    }
    const remaining = getAccountsFromKeychain(data);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].email).toBe('a@b.com');
  });
});
