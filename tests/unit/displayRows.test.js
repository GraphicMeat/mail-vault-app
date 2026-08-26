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

// A vault copy whose server copy this app deleted — `applyServerRemoval` writes
// `serverDeleted` onto the local-index entry and `db.getArchivedEmails` reads it
// back onto the row. This, not "absent from the uid set", is what makes a row
// local-only: a uid set enumerates ONE mailbox, and a message that left INBOX
// for All Mail, a label or the Bin is still on the server.
const deletedFromServer = (uid, subject, date) => ({ ...localEmail(uid, subject, date), serverDeleted: true });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('deriveDisplayRows', () => {
  // The search short-circuit the deleted twin carried (`searchActive` →
  // return searchResults) is not part of this derivation and never was in the
  // app: EmailList.jsx:357 picks between searchResults and sortedEmails.
  // Asserting it here only ever tested the twin.

  // -----------------------------------------------------------------------
  // \Deleted (flagged but not yet expunged)
  // -----------------------------------------------------------------------
  describe('\\Deleted messages', () => {
    it('hides server messages flagged \\Deleted', () => {
      const doomed = { ...serverEmail(2, 'deleted'), flags: ['\\Seen', '\\Deleted'] };
      const result = display({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'kept'), doomed],
        localEmails: [],
        archivedEmailIds: new Set(),
        viewMode: 'all',
      });
      expect(result.map(e => e.uid)).toEqual([1]);
    });

    it('keeps a \\Deleted message that is archived locally', () => {
      const doomed = { ...serverEmail(2, 'deleted but vaulted'), flags: ['\\Deleted'] };
      const result = display({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'kept'), doomed],
        localEmails: [],
        archivedEmailIds: new Set([2]),
        viewMode: 'all',
      });
      expect(result.map(e => e.uid).sort()).toEqual([1, 2]);
    });
  });

  // -----------------------------------------------------------------------
  // Server mode
  // -----------------------------------------------------------------------
  describe('viewMode: server', () => {
    it('returns server emails with source "server"', () => {
      const result = display({
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

    // DRIFT, found by deleting the twin. The twin set `isArchived` from
    // `archivedEmailIds` here and this case asserted `true`; the store has
    // always hard-set `isArchived = false` for every row in server view, so
    // the app never behaved the way this assertion claimed. Pinned to what
    // production does, not to what the twin did.
    //
    // Whether server view SHOULD surface the archived badge is a product
    // question, not a test question — it is the one view whose contract is
    // "show the server's copy", and answering it means touching the row icons
    // and their visual baselines. Left as it ships.
    it('flattens isArchived to false in server view, whatever the vault holds', () => {
      const result = display({
        emails: [serverEmail(1, 'Archived here'), serverEmail(2, 'Not archived')],
        localEmails: [],
        archivedEmailIds: new Set([1]),
        viewMode: 'server',
      });
      expect(result.find((e) => e.uid === 1).isArchived).toBe(false);
      expect(result.find((e) => e.uid === 2).isArchived).toBe(false);
      expect(result.every((e) => e.source === 'server')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Local mode
  // -----------------------------------------------------------------------
  describe('viewMode: local', () => {
    it('returns local emails with source "local" when server emails contain matching UIDs', () => {
      const result = display({
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

    it('flags local emails as "local-only" when this app deleted the server copy', () => {
      const result = display({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'Still on server')],
        localEmails: [localEmail(1, 'Still on server'), deletedFromServer(99, 'Deleted from server')],
        archivedEmailIds: new Set([1, 99]),
        viewMode: 'local',
      });
      expect(result).toHaveLength(2);
      expect(result.find((e) => e.uid === 1).source).toBe('local');
      expect(result.find((e) => e.uid === 99).source).toBe('local-only');
    });

    it('does NOT flag a vault row local-only merely for missing from the mailbox', () => {
      // The false-gold regression: a complete UID SEARCH covers one mailbox.
      const result = display({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'Still in INBOX')],
        localEmails: [localEmail(1, 'Still in INBOX'), localEmail(99, 'Archived into All Mail')],
        archivedEmailIds: new Set([1, 99]),
        viewMode: 'local',
      });
      expect(result.find((e) => e.uid === 99).source).toBe('local');
    });

    it('does NOT flag local emails as "local-only" when server emails are empty (not loaded yet)', () => {
      const result = display({
        searchActive: false,
        searchResults: [],
        emails: [],
        localEmails: [localEmail(1, 'A'), localEmail(2, 'B')],
        archivedEmailIds: new Set([1, 2]),
        viewMode: 'local',
        serverUidSet: new Set(),
        serverUidsKnown: false,
      });
      // Server set is empty and unverified — never claim "local-only" without proof.
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.source === 'local')).toBe(true);
    });

    it('excludes non-archived local emails from local view', () => {
      const result = display({
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

    it('flags ALL local emails as "local-only" when every server copy was deleted here', () => {
      const result = display({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(100, 'Different email')],
        localEmails: [deletedFromServer(1, 'Deleted A'), deletedFromServer(2, 'Deleted B')],
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
      const result = display({
        searchActive: false,
        searchResults: [],
        emails: [serverEmail(1, 'On server')],
        localEmails: [localEmail(1, 'On server'), deletedFromServer(99, 'Deleted from server')],
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
      const result = display({
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
      const result = display({
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
      const result = display({
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
      const result = display({
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

    it('handles local view with no server data and no local data', () => {
      const result = display({
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
    it('email becomes "local-only" after the delete stamps the vault copy (all mode)', () => {
      const archived = localEmail(5, 'Archived email');
      const serverEmails = [serverEmail(5, 'Archived email'), serverEmail(10, 'Other')];

      // Before delete: email 5 is on server → source "server"
      const before = display({
        searchActive: false,
        searchResults: [],
        emails: serverEmails,
        localEmails: [archived],
        archivedEmailIds: new Set([5]),
        viewMode: 'all',
      });
      expect(before.find((e) => e.uid === 5).source).toBe('server');

      // After delete: the row leaves the server array AND the vault entry is
      // stamped — both halves of what applyServerRemoval does.
      const after = display({
        searchActive: false,
        searchResults: [],
        emails: serverEmails.filter((e) => e.uid !== 5),
        localEmails: [deletedFromServer(5, 'Archived email')],
        archivedEmailIds: new Set([5]),
        viewMode: 'all',
      });
      expect(after.find((e) => e.uid === 5).source).toBe('local-only');
      expect(after.find((e) => e.uid === 5).isArchived).toBe(true);
    });

    it('email becomes "local-only" after the delete stamps the vault copy (local mode)', () => {
      const archived = localEmail(5, 'Archived email');
      const serverEmails = [serverEmail(5, 'Archived email'), serverEmail(10, 'Other')];

      // Before delete: email 5 is on server → source "local"
      const before = display({
        searchActive: false,
        searchResults: [],
        emails: serverEmails,
        localEmails: [archived],
        archivedEmailIds: new Set([5]),
        viewMode: 'local',
      });
      expect(before.find((e) => e.uid === 5).source).toBe('local');

      // After delete: removed from the server array AND stamped on disk.
      const after = display({
        searchActive: false,
        searchResults: [],
        emails: serverEmails.filter((e) => e.uid !== 5),
        localEmails: [deletedFromServer(5, 'Archived email')],
        archivedEmailIds: new Set([5]),
        viewMode: 'local',
      });
      expect(after.find((e) => e.uid === 5).source).toBe('local-only');
    });

    it('view mode switch produces correct results without stale data', () => {
      const emails = [serverEmail(1, 'A'), serverEmail(2, 'B')];
      const locals = [localEmail(1, 'A'), deletedFromServer(99, 'Deleted')];
      const archived = new Set([1, 99]);

      // In "server" mode: only server emails, no local-only
      const serverView = display({
        searchActive: false, searchResults: [], emails, localEmails: locals,
        archivedEmailIds: archived, viewMode: 'server',
      });
      expect(serverView).toHaveLength(2);
      expect(serverView.every((e) => e.source === 'server')).toBe(true);

      // Switch to "local" mode: local-only flag should appear for uid 99
      const localView = display({
        searchActive: false, searchResults: [], emails, localEmails: locals,
        archivedEmailIds: archived, viewMode: 'local',
      });
      expect(localView).toHaveLength(2);
      expect(localView.find((e) => e.uid === 99).source).toBe('local-only');
      expect(localView.find((e) => e.uid === 1).source).toBe('local');

      // Switch to "all" mode: uid 99 should be local-only
      const allView = display({
        searchActive: false, searchResults: [], emails, localEmails: locals,
        archivedEmailIds: archived, viewMode: 'all',
      });
      expect(allView.find((e) => e.uid === 99).source).toBe('local-only');
      expect(allView.find((e) => e.uid === 1).source).toBe('server');
    });
  });
});
