/**
 * Premium price copy shown in upsell overlays.
 *
 * The Billing tab renders real prices from /api/billing/pricing, which resolves
 * currency server-side from the request country (see BillingSettings). These
 * teaser blurbs sit in feature overlays that have no pricing state and must not
 * fire a network request, so they mirror that resolution locally off the
 * machine's region.
 *
 * Amounts and the region→currency map mirror MANUAL_AMOUNTS / COUNTRY_CURRENCY
 * in website/api/server.js — keep both sides in sync when prices change.
 * Anything outside usd/gbp/eur bills in EUR (Stripe converts at checkout), which
 * is what the server displays for those regions too.
 */

/** Minor units, matching the currency_options on the Stripe prices. */
const AMOUNTS = {
  eur: { monthly: 400, yearly: 2500 },
  usd: { monthly: 400, yearly: 2500 },
  gbp: { monthly: 350, yearly: 2100 },
};

const BASE_CURRENCY = 'eur';

const REGION_CURRENCY = {
  US: 'usd', GB: 'gbp', UK: 'gbp',
  AT: 'eur', BE: 'eur', CY: 'eur', DE: 'eur', EE: 'eur', ES: 'eur', FI: 'eur',
  FR: 'eur', GR: 'eur', HR: 'eur', IE: 'eur', IT: 'eur', LT: 'eur', LU: 'eur',
  LV: 'eur', MT: 'eur', NL: 'eur', PT: 'eur', SI: 'eur', SK: 'eur',
};

/** Region of the first locale tag that carries one. Null when none does. */
export function detectRegion(tags) {
  const list = tags || [
    ...(typeof navigator !== 'undefined' ? navigator.languages || [] : []),
    typeof navigator !== 'undefined' ? navigator.language : null,
  ].filter(Boolean);
  for (const tag of list) {
    try {
      // No maximize() — 'en' must not become US pricing. Unknown region bills
      // in the EUR base, same as the server's fallback.
      const region = new Intl.Locale(tag).region;
      if (region) return region.toUpperCase();
    } catch { /* malformed tag — try the next one */ }
  }
  return null;
}

export function currencyForRegion(region) {
  return (region && REGION_CURRENCY[region.toUpperCase()]) || BASE_CURRENCY;
}

/**
 * en-US locale on purpose: the Billing tab's server formatting uses it too.
 * Whole amounts lose the decimals ($4, not $4.00); anything with cents keeps
 * both digits — a flat `minimumFractionDigits: 0` renders £3.50 as "£3.5".
 */
export function formatAmount(minorUnits, currency) {
  try {
    const digits = minorUnits % 100 === 0 ? 0 : 2;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(minorUnits / 100);
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function priceBlurb(currency = BASE_CURRENCY) {
  const amounts = AMOUNTS[currency] || AMOUNTS[BASE_CURRENCY];
  const cur = AMOUNTS[currency] ? currency : BASE_CURRENCY;
  return `${formatAmount(amounts.monthly, cur)}/month or ${formatAmount(amounts.yearly, cur)}/year`;
}

/** Resolved once — the machine's region does not change mid-session. */
export const PREMIUM_PRICE_BLURB = priceBlurb(currencyForRegion(detectRegion()));
