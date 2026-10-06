import { describe, expect, it } from 'vitest';
import { coveringRun } from '../../scripts/ci-watch.mjs';

// History a..d on main. a's run finished, b's pending run was replaced by d's
// when d landed mid-run, c only touched the website and got no run.
const order = ['a', 'b', 'c', 'd'];
const runs = [
  { databaseId: 4, headSha: 'd', createdAt: '2026-10-06T20:19:00Z', status: 'queued', conclusion: '' },
  { databaseId: 2, headSha: 'b', createdAt: '2026-10-06T20:10:00Z', status: 'completed', conclusion: 'cancelled' },
  { databaseId: 1, headSha: 'a', createdAt: '2026-10-06T20:00:00Z', status: 'in_progress', conclusion: '' },
];
const containing = (target) => (head) => order.indexOf(target) <= order.indexOf(head);

describe('coveringRun', () => {
  it('picks the run that built the commit itself', () => {
    expect(coveringRun(runs, containing('a')).databaseId).toBe(1);
  });

  it('skips a replaced pending run for the batch that covers it', () => {
    expect(coveringRun(runs, containing('b')).databaseId).toBe(4);
  });

  it('covers a commit that got no run of its own', () => {
    expect(coveringRun(runs, containing('c')).databaseId).toBe(4);
  });

  it('finds nothing before a run covers the commit', () => {
    expect(coveringRun(runs.slice(1), containing('c'))).toBeNull();
  });
});
