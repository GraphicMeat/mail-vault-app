import { describe, it, expect } from 'vitest';
import { computeDisplayEmails } from '../../src/services/emailListUtils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const serverEmail = (uid, subject, date) => ({
  uid,
  subject,
  date: date || '2026-02-10T12:00:00Z',
  from: { address: 'luke@forceunwrap.com' },
  flags: ['\\Seen'],
});

const localEmail = (uid, subject, date) => ({
  uid,
  subject,
  date: date || '2026-02-10T12:00:00Z',
  from: { address: 'luke@forceunwrap.com' },
  flags: ['\\Seen'],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('computeDisplayEmails', () => {
  // -----------------------------------------------------------------------
  // Search mode
  // -----------------------------------------------------------------------
  it('returns searchResults when searchActive is true', () => {
    const searchResults = [{ uid: 1, subject: 'found' }];
    const result = computeDisplayEmails({
      searchActive: true,
      searchResults,
      emails: [serverEmail(99, 'ignored')],
      localEmails: [],
      archivedEmailIds: new Set(),
      viewMode: 'all',
    });
    expect(result).toBe(searchResults);
  });

  // -----------------------------------------------------------------------
  // Server mode
  // -----------------------------------------------------------------------
  describe('viewMode: server', () => {
    it('returns server emails with source "server"', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'A'), serverEmail(2, 'B')],
        localEmails: [localEmail(1, 'A')],
        archivedEmailIds: new Set([1]),
        viewMode: 'server',
      });
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.source === 'server')).toBe(true);
    });

    it('marks archived emails correctly', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'Archived'), serverEmail(2, 'Not archived')],
        localEmails: [],
        archivedEmailIds: new Set([1]),
        viewMode: 'server',
      });
      expect(result.find((e) => e.uid === 1).isArchived).toBe(true);
      expect(result.find((e) => e.uid === 2).isArchived).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Local mode
  // -----------------------------------------------------------------------
  describe('viewMode: local', () => {
    it('returns local emails with source "local" when server emails contain matching UIDs', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'A'), serverEmail(2, 'B')],
        localEmails: [localEmail(1, 'A'), localEmail(2, 'B')],
        archivedEmailIds: new Set([1, 2]),
        viewMode: 'local',
      });
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.source === 'local')).toBe(true);
      expect(result.every((e) => e.isArchived === true)).toBe(true);
    });

    it('flags local emails as "local-only" when their UID is NOT on the server', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'Still on server')],
        localEmails: [localEmail(1, 'Still on server'), localEmail(99, 'Deleted from server')],
        archivedEmailIds: new Set([1, 99]),
        viewMode: 'local',
      });
      expect(result).toHaveLength(2);
      expect(result.find((e) => e.uid === 1).source).toBe('local');
      expect(result.find((e) => e.uid === 99).source).toBe('local-only');
    });

    it('does NOT flag local emails as "local-only" when server emails are empty (not loaded yet)', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [],
        localEmails: [localEmail(1, 'A'), localEmail(2, 'B')],
        archivedEmailIds: new Set([1, 2]),
        viewMode: 'local',
      });
      // Server list is empty — we can't distinguish, so default to "local"
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.source === 'local')).toBe(true);
    });

    it('excludes non-archived local emails from local view', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'On server')],
        localEmails: [localEmail(1, 'Archived'), localEmail(50, 'Just cached, not archived')],
        archivedEmailIds: new Set([1]),
        viewMode: 'local',
      });
      // Only archived email (uid 1) is shown; uid 50 is just cached
      expect(result).toHaveLength(1);
      expect(result[0].uid).toBe(1);
    });

    it('flags ALL local emails as "local-only" when none match server UIDs', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(100, 'Different email')],
        localEmails: [localEmail(1, 'Deleted A'), localEmail(2, 'Deleted B')],
        archivedEmailIds: new Set([1, 2]),
        viewMode: 'local',
      });
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.source === 'local-only')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // All mode
  // -----------------------------------------------------------------------
  describe('viewMode: all', () => {
    it('combines server and local-only emails', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'On server')],
        localEmails: [localEmail(1, 'On server'), localEmail(99, 'Deleted from server')],
        archivedEmailIds: new Set([1, 99]),
        viewMode: 'all',
      });
      // Server email (uid 1) + local-only (uid 99)
      expect(result).toHaveLength(2);
      expect(result.find((e) => e.uid === 1).source).toBe('server');
      expect(result.find((e) => e.uid === 1).isArchived).toBe(true);
      expect(result.find((e) => e.uid === 99).source).toBe('local-only');
      expect(result.find((e) => e.uid === 99).isArchived).toBe(true);
    });

    it('does not show non-archived local emails as local-only', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'On server')],
        localEmails: [localEmail(1, 'On server'), localEmail(99, 'Just cached, not archived')],
        archivedEmailIds: new Set([1]),
        viewMode: 'all',
      });
      // Only server email (uid 1); uid 99 is cached but not archived, so not shown
      expect(result).toHaveLength(1);
      expect(result[0].uid).toBe(1);
      expect(result[0].source).toBe('server');
    });

    it('does not duplicate emails that exist on both server and local', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'A'), serverEmail(2, 'B')],
        localEmails: [localEmail(1, 'A'), localEmail(2, 'B')],
        archivedEmailIds: new Set([1, 2]),
        viewMode: 'all',
      });
      // Only 2 emails, not 4
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.source === 'server')).toBe(true);
    });

    it('sorts combined results by date descending', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'Old', '2026-01-01T00:00:00Z')],
        localEmails: [localEmail(99, 'New', '2026-02-15T00:00:00Z')],
        archivedEmailIds: new Set([99]),
        viewMode: 'all',
      });
      expect(result[0].uid).toBe(99); // Newer first
      expect(result[1].uid).toBe(1);
    });

    it('marks server emails as not archived when they have no local copy', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'Server only')],
        localEmails: [],
        archivedEmailIds: new Set(),
        viewMode: 'all',
      });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('server');
      expect(result[0].isArchived).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty emails and localEmails', () => {
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

    it('handles local view with no server data and no local data', () => {
      const result = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: [],
        localEmails: [],
        archivedEmailIds: new Set(),
        viewMode: 'local',
      });
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Delete from server → local-only transition
  // -----------------------------------------------------------------------
  describe('delete from server triggers local-only', () => {
    it('email becomes "local-only" after being removed from server emails array (all mode)', () => {
      const archived = localEmail(5, 'Archived email');
      const serverEmails = [serverEmail(5, 'Archived email'), serverEmail(10, 'Other')];

      // Before delete: email 5 is on server → source "server"
      const before = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: serverEmails,
        localEmails: [archived],
        archivedEmailIds: new Set([5]),
        viewMode: 'all',
      });
      expect(before.find((e) => e.uid === 5).source).toBe('server');

      // After delete: email 5 removed from server array → source "local-only"
      const after = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: serverEmails.filter((e) => e.uid !== 5),
        localEmails: [archived],
        archivedEmailIds: new Set([5]),
        viewMode: 'all',
      });
      expect(after.find((e) => e.uid === 5).source).toBe('local-only');
      expect(after.find((e) => e.uid === 5).isArchived).toBe(true);
    });

    it('email becomes "local-only" after being removed from server emails array (local mode)', () => {
      const archived = localEmail(5, 'Archived email');
      const serverEmails = [serverEmail(5, 'Archived email'), serverEmail(10, 'Other')];

      // Before delete: email 5 is on server → source "local"
      const before = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: serverEmails,
        localEmails: [archived],
        archivedEmailIds: new Set([5]),
        viewMode: 'local',
      });
      expect(before.find((e) => e.uid === 5).source).toBe('local');

      // After delete: email 5 removed from server array → source "local-only"
      const after = computeDisplayEmails({
        searchActive: false,
        searchResults: [],
        emails: serverEmails.filter((e) => e.uid !== 5),
        localEmails: [archived],
        archivedEmailIds: new Set([5]),
        viewMode: 'local',
      });
      expect(after.find((e) => e.uid === 5).source).toBe('local-only');
    });

    it('view mode switch produces correct results without stale data', () => {
      const emails = [serverEmail(1, 'A'), serverEmail(2, 'B')];
      const locals = [localEmail(1, 'A'), localEmail(99, 'Deleted')];
      const archived = new Set([1, 99]);

      // In "server" mode: only server emails, no local-only
      const serverView = computeDisplayEmails({
        searchActive: false, searchResults: [], emails, localEmails: locals,
        archivedEmailIds: archived, viewMode: 'server',
      });
      expect(serverView).toHaveLength(2);
      expect(serverView.every((e) => e.source === 'server')).toBe(true);

      // Switch to "local" mode: local-only flag should appear for uid 99
      const localView = computeDisplayEmails({
        searchActive: false, searchResults: [], emails, localEmails: locals,
        archivedEmailIds: archived, viewMode: 'local',
      });
      expect(localView).toHaveLength(2);
      expect(localView.find((e) => e.uid === 99).source).toBe('local-only');
      expect(localView.find((e) => e.uid === 1).source).toBe('local');

      // Switch to "all" mode: uid 99 should be local-only
      const allView = computeDisplayEmails({
        searchActive: false, searchResults: [], emails, localEmails: locals,
        archivedEmailIds: archived, viewMode: 'all',
      });
      expect(allView.find((e) => e.uid === 99).source).toBe('local-only');
      expect(allView.find((e) => e.uid === 1).source).toBe('server');
    });
  });
});
