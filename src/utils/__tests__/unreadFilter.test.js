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

  it('keeps a selected read message whose row uses a composite key', () => {
    const spanning = [
      { ...unread(2), _accountId: 'a', _mailbox: 'INBOX' },
      { ...read(3), _accountId: 'b', _mailbox: 'Archive' },
    ];
    const keyOf = e => `${e._accountId}:${e._mailbox}:${e.uid}`;

    expect(filterUnread(spanning, true, 'b:Archive:3', keyOf).map(keyOf))
      .toEqual(['a:INBOX:2', 'b:Archive:3']);
  });

  it('does not duplicate the selected message when it is already unread', () => {
    expect(filterUnread(list, true, 2).map(e => e.uid)).toEqual([2, 4]);
  });

  it('survives a null list', () => {
    expect(filterUnread(null, true)).toEqual([]);
  });
});

// A message read while the filter is on must stay on screen until the filter
// is toggled — otherwise it vanishes the moment the selection moves on, and
// the list looks like it lost the message you just opened.
describe('filterUnread sticky keep set', () => {
  const list = [read(1), unread(2), read(3), unread(4)];

  it('keeps every key the keep set names, not just the open one', () => {
    const keep = new Set([1, 3]);
    expect(filterUnread(list, true, null, e => e.uid, keep).map(e => e.uid)).toEqual([1, 2, 3, 4]);
  });

  it('keeps the open message and the keep set together', () => {
    const keep = new Set([1]);
    expect(filterUnread(list, true, 3, e => e.uid, keep).map(e => e.uid)).toEqual([1, 2, 3, 4]);
  });

  it('ignores an empty keep set', () => {
    expect(filterUnread(list, true, null, e => e.uid, new Set()).map(e => e.uid)).toEqual([2, 4]);
  });

  it('matches the keep set on the composite key a spanning list uses', () => {
    const spanning = [
      { ...unread(2), _accountId: 'a', _mailbox: 'INBOX' },
      { ...read(3), _accountId: 'b', _mailbox: 'Archive' },
    ];
    const keyOf = e => `${e._accountId}:${e._mailbox}:${e.uid}`;
    expect(filterUnread(spanning, true, null, keyOf, new Set(['b:Archive:3'])).map(keyOf))
      .toEqual(['a:INBOX:2', 'b:Archive:3']);
  });

  it('still returns the same array reference when the filter is off', () => {
    expect(filterUnread(list, false, null, e => e.uid, new Set([1]))).toBe(list);
  });
});
