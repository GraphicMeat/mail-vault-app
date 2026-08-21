import { useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { fetchPricing } from '../services/billingApi';
import { IS_APPSTORE_BUILD } from '../utils/buildFlags.js';
import { PREMIUM_PRICE_BLURB, blurbFromAmounts, pricingRecord } from '../utils/pricing';

/**
 * One currency for every paywall.
 *
 * The Billing tab has always rendered /api/billing/pricing, which resolves the
 * currency from the request country — the same signal Stripe uses to pick a
 * presentment currency at checkout. The feature overlays resolved it from
 * navigator.language instead, so an en-GB machine in the eurozone was quoted
 * "£3.50/month or £21/year" beside a "€4/mo" plan card. Both now read this
 * cache; the locale blurb only fills the gap before the first answer lands.
 *
 * Cached in the persisted settings store so a cold launch shows the currency
 * the user was last quoted rather than the locale guess.
 */

const TTL = 24 * 60 * 60 * 1000;

let inflight = null;

/**
 * Fetch once per session (or once a day across sessions) and cache. Failures are
 * swallowed: an overlay that can't reach billing still shows the locale blurb.
 */
export function ensurePremiumPricing() {
  // MAS builds never render a price — no request, no cache.
  if (IS_APPSTORE_BUILD) return Promise.resolve(null);
  const { premiumPricing, setPremiumPricing } = useSettingsStore.getState();
  if (premiumPricing && Date.now() - (premiumPricing.fetchedAt || 0) < TTL) {
    return Promise.resolve(premiumPricing);
  }
  if (inflight) return inflight;
  inflight = fetchPricing()
    .then((res) => {
      const record = pricingRecord(res);
      if (record) setPremiumPricing(record);
      return record;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

/** "€4/month or €25/year" in the currency checkout will actually bill. */
export function usePremiumPriceBlurb() {
  const pricing = useSettingsStore((s) => s.premiumPricing);
  useEffect(() => { ensurePremiumPricing(); }, []);
  return pricing
    ? blurbFromAmounts(pricing.monthly, pricing.yearly, pricing.currency)
    : PREMIUM_PRICE_BLURB;
}
