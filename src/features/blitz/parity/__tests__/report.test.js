import { describe, it, expect } from 'vitest';
import { caseSummary, failedCase, reportGate, reportTotals, unknownFixtureIds } from '../report';

const c = { fixture: 'ours/x', mode: 'dark', width: 'wide' };

describe('parity report', () => {
  it('a case that threw is a failed case with its error, not a missing one', () => {
    expect(failedCase(c, new Error('Blitz root never matched\nstack'))).toEqual({ ...c, compared: 0, passed: false, failing: 0, known: 0, error: 'Blitz root never matched' });
  });

  it('summarises a compared case', () => {
    expect(caseSummary(c, { compared: 9, passed: false, failing: [1, 2], known: [3] })).toEqual({ ...c, compared: 9, passed: false, failing: 2, known: 1 });
  });

  it('is complete only when every planned case ran, none threw and each compared something', () => {
    const ok = { ...c, compared: 9, passed: true };
    expect(reportTotals([ok, ok], 2)).toEqual({ cases: 2, expected: 2, passed: 2, complete: true });
    expect(reportTotals([ok], 2).complete).toBe(false);
    expect(reportTotals([ok, failedCase(c, 'boom')], 2).complete).toBe(false);
    expect(reportTotals([], 0).complete).toBe(false);
    expect(reportTotals([ok, { ...ok, compared: 0 }], 2).complete).toBe(false);
  });

  it('a case whose web fonts timed out is not a measurement', () => {
    const ok = { ...c, compared: 9, passed: true };
    expect(reportTotals([ok, { ...ok, fonts: 'timeout' }], 2).complete).toBe(false);
    expect(reportTotals([ok, { ...ok, fonts: 'loaded' }], 2).complete).toBe(true);
  });

  it('a run whose setup failed is 0 of N planned, not 0 of 0', () => {
    const totals = reportTotals([], 112);
    expect(totals).toEqual({ cases: 0, expected: 112, passed: 0, complete: false });
    expect(reportGate({ totals })).toBe(false);
  });

  it('the gate wants a complete run in which every case passed', () => {
    const ok = { ...c, compared: 9, passed: true };
    expect(reportGate({ totals: reportTotals([ok, ok], 2) })).toBe(true);
    expect(reportGate({ totals: reportTotals([ok, { ...ok, passed: false }], 2) })).toBe(false);
    expect(reportGate({ totals: { cases: 2, expected: 2, passed: 2 } })).toBe(false);
    expect(reportGate(null)).toBe(false);
    expect(reportGate({})).toBe(false);
  });

  it('names MV_PARITY_ONLY ids the manifest does not have', () => {
    const manifest = { fixtures: [{ id: 'ours/a' }, { id: 'postmark/welcome' }] };
    expect(unknownFixtureIds(['ours/a', 'postmark/welcom'], manifest)).toEqual(['postmark/welcom']);
    expect(unknownFixtureIds([], manifest)).toEqual([]);
  });
});
