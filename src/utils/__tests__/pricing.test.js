import { describe, it, expect } from 'vitest';
import { detectRegion, currencyForRegion, formatAmount, priceBlurb } from '../pricing';

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
