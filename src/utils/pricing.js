import { t } from '../i18n/index.js';
/**
 * Premium price copy shown in upsell overlays.
 *
 * Every price surface renders /api/billing/pricing, which resolves currency
 * server-side from the request country — the same signal Stripe uses to pick a
 * presentment currency at checkout (see usePremiumPricing). The locale-derived
 * blurb below is the fallback shown until that answer lands, and it is only a
 * guess: a machine set to en-GB inside the eurozone bills in EUR, not GBP.
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

/** The one blurb shape. Amounts are minor units in `currency`. */
export function blurbFromAmounts(monthly, yearly, currency) {
  return t('util.pricing.monthYear', { formatAmount: formatAmount(monthly, currency), formatAmount2: formatAmount(yearly, currency) });
}

export function priceBlurb(currency = BASE_CURRENCY) {
  const cur = AMOUNTS[currency] ? currency : BASE_CURRENCY;
  const amounts = AMOUNTS[cur];
  return blurbFromAmounts(amounts.monthly, amounts.yearly, cur);
}

/**
 * A /api/billing/pricing response → the record every paywall renders.
 * Null when the payload carries no usable plan pair, so a malformed answer
 * leaves the locale fallback in place instead of blanking the price.
 */
export function pricingRecord(response) {
  const monthly = response?.plans?.find((p) => p.interval === 'month');
  const yearly = response?.plans?.find((p) => p.interval === 'year');
  if (!response?.currency || monthly?.amount == null || yearly?.amount == null) return null;
  return {
    currency: response.currency,
    monthly: monthly.amount,
    yearly: yearly.amount,
    pricingMode: response.pricingMode || null,
    trialDays: yearly.trialEligible && yearly.trialDays ? yearly.trialDays : 0,
    ...(response.standard?.monthly && response.standard?.yearly
      ? { standardMonthly: response.standard.monthly, standardYearly: response.standard.yearly }
      : {}),
  };
}

/** The trial the yearly plan carries when the cached answer predates `trialDays`. */
const DEFAULT_TRIAL_DAYS = 14;

function planOffer(planId, amount, standardAmount, currency) {
  const off = standardAmount && amount < standardAmount ? Math.round((1 - amount / standardAmount) * 100) : 0;
  return {
    planId,
    price: formatAmount(amount, currency),
    standard: off ? formatAmount(standardAmount, currency) : null,
    off,
  };
}

/**
 * What the free note quotes, plan by plan: the price, and while early access
 * sells it below the standard price, that standard price and the discount.
 * `limited` is false once checkout charges the standard price, so nothing is
 * called an offer then. Before the server answers, the locale guess stands in
 * (early access prices, no standard to compare with).
 */
export function premiumOffer(record) {
  const r = record || (() => {
    const currency = currencyForRegion(detectRegion());
    return { currency, ...AMOUNTS[currency] };
  })();
  const yearly = planOffer('yearly', r.yearly, r.standardYearly, r.currency);
  const monthly = planOffer('monthly', r.monthly, r.standardMonthly, r.currency);
  const known = !!(r.standardMonthly && r.standardYearly);
  return {
    limited: !known || yearly.off > 0 || monthly.off > 0,
    trialDays: r.trialDays ?? DEFAULT_TRIAL_DAYS,
    yearly,
    monthly,
  };
}

/**
 * Locale-derived fallback, resolved once — the machine's region does not change
 * mid-session. Only shown until the server answers; see usePremiumPricing.
 */
export const PREMIUM_PRICE_BLURB = priceBlurb(currencyForRegion(detectRegion()));
