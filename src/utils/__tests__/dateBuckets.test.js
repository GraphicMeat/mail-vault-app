import { describe, it, expect } from 'vitest';
import {
  rowDate, monthBuckets, firstRowOfMonth, bucketAtIndex, railSegments, reachedMonth,
} from '../dateBuckets.js';

// Local-time dates: buckets are local months.
const email = (y, m, d = 15) => ({ type: 'email', email: { date: new Date(y, m - 1, d, 12).toISOString() } });
const thread = (y, m, d = 15) => ({ type: 'thread', thread: { lastDate: new Date(y, m - 1, d, 12) } });
const member = (y, m) => ({ type: 'thread-member', email: { date: new Date(y, m - 1, 1).toISOString() } });

describe('rowDate', () => {
  it('reads a thread by lastDate and an email by date, then internalDate', () => {
    expect(rowDate(thread(2021, 3)).getMonth()).toBe(2);
    expect(rowDate(email(2020, 7)).getFullYear()).toBe(2020);
    expect(rowDate({ type: 'email', email: { internalDate: new Date(2019, 0, 5).toISOString() } }).getFullYear()).toBe(2019);
  });

  it('skips thread members and treats missing, junk and epoch dates as undated', () => {
    expect(rowDate(member(2021, 3))).toBeNull();
    expect(rowDate({ type: 'email', email: {} })).toBeNull();
    expect(rowDate({ type: 'email', email: { date: 'not a date' } })).toBeNull();
    expect(rowDate({ type: 'thread', thread: { lastDate: new Date(0) } })).toBeNull();
    expect(rowDate(null)).toBeNull();
  });
});

describe('monthBuckets', () => {
  it('groups top-level rows by local month, newest first, counting rows', () => {
    const rows = [email(2021, 3, 20), thread(2021, 3, 2), member(2021, 3), email(2021, 2), email(2020, 12)];
    const b = monthBuckets(rows);
    expect(b.map(x => x.key)).toEqual(['2021-03', '2021-02', '2020-12']);
    expect(b.map(x => x.firstIndex)).toEqual([0, 3, 4]);
    expect(b.map(x => x.rows)).toEqual([2, 1, 1]);
    expect(b[0]).toMatchObject({ y: 2021, m: 3 });
  });

  it('attaches undated rows to the bucket before them and never mints a bogus month', () => {
    const undated = { type: 'email', email: {} };
    const b = monthBuckets([undated, email(2021, 3), undated, email(2021, 1)]);
    expect(b.map(x => x.key)).toEqual(['2021-03', '2021-01']);
    expect(b[0]).toMatchObject({ firstIndex: 0, rows: 3 });
    expect(monthBuckets([undated, undated])).toEqual([]);
  });

  it('keeps buckets unique when a row is out of date order', () => {
    const b = monthBuckets([email(2021, 3), email(2021, 1), email(2021, 3), email(2020, 5)]);
    expect(b.map(x => x.key)).toEqual(['2021-03', '2021-01', '2020-05']);
    expect(b[1].rows).toBe(2);
  });
});

describe('firstRowOfMonth + bucketAtIndex', () => {
  const rows = [email(2021, 3), email(2021, 3), thread(2021, 2), member(2021, 2), member(2021, 2), email(2020, 1)];
  const b = monthBuckets(rows);

  it('marks the first index of every month', () => {
    expect([...firstRowOfMonth(b)]).toEqual([0, 2, 5]);
  });

  it('binary-searches the bucket holding an index, members included', () => {
    expect(bucketAtIndex(b, 0).key).toBe('2021-03');
    expect(bucketAtIndex(b, 1).key).toBe('2021-03');
    expect(bucketAtIndex(b, 4).key).toBe('2021-02');
    expect(bucketAtIndex(b, 5).key).toBe('2020-01');
    expect(bucketAtIndex(b, 99).key).toBe('2020-01');
    expect(bucketAtIndex([], 0)).toBeNull();
  });
});

describe('railSegments', () => {
  const b = monthBuckets([email(2021, 3), email(2021, 3), email(2021, 2)]);

  it('uses loaded buckets only without a histogram', () => {
    const s = railSegments(b, null, {});
    expect(s.map(x => [x.kind, x.key, x.weight])).toEqual([['loaded', '2021-03', 2], ['loaded', '2021-02', 1]]);
    expect(s[0].start).toBe(0);
    expect(s[1].start).toBeCloseTo(2 / 3);
    expect(s[1].size).toBeCloseTo(1 / 3);
    expect(s[0].bucket).toBe(b[0]);
  });

  it('adds histogram months older than the oldest loaded one, then the uncached tail', () => {
    const hist = [
      { ym: '2021-03', count: 50 }, { ym: '2021-02', count: 40 },
      { ym: '2021-01', count: 30 }, { ym: '2020-11', count: 20 },
    ];
    const s = railSegments(b, hist, { totalEmails: 200, totalCached: 140 });
    expect(s.map(x => [x.kind, x.key || null, x.weight])).toEqual([
      ['loaded', '2021-03', 2], ['loaded', '2021-02', 1],
      ['unloaded', '2021-01', 30], ['unloaded', '2020-11', 20],
      ['older', null, 60],
    ]);
    expect(s[3]).toMatchObject({ y: 2020, m: 11 });
    const last = s[s.length - 1];
    expect(last.start + last.size).toBeCloseTo(1);
  });

  it('adds no tail when the cache holds the whole mailbox', () => {
    const s = railSegments(b, [{ ym: '2020-01', count: 5 }], { totalEmails: 100, totalCached: 100 });
    expect(s.map(x => x.kind)).toEqual(['loaded', 'loaded', 'unloaded']);
  });

  it('returns nothing for nothing', () => {
    expect(railSegments([], null, {})).toEqual([]);
  });
});

describe('reachedMonth', () => {
  const target = { y: 2021, m: 3 };
  it('is true only once the oldest loaded date is before the month starts', () => {
    expect(reachedMonth(new Date(2021, 2, 10), target)).toBe(false);
    expect(reachedMonth(new Date(2021, 2, 1), target)).toBe(false);
    expect(reachedMonth(new Date(2021, 1, 28, 23), target)).toBe(true);
    expect(reachedMonth(null, target)).toBe(false);
  });
});
