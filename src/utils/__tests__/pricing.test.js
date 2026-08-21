import { describe, it, expect } from 'vitest';
import { detectRegion, currencyForRegion, formatAmount, priceBlurb, blurbFromAmounts, pricingRecord } from '../pricing';

describe('detectRegion', () => {
  it('takes the region off the first tag that carries one', () => {
    expect(detectRegion(['en', 'en-GB', 'lt-LT'])).toBe('GB');
    expect(detectRegion(['fr-FR'])).toBe('FR');
  });

  it('does not invent a region for a bare language', () => {
    expect(detectRegion(['en'])).toBeNull();
    expect(detectRegion([])).toBeNull();
  });

  it('skips malformed tags instead of throwing', () => {
    expect(detectRegion(['not a tag', 'de-DE'])).toBe('DE');
  });
});

describe('currencyForRegion', () => {
  it('maps the three billed currencies', () => {
    expect(currencyForRegion('US')).toBe('usd');
    expect(currencyForRegion('GB')).toBe('gbp');
    expect(currencyForRegion('DE')).toBe('eur');
  });

  // Matches the server: non-manual and unknown regions are quoted in the EUR base.
  it('falls back to EUR for adaptive and unknown regions', () => {
    expect(currencyForRegion('JP')).toBe('eur');
    expect(currencyForRegion('ZZ')).toBe('eur');
    expect(currencyForRegion(null)).toBe('eur');
  });
});

describe('priceBlurb', () => {
  // These strings must equal what /api/billing/pricing formats for the same
  // currency — MANUAL_AMOUNTS in website/api/server.js, formatted en-US.
  it('quotes the live amounts per currency', () => {
    expect(priceBlurb('usd')).toBe('$4/month or $25/year');
    expect(priceBlurb('eur')).toBe('€4/month or €25/year');
    expect(priceBlurb('gbp')).toBe('£3.50/month or £21/year');
  });

  it('defaults to EUR for an unknown currency', () => {
    expect(priceBlurb('xyz')).toBe(priceBlurb('eur'));
    expect(priceBlurb()).toBe(priceBlurb('eur'));
  });
});

describe('formatAmount', () => {
  it('drops trailing zeros but keeps real cents', () => {
    expect(formatAmount(400, 'usd')).toBe('$4');
    expect(formatAmount(350, 'gbp')).toBe('£3.50');
  });
});

describe('blurbFromAmounts', () => {
  // Server-sent amounts render through the same formatter as the local mirror,
  // so a paywall fed by /api/billing/pricing reads identically to the fallback.
  it('formats server minor units into the blurb shape', () => {
    expect(blurbFromAmounts(400, 2500, 'eur')).toBe(priceBlurb('eur'));
    expect(blurbFromAmounts(350, 2100, 'gbp')).toBe('£3.50/month or £21/year');
  });
});

describe('pricingRecord', () => {
  const response = {
    currency: 'eur',
    pricingMode: 'manual',
    plans: [
      { planId: 'monthly', interval: 'month', amount: 400, formattedAmount: '€4' },
      { planId: 'yearly', interval: 'year', amount: 2500, formattedAmount: '€25' },
    ],
  };

  it('keeps the currency the server resolved, not the machine locale', () => {
    expect(pricingRecord(response)).toEqual({
      currency: 'eur', monthly: 400, yearly: 2500, pricingMode: 'manual',
    });
  });

  // Adaptive regions are quoted in the EUR base — same as the Billing tab's cards.
  it('takes the display currency, not the presentment one', () => {
    const adaptive = { ...response, pricingMode: 'adaptive', presentmentCurrency: 'sek' };
    expect(pricingRecord(adaptive).currency).toBe('eur');
  });

  it('rejects a payload it cannot price, leaving the fallback in place', () => {
    expect(pricingRecord(null)).toBeNull();
    expect(pricingRecord({ currency: 'eur', plans: [] })).toBeNull();
    expect(pricingRecord({ plans: response.plans })).toBeNull();
    expect(pricingRecord({ currency: 'eur', plans: [response.plans[0]] })).toBeNull();
  });
});
