/**
 * The JS port of the daemon's FetchPolicy, held to the same shared fixture
 * the Rust tests read (src-core/src/fetch_mode.rs), so the app's download
 * gate and the daemon's never disagree about what a mode keeps.
 */
import { describe, it, expect } from 'vitest';
import cases from '../../../src-core/tests/fixtures/fetch-policy-cases.json';
import { fetchPolicy, keepsBody } from '../fetchPolicy';

describe('fetchPolicy (shared fixture)', () => {
  for (const c of cases.fromSettingsCases) {
    it(c.name, () => {
      expect(fetchPolicy(c.state, c.accountId)).toEqual(c.expected);
    });
  }
});

describe('keepsBody (shared fixture)', () => {
  for (const c of cases.keepsBodyCases) {
    it(c.name, () => {
      expect(keepsBody(c.policy, c.dateMs, c.nowMs)).toBe(c.expected);
    });
  }
});

describe('keepsBody edge cases', () => {
  const keepRecent = { mode: 'keepRecent', windowMonths: 3, hoarderPremium: false };
  const NOW = Date.UTC(2026, 0, 15);

  it('an unparseable date is outside a window', () => {
    expect(keepsBody(keepRecent, NaN, NOW)).toBe(false);
  });

  it('clamps to the end of a shorter month in UTC (Mar 31 minus 1 month is Feb 28)', () => {
    const now = Date.UTC(2026, 2, 31, 12);
    const policy = { ...keepRecent, windowMonths: 1 };
    expect(keepsBody(policy, Date.UTC(2026, 1, 28, 12), now)).toBe(true);
    expect(keepsBody(policy, Date.UTC(2026, 1, 28, 12) - 1, now)).toBe(false);
  });

  it('a window reaching before year 100 is not read as the 1900s', () => {
    // 2026 years back from 2026-01-15 lands in year 0; Date.UTC would read it as 1900.
    const policy = { ...keepRecent, windowMonths: 2026 * 12 };
    const year50 = new Date(0);
    year50.setUTCFullYear(50, 0, 1);
    expect(keepsBody(policy, year50.getTime(), NOW)).toBe(true);
  });
});
