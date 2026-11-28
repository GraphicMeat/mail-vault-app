import { describe, it, expect } from 'vitest';
import { detectRegion, currencyForRegion, formatAmount, priceBlurb, blurbFromAmounts, pricingRecord, premiumOffer, PREMIUM_PRICE_BLURB } from '../pricing';

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
      currency: 'eur', monthly: 400, yearly: 2500, pricingMode: 'manual', trialDays: 0,
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

describe('pricingRecord standard price and trial', () => {
  it('keeps the standard price after early access and the yearly trial when the server sends them', () => {
    const res = {
      currency: 'gbp', pricingMode: 'manual',
      plans: [{ interval: 'month', amount: 350 }, { interval: 'year', amount: 2100, trialDays: 14, trialEligible: true }],
      standard: { monthly: 500, yearly: 3300 },
    };
    expect(pricingRecord(res)).toEqual({
      currency: 'gbp', monthly: 350, yearly: 2100, pricingMode: 'manual', standardMonthly: 500, standardYearly: 3300, trialDays: 14,
    });
  });

  it('a customer who already had a trial gets none', () => {
    const res = {
      currency: 'eur', plans: [{ interval: 'month', amount: 400 }, { interval: 'year', amount: 2500, trialDays: 14, trialEligible: false }],
    };
    expect(pricingRecord(res).trialDays).toBe(0);
  });
});

describe('premiumOffer', () => {
  const gbp = { currency: 'gbp', monthly: 350, yearly: 2100, pricingMode: 'manual', standardMonthly: 500, standardYearly: 3300, trialDays: 14 };

  it('quotes each plan beside the standard price it undercuts, with the discount', () => {
    expect(premiumOffer(gbp)).toEqual({
      limited: true,
      trialDays: 14,
      yearly: { planId: 'yearly', price: '£21', standard: '£33', off: 36 },
      monthly: { planId: 'monthly', price: '£3.50', standard: '£5', off: 30 },
    });
  });

  it('the EUR early access prices read like the website: 36% off yearly, 33% off monthly', () => {
    const eur = { currency: 'eur', monthly: 400, yearly: 2500, standardMonthly: 600, standardYearly: 3900, trialDays: 14 };
    const offer = premiumOffer(eur);
    expect(offer.yearly).toEqual({ planId: 'yearly', price: '€25', standard: '€39', off: 36 });
    expect(offer.monthly).toEqual({ planId: 'monthly', price: '€4', standard: '€6', off: 33 });
  });

  it('once early access sells the standard price, nothing is called limited or discounted', () => {
    const offer = premiumOffer({ ...gbp, monthly: 500, yearly: 3300 });
    expect(offer.limited).toBe(false);
    expect(offer.yearly).toEqual({ planId: 'yearly', price: '£33', standard: null, off: 0 });
    expect(offer.monthly).toEqual({ planId: 'monthly', price: '£5', standard: null, off: 0 });
  });

  it('a cached answer from before the standard price was kept quotes the plan prices alone, trial assumed', () => {
    const offer = premiumOffer({ currency: 'eur', monthly: 400, yearly: 2500, pricingMode: 'manual' });
    expect(offer).toEqual({
      limited: true, trialDays: 14,
      yearly: { planId: 'yearly', price: '€25', standard: null, off: 0 },
      monthly: { planId: 'monthly', price: '€4', standard: null, off: 0 },
    });
  });

  it('no trial when the customer already had one', () => {
    expect(premiumOffer({ ...gbp, trialDays: 0 }).trialDays).toBe(0);
  });

  it('before the server answers, the locale guess stands in', () => {
    const offer = premiumOffer(null);
    expect(offer.limited).toBe(true);
    expect(offer.trialDays).toBe(14);
    expect(PREMIUM_PRICE_BLURB).toContain(offer.yearly.price);
    expect(PREMIUM_PRICE_BLURB).toContain(offer.monthly.price);
    expect(offer.yearly.standard).toBeNull();
  });
});
