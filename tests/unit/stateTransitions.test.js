import { describe, it, expect } from 'vitest';
import { computeDisplayEmails } from '../../src/services/emailListUtils.js';

// ---------------------------------------------------------------------------
// Fixtures — simulate the store state at each step of user workflows
// ---------------------------------------------------------------------------
const mkEmail = (uid, subject, date) => ({
  uid,
  subject,
  date: date || '2026-02-10T12:00:00Z',
  from: { address: 'luke@forceunwrap.com' },
  flags: ['\\Seen'],
});

// ---------------------------------------------------------------------------
// Archive → Delete from server → local-only transition
// ---------------------------------------------------------------------------
describe('archive → delete from server → local-only', () => {
  const uid = 42;
  const email = mkEmail(uid, 'Important email');

  // Step 1: Email is on server, not archived
  const step1_serverOnly = {
    searchActive: false,
    searchResults: [],
    emails: [email, mkEmail(100, 'Other')],
    localEmails: [],
    archivedEmailIds: new Set(),
    viewMode: 'all',
  };

  // Step 2: Email is archived (exists in localEmails + archivedEmailIds)
  const step2_archived = {
    ...step1_serverOnly,
    localEmails: [email],
    archivedEmailIds: new Set([uid]),
  };

  // Step 3: Email deleted from server (removed from emails array)
  const step3_deletedFromServer = {
    ...step2_archived,
    emails: step2_archived.emails.filter((e) => e.uid !== uid),
  };

  it('Step 1: email shows as "server" before archiving', () => {
    const result = computeDisplayEmails(step1_serverOnly);
    const found = result.find((e) => e.uid === uid);
    expect(found).toBeDefined();
    expect(found.source).toBe('server');
    expect(found.isArchived).toBe(false);
  });

  it('Step 2: email shows as "server" with isArchived after archiving', () => {
    const result = computeDisplayEmails(step2_archived);
    const found = result.find((e) => e.uid === uid);
    expect(found).toBeDefined();
    expect(found.source).toBe('server');
    expect(found.isArchived).toBe(true);
  });

  it('Step 3: email shows as "local-only" after deletion from server', () => {
    const result = computeDisplayEmails(step3_deletedFromServer);
    const found = result.find((e) => e.uid === uid);
    expect(found).toBeDefined();
    expect(found.source).toBe('local-only');
    expect(found.isArchived).toBe(true);
  });

  it('Step 3: other emails still show as "server"', () => {
    const result = computeDisplayEmails(step3_deletedFromServer);
    const other = result.find((e) => e.uid === 100);
    expect(other).toBeDefined();
    expect(other.source).toBe('server');
  });

  it('Step 3 in local view: email shows as "local-only"', () => {
    const result = computeDisplayEmails({ ...step3_deletedFromServer, viewMode: 'local' });
    const found = result.find((e) => e.uid === uid);
    expect(found).toBeDefined();
    expect(found.source).toBe('local-only');
  });

  it('Step 3 in server view: deleted email is NOT shown', () => {
    const result = computeDisplayEmails({ ...step3_deletedFromServer, viewMode: 'server' });
    const found = result.find((e) => e.uid === uid);
    expect(found).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cache restoration after delete — simulates loadEmails restoring from cache
// ---------------------------------------------------------------------------
describe('cache restoration should not undo local-only status', () => {
  it('after delete + cache update, email stays local-only', () => {
    const uid = 42;
    const email = mkEmail(uid, 'Archived email');

    // State after delete: email removed from emails, still in localEmails
    const afterDelete = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [mkEmail(100, 'Other')], // uid 42 removed
      localEmails: [email],
      archivedEmailIds: new Set([uid]),
      viewMode: 'all',
    });
    expect(afterDelete.find((e) => e.uid === uid).source).toBe('local-only');

    // If cache were NOT updated, loadEmails would restore uid 42 to emails:
    const withStaleCacheRestored = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [email, mkEmail(100, 'Other')], // uid 42 restored from stale cache
      localEmails: [email],
      archivedEmailIds: new Set([uid]),
      viewMode: 'all',
    });
    // This would incorrectly show as "server" — the bug we fixed
    expect(withStaleCacheRestored.find((e) => e.uid === uid).source).toBe('server');

    // With correct cache update, loadEmails uses filtered cache (uid 42 removed):
    const withUpdatedCache = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [mkEmail(100, 'Other')], // uid 42 NOT restored (cache was updated)
      localEmails: [email],
      archivedEmailIds: new Set([uid]),
      viewMode: 'all',
    });
    expect(withUpdatedCache.find((e) => e.uid === uid).source).toBe('local-only');
  });
});

// ---------------------------------------------------------------------------
// Non-archived cached emails should NOT appear as local-only
// ---------------------------------------------------------------------------
describe('auto-cached (non-archived) emails', () => {
  it('do not appear in all view when deleted from server', () => {
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [], // server empty
      localEmails: [mkEmail(1, 'Auto-cached, not archived')],
      archivedEmailIds: new Set(), // NOT archived
      viewMode: 'all',
    });
    expect(result).toHaveLength(0);
  });

  it('do not appear in local view', () => {
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [mkEmail(1, 'On server')],
      localEmails: [mkEmail(1, 'Cached'), mkEmail(2, 'Also cached')],
      archivedEmailIds: new Set(), // neither archived
      viewMode: 'local',
    });
    expect(result).toHaveLength(0);
  });

  it('archived emails appear, non-archived do not in local view', () => {
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [mkEmail(1, 'On server'), mkEmail(2, 'On server')],
      localEmails: [mkEmail(1, 'Archived'), mkEmail(2, 'Just cached')],
      archivedEmailIds: new Set([1]), // only uid 1 archived
      viewMode: 'local',
    });
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe(1);
    expect(result[0].isArchived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Quick-load state — UI renders with cached data before keychain
// ---------------------------------------------------------------------------
describe('quick-load state (before keychain)', () => {
  it('cached headers produce valid display emails in all mode', () => {
    // Simulates quick-load: accounts loaded from accounts.json, cached headers available
    const cachedEmails = [
      mkEmail(1, 'Cached A', '2026-02-15T10:00:00Z'),
      mkEmail(2, 'Cached B', '2026-02-14T10:00:00Z'),
      mkEmail(3, 'Cached C', '2026-02-13T10:00:00Z'),
    ];
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: cachedEmails,
      localEmails: [],
      archivedEmailIds: new Set(),
      viewMode: 'all',
    });
    expect(result).toHaveLength(3);
    expect(result.every((e) => e.source === 'server')).toBe(true);
    // Sorted by date descending
    expect(result[0].uid).toBe(1);
    expect(result[2].uid).toBe(3);
  });

  it('local emails available during quick-load', () => {
    // Quick-load populates localEmails from Maildir (no keychain needed)
    const localEmails = [mkEmail(10, 'Local A'), mkEmail(20, 'Local B')];
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [], // server not loaded yet
      localEmails,
      archivedEmailIds: new Set([10, 20]),
      viewMode: 'local',
    });
    expect(result).toHaveLength(2);
    // When server emails is empty, don't flag as local-only (can't distinguish)
    expect(result.every((e) => e.source === 'local')).toBe(true);
  });

  it('empty state before quick-load completes', () => {
    const result = computeDisplayEmails({
      searchActive: false,
      searchResults: [],
      emails: [],
      localEmails: [],
      archivedEmailIds: new Set(),
      viewMode: 'all',
    });
    expect(result).toEqual([]);
  });
});
