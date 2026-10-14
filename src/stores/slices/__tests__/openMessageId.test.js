/**
 * `selectedEmailId` names the OPEN message — a different thing from
 * `selectedEmailIds`, the ticked set. It had two contradictory readers:
 * EmailList highlighted the row by comparing it to a selection KEY, while
 * App.jsx's j/k navigation compared it to a bare `e.uid`. In a list spanning
 * mailboxes the second can never match, so next/previous did nothing at all.
 *
 * One contract: it is whatever `rowKey` produces for the row it names.
 */
import { describe, it, expect } from 'vitest';
import { rowKey, stepThroughList, _selKey } from '../unifiedHelpers';

const row = (uid, mailbox = 'INBOX', accountId = 'acct-1') =>
  ({ uid, _accountId: accountId, _mailbox: mailbox, subject: `m${uid}` });

describe('rowKey', () => {
  it('is the bare uid in a single-folder list, where a uid is enough', () => {
    expect(rowKey(row(34), false)).toBe(34);
  });

  it('is the full key once the list spans mailboxes', () => {
    expect(rowKey(row(34), true)).toBe(_selKey(row(34)));
  });

  it('tells two folders apart when the list spans them', () => {
    expect(rowKey(row(34, 'INBOX'), true)).not.toBe(rowKey(row(34, 'Sent'), true));
  });
});

describe('stepThroughList', () => {
  const flat = [row(10), row(11), row(12)];

  it('moves to the next row in a single-folder list', () => {
    expect(stepThroughList(flat, 11, false, +1).uid).toBe(12);
  });

  it('moves to the previous row', () => {
    expect(stepThroughList(flat, 11, false, -1).uid).toBe(10);
  });

  it('stops at the last row rather than wrapping', () => {
    expect(stepThroughList(flat, 12, false, +1).uid).toBe(12);
  });

  it('stops at the first row rather than wrapping', () => {
    expect(stepThroughList(flat, 10, false, -1).uid).toBe(10);
  });

  it('steps from the right row when two folders share a uid', () => {
    // The whole bug: with a bare-uid comparison this finds the INBOX copy and
    // steps from there, or finds nothing and never moves.
    const spanning = [row(34, 'INBOX'), row(99, 'INBOX'), row(34, 'Sent'), row(77, 'Sent')];
    const openInSent = _selKey(row(34, 'Sent'));

    const next = stepThroughList(spanning, openInSent, true, +1);
    expect(next.uid).toBe(77);
    expect(next._mailbox).toBe('Sent');
  });

  it('starts at the top when the open message is not on screen', () => {
    expect(stepThroughList(flat, 999, false, +1).uid).toBe(10);
    expect(stepThroughList(flat, 999, false, -1).uid).toBe(10);
  });

  // The open message can leave the list while it stays in the reader: the
  // view builder adds a word with "hide view mail" on. j and k then carry on
  // from where it would sit by date, not from the newest row.
  describe('an open message the list no longer shows', () => {
    const dated = (uid, date) => ({ ...row(uid), date });
    // Newest first, as the list sorts.
    const list = [dated(30, '2026-10-03T12:00:00Z'), dated(20, '2026-10-02T12:00:00Z'), dated(10, '2026-10-01T12:00:00Z')];

    it('j steps to the next older row from where it sat', () => {
      expect(stepThroughList(list, 15, false, +1, dated(15, '2026-10-01T18:00:00Z')).uid).toBe(10);
    });

    it('k steps to the next newer row from where it sat', () => {
      expect(stepThroughList(list, 15, false, -1, dated(15, '2026-10-01T18:00:00Z')).uid).toBe(20);
    });

    it('stays inside the list past either end', () => {
      expect(stepThroughList(list, 5, false, +1, dated(5, '2026-09-01T00:00:00Z')).uid).toBe(10);
      expect(stepThroughList(list, 5, false, -1, dated(5, '2026-09-01T00:00:00Z')).uid).toBe(10);
      expect(stepThroughList(list, 50, false, +1, dated(50, '2026-11-01T00:00:00Z')).uid).toBe(30);
      expect(stepThroughList(list, 50, false, -1, dated(50, '2026-11-01T00:00:00Z')).uid).toBe(30);
    });

    it('reads the time the list sorts by (internalDate when there is no date)', () => {
      const open = { ...row(15), internalDate: '2026-10-01T18:00:00Z' };
      expect(stepThroughList(list, 15, false, +1, open).uid).toBe(10);
      expect(stepThroughList(list, 15, false, -1, open).uid).toBe(20);
    });

    it('a row the list does show steps as before, whatever the open email says', () => {
      expect(stepThroughList(list, 20, false, +1, dated(20, '2026-10-02T12:00:00Z')).uid).toBe(10);
      expect(stepThroughList(list, 20, false, -1, dated(20, '2026-10-02T12:00:00Z')).uid).toBe(30);
    });
  });

  it('has nothing to step to in an empty list', () => {
    expect(stepThroughList([], 1, false, +1)).toBe(null);
  });
});
