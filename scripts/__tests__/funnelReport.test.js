import { describe, it, expect } from 'vitest';
import { weekStart, classifyTrial, trialFunnel, mergeWeeks, renderReport } from '../funnel-report.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 17); // Mon 2026-08-17

// A yearly Stripe subscription as billing_subscriptions stores it. Trial
// subscriptions keep created_at at trial start; the period rolls to the paid
// year (+14d, 365d long) once the trial ends.
const sub = (o) => ({
  id: 1,
  price_interval: 'year',
  status: 'active',
  created_ms: T0,
  period_start_ms: T0,
  period_end_ms: T0 + 365 * DAY,
  cancel_at_period_end: 0,
  latest_invoice_status: 'paid',
  ...o,
});

describe('weekStart', () => {
  it('buckets any day to the Monday of its week', () => {
    expect(weekStart(Date.UTC(2026, 8, 20, 23, 59))).toBe('2026-09-14'); // Sunday
    expect(weekStart(Date.UTC(2026, 8, 21, 0, 0))).toBe('2026-09-21'); // Monday
    expect(weekStart(Date.UTC(2026, 8, 23, 12))).toBe('2026-09-21'); // Wednesday
  });
});

describe('classifyTrial', () => {
  it('treats a yearly sub with no trial period as no_trial', () => {
    expect(classifyTrial(sub({}))).toBe('no_trial');
  });

  it('treats monthly as no_trial: monthly bills from day one', () => {
    const monthly = sub({ price_interval: 'month', period_end_ms: T0 + 30 * DAY });
    expect(classifyTrial(monthly)).toBe('no_trial');
  });

  it('keeps a 14-day trialing sub in_trial, even when cancel is set', () => {
    const trialing = sub({ status: 'trialing', period_end_ms: T0 + 14 * DAY, latest_invoice_status: 'paid' });
    expect(classifyTrial(trialing)).toBe('in_trial');
    expect(classifyTrial({ ...trialing, cancel_at_period_end: 1 })).toBe('in_trial');
  });

  it('calls a canceled sub that never left the 14-day period cancelled_in_trial', () => {
    const gone = sub({ status: 'canceled', period_end_ms: T0 + 14 * DAY, latest_invoice_status: null });
    expect(classifyTrial(gone)).toBe('cancelled_in_trial');
  });

  it('calls a rolled period with a paid invoice paid', () => {
    const paid = sub({ period_start_ms: T0 + 14 * DAY, period_end_ms: T0 + 379 * DAY });
    expect(classifyTrial(paid)).toBe('paid');
  });

  it('calls a rolled period with a failed invoice charge_failed, even once canceled', () => {
    const failed = sub({
      status: 'canceled',
      period_start_ms: T0 + 14 * DAY,
      period_end_ms: T0 + 379 * DAY,
      latest_invoice_status: 'failed',
    });
    expect(classifyTrial(failed)).toBe('charge_failed');
  });

  it('does not mistake a multi-year comp for a trial', () => {
    const comp = sub({ status: 'trialing', period_end_ms: T0 + 2 * 365 * DAY });
    expect(classifyTrial(comp)).toBe('no_trial');
  });
});

describe('trialFunnel', () => {
  const paid = sub({ period_start_ms: T0 + 14 * DAY });
  const failed = sub({ period_start_ms: T0 + 14 * DAY, status: 'canceled', latest_invoice_status: 'failed' });
  const cancelled = sub({ status: 'canceled', period_end_ms: T0 + 14 * DAY, latest_invoice_status: null });
  const inTrial = sub({ status: 'trialing', period_end_ms: T0 + 14 * DAY });

  it('counts outcomes and derives the two rates over resolved trials only', () => {
    const f = trialFunnel([paid, paid, paid, failed, cancelled, inTrial]);
    expect(f.counts).toEqual({ in_trial: 1, paid: 3, charge_failed: 1, cancelled_in_trial: 1 });
    expect(f.started).toBe(6);
    expect(f.resolved).toBe(5);
    expect(f.conversion).toBeCloseTo(3 / 5);
    // charge failure only exists for trials that reached a charge
    expect(f.chargeFailure).toBeCloseTo(1 / 4);
  });

  it('keeps no_trial subs out of the funnel', () => {
    expect(trialFunnel([sub({})]).started).toBe(0);
  });

  it('returns null rates, not NaN, when nothing has resolved', () => {
    const f = trialFunnel([inTrial]);
    expect(f.conversion).toBeNull();
    expect(f.chargeFailure).toBeNull();
  });
});

describe('mergeWeeks', () => {
  it('joins every source by Monday, fills gaps with 0, and sorts oldest first', () => {
    const rows = mergeWeeks({
      visitors: { '2026-09-14': 289, '2026-09-21': 807 },
      downloaders: { '2026-09-21': 33 },
      releases: [
        { published: '2026-09-25T10:00:00Z', newUsers: 45, updates: 40 },
        { published: '2026-09-30T10:00:00Z', newUsers: 18, updates: 54 },
        { published: '2026-05-04T10:00:00Z', newUsers: null, updates: null }, // predates tracking
      ],
      subs: [sub({ created_ms: Date.UTC(2026, 8, 22) })],
    });
    expect(rows.map((r) => r.week)).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
    expect(rows[1]).toMatchObject({ visitors: 807, downloaders: 33, newUsers: 45, updates: 40, newSubs: 1 });
    expect(rows[1].visitorToDownload).toBeCloseTo(33 / 807);
    expect(rows[0]).toMatchObject({ downloaders: 0, newUsers: 0, newSubs: 0 });
    expect(rows[0].visitorToDownload).toBe(0);
    expect(rows[2]).toMatchObject({ visitors: 0, newUsers: 18, updates: 54 });
    expect(rows[2].visitorToDownload).toBeNull(); // no visitors: no rate, not NaN
  });
});

describe('renderReport', () => {
  it('prints the four numbers and no NaN for an empty window', () => {
    const out = renderReport({ weeks: [], trial: trialFunnel([]), generatedAt: '2026-10-05' });
    expect(out).toContain('visitor -> download');
    expect(out).toContain('trial -> paid');
    expect(out).toContain('first charge failed');
    expect(out).not.toMatch(/NaN|undefined/);
  });

  it('measures new user -> subscription only from the first week a subscription exists', () => {
    // 100 new users arrived before billing existed: they must not dilute the rate.
    const week = (w, newUsers, newSubs) => ({ week: w, visitors: 0, downloaders: 0, newUsers, updates: 0, newSubs, visitorToDownload: null });
    const out = renderReport({
      weeks: [week('2026-08-03', 100, 0), week('2026-08-17', 50, 5), week('2026-08-24', 50, 5)],
      trial: trialFunnel([]),
      generatedAt: '2026-10-05',
    });
    expect(out).toContain('10.0%  (10 subs of 100 new users');
  });
});
