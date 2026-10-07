import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The API is CommonJS and cannot boot here (meatlytics pulls in better-sqlite3),
// so the /api/billing/pricing body is built by a pure module tested on its own.
const require = createRequire(import.meta.url);
const pricing = require('../api/pricing.js');

const body = (currency, country) => pricing.pricingBody(
  pricing.resolvePricing(currency, country, undefined),
  { trialDays: 14, trialEligible: true },
);

describe('pricing amounts', () => {
  it('keeps the early-bird amounts that are charged today', () => {
    expect(pricing.MANUAL_AMOUNTS.usd).toMatchObject({ monthly: 400, yearly: 2500 });
    expect(pricing.MANUAL_AMOUNTS.eur).toMatchObject({ monthly: 400, yearly: 2500 });
    expect(pricing.MANUAL_AMOUNTS.gbp).toMatchObject({ monthly: 350, yearly: 2100 });
  });

  it('holds the standard price after early access in the same table', () => {
    expect(pricing.MANUAL_AMOUNTS.usd).toMatchObject({ standardMonthly: 600, standardYearly: 3900 });
    expect(pricing.MANUAL_AMOUNTS.eur).toMatchObject({ standardMonthly: 600, standardYearly: 3900 });
    expect(pricing.MANUAL_AMOUNTS.gbp).toMatchObject({ standardMonthly: 500, standardYearly: 3300 });
  });
});

describe('GET /api/billing/pricing body', () => {
  it.each([
    ['usd', 'US', '$6', '$39'],
    ['eur', 'DE', '€6', '€39'],
    ['gbp', 'GB', '£5', '£33'],
  ])('returns the %s standard price beside the plans', (currency, country, monthly, yearly) => {
    for (const b of [body(currency), body(undefined, country)]) {
      expect(b.currency).toBe(currency);
      expect(b.standard).toEqual({
        monthly: pricing.MANUAL_AMOUNTS[currency].standardMonthly,
        yearly: pricing.MANUAL_AMOUNTS[currency].standardYearly,
        formattedMonthly: monthly,
        formattedYearly: yearly,
      });
    }
  });

  it('leaves the plans at the early-bird price', () => {
    const b = body('usd');
    expect(b.plans.map((p) => [p.planId, p.amount, p.formattedAmount])).toEqual([
      ['monthly', 400, '$4'],
      ['yearly', 2500, '$25'],
    ]);
    expect(b.plans[1]).toMatchObject({ monthlyEquivalent: '$2.08', savingsPercent: 48, trialDays: 14, trialEligible: true });
    expect(body('gbp').plans.map((p) => p.formattedAmount)).toEqual(['£3.50', '£21']);
  });

  it('gives adaptive-currency visitors the EUR base, standard price included', () => {
    const b = body(undefined, 'JP');
    expect(b).toMatchObject({ currency: 'eur', pricingMode: 'adaptive', presentmentCurrency: 'jpy' });
    expect(b.standard).toEqual({ monthly: 600, yearly: 3900, formattedMonthly: '€6', formattedYearly: '€39' });
    expect(body(undefined, undefined).standard.formattedYearly).toBe('€39');
  });
});
