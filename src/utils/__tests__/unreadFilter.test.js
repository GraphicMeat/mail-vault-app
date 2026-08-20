import { describe, it, expect } from 'vitest';
import { isUnread, filterUnread } from '../emailParser';

const read = (uid) => ({ uid, flags: ['\\Seen'] });
const unread = (uid) => ({ uid, flags: [] });

describe('isUnread', () => {
  it('is true when \\Seen is absent', () => {
    expect(isUnread(unread(1))).toBe(true);
  });

  it('is false when \\Seen is present', () => {
    expect(isUnread(read(1))).toBe(false);
  });

  // Local-only messages restored from a Maildir can arrive with no flags array
  // at all; treating that as "read" would hide them from the filter entirely.
  it('treats a missing flags array as unread', () => {
    expect(isUnread({ uid: 9 })).toBe(true);
    expect(isUnread({ uid: 9, flags: null })).toBe(true);
  });
});

describe('filterUnread', () => {
  const list = [read(1), unread(2), read(3), unread(4)];

  it('returns the same array reference when the filter is off', () => {
    expect(filterUnread(list, false)).toBe(list);
  });

  it('keeps only unread messages when the filter is on', () => {
    expect(filterUnread(list, true).map(e => e.uid)).toEqual([2, 4]);
  });

  // Opening an unread message marks it read, which would yank the row out from
  // under the reader mid-sentence. The open message stays until the selection
  // moves on.
  it('keeps the selected message even after it turns read', () => {
    expect(filterUnread(list, true, 3).map(e => e.uid)).toEqual([2, 3, 4]);
  });

  it('does not duplicate the selected message when it is already unread', () => {
    expect(filterUnread(list, true, 2).map(e => e.uid)).toEqual([2, 4]);
  });

  it('survives a null list', () => {
    expect(filterUnread(null, true)).toEqual([]);
  });
});
