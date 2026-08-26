import { describe, it, expect } from 'vitest';
import { deriveDisplayRows } from '../../src/stores/slices/messageListSlice.js';
import { serverUids } from '../../src/stores/slices/serverUids.js';

// The production derivation, imported directly. This file used to call
// `services/emailListUtils.js`, a test-only reimplementation of it that had
// quietly drifted: it stamped `local-only` off a uid set it derived from
// `emails` and assumed complete, so these assertions could pass while the real
// store could not reach that state at all. That file is gone; there is one
// derivation now.
//
// `display()` is a fixture, not a second implementation — it only supplies the
// inputs the old signature left implicit. When a case passes no uid set, it
// means "the emails I passed ARE the whole server", and now says so.
function display({ emails = [], localEmails = [], archivedEmailIds = new Set(), viewMode = 'all', savedEmailIds = new Set(), serverUidSet, serverUidsKnown, ...rest }) {
  return deriveDisplayRows({
    emails, localEmails, archivedEmailIds, viewMode, savedEmailIds, ...rest,
    serverUids: serverUidSet
      ? serverUids(serverUidSet, { complete: !!serverUidsKnown })
      : serverUids(emails.map(e => e.uid), { complete: true }),
  });
}


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

  // Step 3: Email deleted from server. Two things change, and BOTH are what
  // applyServerRemoval does: the row leaves the server array, and the vault
  // entry is stamped `serverDeleted`. The stamp is the part that makes the row
  // gold — "absent from the mailbox's uid set" never did, because that set
  // enumerates one mailbox and a message can leave INBOX and live.
  const step3_deletedFromServer = {
    ...step2_archived,
    emails: step2_archived.emails.filter((e) => e.uid !== uid),
    localEmails: [{ ...email, serverDeleted: true }],
  };

  it('Step 1: email shows as "server" before archiving', () => {
    const result = display(step1_serverOnly);
    const found = result.find((e) => e.uid === uid);
    expect(found).toBeDefined();
    expect(found.source).toBe('server');
    expect(found.isArchived).toBe(false);
  });

  it('Step 2: email shows as "server" with isArchived after archiving', () => {
    const result = display(step2_archived);
    const found = result.find((e) => e.uid === uid);
    expect(found).toBeDefined();
    expect(found.source).toBe('server');
    expect(found.isArchived).toBe(true);
  });

  it('Step 3: email shows as "local-only" after deletion from server', () => {
    const result = display(step3_deletedFromServer);
    const found = result.find((e) => e.uid === uid);
    expect(found).toBeDefined();
    expect(found.source).toBe('local-only');
    expect(found.isArchived).toBe(true);
  });

  it('Step 3: other emails still show as "server"', () => {
    const result = display(step3_deletedFromServer);
    const other = result.find((e) => e.uid === 100);
    expect(other).toBeDefined();
    expect(other.source).toBe('server');
  });

  it('Step 3 in local view: email shows as "local-only"', () => {
    const result = display({ ...step3_deletedFromServer, viewMode: 'local' });
    const found = result.find((e) => e.uid === uid);
    expect(found).toBeDefined();
    expect(found.source).toBe('local-only');
  });

  it('Step 3 in server view: deleted email is NOT shown', () => {
    const result = display({ ...step3_deletedFromServer, viewMode: 'server' });
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

    // State after delete: email removed from emails, still in localEmails,
    // and its vault entry stamped by applyServerRemoval.
    const afterDelete = display({
      searchActive: false,
      searchResults: [],
      emails: [mkEmail(100, 'Other')], // uid 42 removed
      localEmails: [{ ...email, serverDeleted: true }],
      archivedEmailIds: new Set([uid]),
      viewMode: 'all',
    });
    expect(afterDelete.find((e) => e.uid === uid).source).toBe('local-only');

    // If cache were NOT updated, loadEmails would restore uid 42 to emails:
    const withStaleCacheRestored = display({
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
    const withUpdatedCache = display({
      searchActive: false,
      searchResults: [],
      emails: [mkEmail(100, 'Other')], // uid 42 NOT restored (cache was updated)
      localEmails: [{ ...email, serverDeleted: true }],
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
    const result = display({
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
    const result = display({
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
    const result = display({
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
    const result = display({
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
    const result = display({
      searchActive: false,
      searchResults: [],
      emails: [], // server not loaded yet
      localEmails,
      archivedEmailIds: new Set([10, 20]),
      viewMode: 'local',
      serverUidSet: new Set(),
      serverUidsKnown: false,
    });
    expect(result).toHaveLength(2);
    // Server set is unverified — never flag local-only without proof.
    expect(result.every((e) => e.source === 'local')).toBe(true);
  });

  it('empty state before quick-load completes', () => {
    const result = display({
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
