// Where the next page of a Graph folder starts. Graph lists newest first, so a
// position is a moment (receivedDateTime) plus how many rows at exactly that
// moment were already listed: a message deleted or arriving elsewhere moves a
// row count, never a moment.
import { describe, it, expect } from 'vitest';
import { graphCursorAfter, pickGraphCursor, graphPageArgs } from '../graphCursor';

const KEY = 'acct:INBOX';
const T3 = '2026-01-05T10:00:00Z';
const T2 = '2026-01-04T10:00:00Z';
const T1 = '2026-01-03T10:00:00Z';
const rows = (...dates) => dates.map((date, i) => ({ uid: i + 1, date }));

describe('graphCursorAfter', () => {
  it('a first page: its oldest moment and how many rows sit on it', () => {
    expect(graphCursorAfter(KEY, rows(T3, T2, T2), null)).toEqual({ key: KEY, before: T2, skip: 2 });
  });

  it('a page that reaches back past the cursor restarts the tie count at the new moment', () => {
    const prior = { key: KEY, before: T2, skip: 2 };
    expect(graphCursorAfter(KEY, rows(T2, T1), prior)).toEqual({ key: KEY, before: T1, skip: 1 });
  });

  it('a page made only of the cursor\'s moment adds to its tie count', () => {
    const prior = { key: KEY, before: T2, skip: 2 };
    expect(graphCursorAfter(KEY, rows(T2, T2), prior)).toEqual({ key: KEY, before: T2, skip: 4 });
  });

  it('an empty page leaves the cursor where it was', () => {
    const prior = { key: KEY, before: T2, skip: 2 };
    expect(graphCursorAfter(KEY, [], prior)).toEqual(prior);
  });

  it('rows with no date count toward the skip and leave the moment alone', () => {
    const prior = { key: KEY, before: T2, skip: 2 };
    expect(graphCursorAfter(KEY, [{ uid: 1 }, { uid: 2 }], prior)).toEqual({ key: KEY, before: T2, skip: 4 });
    expect(graphCursorAfter(KEY, [{ uid: 1 }, { uid: 2 }], null)).toEqual({ key: KEY, before: null, skip: 2 });
  });
});

describe('pickGraphCursor', () => {
  it('takes the page\'s own cursor when none was held', () => {
    expect(pickGraphCursor(null, KEY, rows(T3, T2))).toEqual({ key: KEY, before: T2, skip: 1 });
    expect(pickGraphCursor({ key: 'acct:Sent', before: T1, skip: 1 }, KEY, rows(T3, T2)))
      .toEqual({ key: KEY, before: T2, skip: 1 });
  });

  it('keeps a cursor that already reaches further back: the list keeps the rows it covers', () => {
    const prior = { key: KEY, before: T1, skip: 1 };
    expect(pickGraphCursor(prior, KEY, rows(T3, T2))).toBe(prior);
  });

  it('drops a cursor that does not reach past the new page', () => {
    expect(pickGraphCursor({ key: KEY, before: T3, skip: 1 }, KEY, rows(T3, T2)))
      .toEqual({ key: KEY, before: T2, skip: 1 });
    expect(pickGraphCursor({ key: KEY, before: null, skip: 5 }, KEY, rows(T3, T2)))
      .toEqual({ key: KEY, before: T2, skip: 1 });
  });
});

describe('graphPageArgs', () => {
  it('reads at the cursor of this folder', () => {
    expect(graphPageArgs({ key: KEY, before: T2, skip: 2 }, KEY, 200)).toEqual({ top: 200, skip: 2, before: T2 });
  });

  it('starts from the top for no cursor, another folder\'s, or one with no moment', () => {
    expect(graphPageArgs(null, KEY, 200)).toEqual({ top: 200, skip: 0 });
    expect(graphPageArgs({ key: 'acct:Sent', before: T2, skip: 2 }, KEY, 200)).toEqual({ top: 200, skip: 0 });
    expect(graphPageArgs({ key: KEY, before: null, skip: 7 }, KEY, 200)).toEqual({ top: 200, skip: 7 });
  });
});
