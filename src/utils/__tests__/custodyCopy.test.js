import { describe, it, expect } from 'vitest';
import { vaultClause, describeServerDelete, describePurge } from '../custodyCopy';

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


// The purge item names the places it will actually clear, and is offered only
// where at least one of them is a copy of our own. A "Delete everywhere" on a
// message the vault has never held offers to destroy something that is not
// there — and does, verbatim, what the Delete from server above it does.
describe('describePurge', () => {
  const scope = (s, v, b) => ({ server: s, vault: v, backup: b });

  it('is not offered when only the server holds the message', () => {
    expect(describePurge(scope(true, false, false), 1)).toBeNull();
    expect(describePurge({}, 1)).toBeNull();
  });

  it('names exactly the places that hold it', () => {
    expect(describePurge(scope(false, true, false), 1).label).toBe('Delete from vault');
    expect(describePurge(scope(false, true, true), 1).label).toBe('Delete from vault & backup');
    expect(describePurge(scope(false, false, true), 1).label).toBe('Delete from backup');
    expect(describePurge(scope(true, true, false), 1).label).toBe('Delete from server and vault');
    expect(describePurge(scope(true, false, true), 1).label).toBe('Delete from server and backup');
    expect(describePurge(scope(true, true, true), 1).label).toBe('Delete from server, vault and backup');
  });

  it('never names a place that does not hold it', () => {
    expect(describePurge(scope(false, true, false), 1).label).not.toMatch(/server|backup/i);
    expect(describePurge(scope(true, true, false), 1).label).not.toMatch(/backup/i);
  });

  it('warns that nothing survives, whatever the scope', () => {
    for (const sc of [scope(false, true, false), scope(true, true, true), scope(false, false, true)]) {
      expect(describePurge(sc, 1).description).toMatch(/cannot be undone/);
    }
  });

  it('agrees in number with the set it acts on', () => {
    expect(describePurge(scope(true, true, false), 1).description).toMatch(/^This email will be gone\./);
    expect(describePurge(scope(true, true, false), 4).description).toMatch(/^These 4 emails will be gone\./);
  });

  it('asks one question for every scope, since the button already names the places', () => {
    expect(describePurge(scope(false, true, false), 1).title).toBe('Delete permanently?');
    expect(describePurge(scope(true, true, true), 9).title).toBe('Delete permanently?');
  });
});
