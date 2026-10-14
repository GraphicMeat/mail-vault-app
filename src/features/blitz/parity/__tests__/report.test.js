import { describe, it, expect } from 'vitest';
import { caseSummary, failedCase, reportTotals, unknownFixtureIds } from '../report';

const c = { fixture: 'ours/x', mode: 'dark', width: 'wide' };

describe('parity report', () => {
  it('a case that threw is a failed case with its error, not a missing one', () => {
    expect(failedCase(c, new Error('Blitz root never matched\nstack'))).toEqual({ ...c, compared: 0, passed: false, failing: 0, known: 0, error: 'Blitz root never matched' });
  });

  it('summarises a compared case', () => {
    expect(caseSummary(c, { compared: 9, passed: false, failing: [1, 2], known: [3] })).toEqual({ ...c, compared: 9, passed: false, failing: 2, known: 1 });
  });

  it('is complete only when every expected case ran and passed', () => {
    const ok = { ...c, passed: true };
    expect(reportTotals([ok, ok], 2)).toEqual({ cases: 2, expected: 2, passed: 2, complete: true });
    expect(reportTotals([ok], 2).complete).toBe(false);
    expect(reportTotals([ok, failedCase(c, 'boom')], 2).complete).toBe(false);
    expect(reportTotals([], 0).complete).toBe(false);
  });

  it('names MV_PARITY_ONLY ids the manifest does not have', () => {
    const manifest = { fixtures: [{ id: 'ours/a' }, { id: 'postmark/welcome' }] };
    expect(unknownFixtureIds(['ours/a', 'postmark/welcom'], manifest)).toEqual(['postmark/welcom']);
    expect(unknownFixtureIds([], manifest)).toEqual([]);
  });
});
