import { describe, it, expect } from 'vitest';
import { vaultClause, describeServerDelete, describeDeleteEverywhere } from '../custodyCopy';

// The bug this replaced: every "Delete from server" confirmation said "This
// cannot be undone", whether or not a vault copy existed. These assertions
// are about the claim, not the wording — the only thing that must never
// regress is saying "permanent" when a copy survives, or the reverse.

describe('vaultClause', () => {
  it('calls a delete permanent only when nothing is in the vault', () => {
    expect(vaultClause(1, 0)).toMatch(/cannot be undone/);
    expect(vaultClause(9, 0)).toMatch(/cannot be undone/);
  });

  it('never calls it permanent when every message has a vault copy', () => {
    expect(vaultClause(1, 1)).not.toMatch(/cannot be undone/i);
    expect(vaultClause(9, 9)).not.toMatch(/cannot be undone/i);
  });

  it('promises the copy can go back on the server when the vault holds it', () => {
    expect(vaultClause(1, 1)).toMatch(/put it back on the server/);
    expect(vaultClause(4, 4)).toMatch(/put them back on the server/);
  });

  it('names both counts on a mixed selection so neither half is implied safe', () => {
    const s = vaultClause(10, 4);
    expect(s).toContain('4');
    expect(s).toContain('6');
    expect(s).toMatch(/only on the server/);
  });

  it('agrees in number on a mixed selection with one exposed message', () => {
    expect(vaultClause(5, 4)).toMatch(/1 exists only on the server/);
    expect(vaultClause(5, 3)).toMatch(/2 exist only on the server/);
  });

  it('treats an over-count as full custody rather than falling into the mixed branch', () => {
    // Callers derive inVault and total from two different traversals; if they
    // ever disagree, "your vault keeps the copies" is the safe reading and a
    // negative remainder is not a sentence.
    expect(vaultClause(3, 4)).toMatch(/put them back on the server/);
  });
});

describe('describeServerDelete', () => {
  it('leads with the action and count, then the custody clause', () => {
    expect(describeServerDelete(1, 0)).toBe(
      'This email leaves the server. No copy is in your vault, so this cannot be undone.',
    );
    expect(describeServerDelete(2, 2)).toMatch(/^These 2 emails leave the server\./);
  });

  it('groups thousands so a bulk run reads as a number', () => {
    expect(describeServerDelete(1200, 0)).toContain('1,200');
  });
});

describe('describeDeleteEverywhere', () => {
  it('names all three places and is always permanent', () => {
    for (const n of [1, 7]) {
      const s = describeDeleteEverywhere(n);
      expect(s).toContain('the server');
      expect(s).toContain('your vault');
      expect(s).toContain('your backup drive');
      expect(s).toMatch(/cannot be undone/);
    }
  });
});
