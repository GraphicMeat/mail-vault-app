import { describe, it, expect } from 'vitest';
import {
  buildBackupEmailPath,
  matchAccountsByEmail,
  parseBackupManifest,
} from '../../src/services/backupUtils.js';

// ── buildBackupEmailPath ────────────────────────────────────────────

describe('buildBackupEmailPath', () => {
  it('builds correct path from email, mailbox, filename', () => {
    const result = buildBackupEmailPath('luke@example.com', 'INBOX', '123:2,AS');
    expect(result).toBe('emails/luke@example.com/INBOX/123:2,AS');
  });

  it('handles special characters in mailbox names', () => {
    const result = buildBackupEmailPath('user@test.com', 'Sent_Items', '456:2,S');
    expect(result).toBe('emails/user@test.com/Sent_Items/456:2,S');
  });

  it('handles mailbox with dots', () => {
    const result = buildBackupEmailPath('a@b.com', 'INBOX.Drafts', '1:2,D');
    expect(result).toBe('emails/a@b.com/INBOX.Drafts/1:2,D');
  });
});

// ── matchAccountsByEmail ────────────────────────────────────────────

describe('matchAccountsByEmail', () => {
  it('matches manifest accounts to existing accounts by email', () => {
    const manifest = [{ email: 'luke@example.com' }];
    const existing = [{ id: 'abc-123', email: 'luke@example.com' }];
    const result = matchAccountsByEmail(manifest, existing);
    expect(result.get('luke@example.com')).toBe('abc-123');
  });

  it('returns null for accounts not found in existing', () => {
    const manifest = [{ email: 'new@example.com' }];
    const existing = [{ id: 'abc-123', email: 'luke@example.com' }];
    const result = matchAccountsByEmail(manifest, existing);
    expect(result.get('new@example.com')).toBeNull();
  });

  it('handles empty manifest accounts', () => {
    const result = matchAccountsByEmail([], [{ id: '1', email: 'a@b.com' }]);
    expect(result.size).toBe(0);
  });

  it('handles empty existing accounts', () => {
    const result = matchAccountsByEmail([{ email: 'a@b.com' }], []);
    expect(result.get('a@b.com')).toBeNull();
  });

  it('handles multiple accounts, some matching, some not', () => {
    const manifest = [
      { email: 'luke@example.com' },
      { email: 'vader@example.com' },
      { email: 'leia@example.com' },
    ];
    const existing = [
      { id: 'id-1', email: 'luke@example.com' },
      { id: 'id-2', email: 'leia@example.com' },
    ];
    const result = matchAccountsByEmail(manifest, existing);
    expect(result.get('luke@example.com')).toBe('id-1');
    expect(result.get('vader@example.com')).toBeNull();
    expect(result.get('leia@example.com')).toBe('id-2');
  });
});

// ── parseBackupManifest ─────────────────────────────────────────────

describe('parseBackupManifest', () => {
  it('parses valid manifest JSON', () => {
    const json = JSON.stringify({
      version: 2,
      exportedAt: '2026-02-16T12:00:00Z',
      accounts: [{ email: 'luke@example.com' }],
      settings: { theme: 'dark' },
    });
    const result = parseBackupManifest(json);
    expect(result.version).toBe(2);
    expect(result.exportedAt).toBe('2026-02-16T12:00:00Z');
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].email).toBe('luke@example.com');
    expect(result.settings).toEqual({ theme: 'dark' });
  });

  it('throws on missing version', () => {
    const json = JSON.stringify({ accounts: [] });
    expect(() => parseBackupManifest(json)).toThrow('missing version');
  });

  it('throws on missing accounts array', () => {
    const json = JSON.stringify({ version: 2 });
    expect(() => parseBackupManifest(json)).toThrow('missing accounts array');
  });

  it('returns settings when present', () => {
    const json = JSON.stringify({
      version: 2,
      accounts: [],
      settings: { theme: 'light', settings: '{}' },
    });
    const result = parseBackupManifest(json);
    expect(result.settings).toEqual({ theme: 'light', settings: '{}' });
  });

  it('returns null settings when absent', () => {
    const json = JSON.stringify({ version: 2, accounts: [] });
    const result = parseBackupManifest(json);
    expect(result.settings).toBeNull();
  });
});
