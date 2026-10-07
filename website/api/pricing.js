// Pricing for GET /api/billing/pricing, kept pure so it can be tested without
// booting server.js (meatlytics pulls in better-sqlite3).
//
// ── Hybrid pricing: EUR base, manual USD/GBP, Adaptive for others ───────────
// Two EUR-based Stripe prices with currency_options for USD and GBP.
// Stripe Adaptive Pricing handles other eligible currencies from the EUR base.
const BASE_CURRENCY = 'eur';

// Manual currency_options amounts (in minor units). monthly/yearly match what's set
// on the Stripe price: the Early Bird & Family Pricing charged during early access.
// standardMonthly/standardYearly are the standard price after early access for new
// subscribers. They are display-only: no Stripe price carries them and nobody is
// charged them today. website/pricing-localize.js mirrors all four for its offline
// fallback; src/utils/pricing.js mirrors monthly/yearly.
const MANUAL_AMOUNTS = {
  eur: { monthly: 400, yearly: 2500, standardMonthly: 600, standardYearly: 3900 },
  usd: { monthly: 400, yearly: 2500, standardMonthly: 600, standardYearly: 3900 },
  gbp: { monthly: 350, yearly: 2100, standardMonthly: 500, standardYearly: 3300 },
};
const MANUAL_CURRENCIES = new Set(Object.keys(MANUAL_AMOUNTS));

// Currencies where Stripe Adaptive Pricing is commonly available
const ADAPTIVE_CURRENCIES = new Set([
  'aud', 'brl', 'cad', 'chf', 'czk', 'dkk', 'hkd', 'huf', 'inr', 'jpy',
  'krw', 'mxn', 'nok', 'nzd', 'pln', 'ron', 'sek', 'sgd', 'thb', 'try', 'twd', 'zar',
]);

// Map country code → currency
const COUNTRY_CURRENCY = {
  US: 'usd', GB: 'gbp', UK: 'gbp',
  AT: 'eur', BE: 'eur', CY: 'eur', DE: 'eur', EE: 'eur', ES: 'eur', FI: 'eur', FR: 'eur',
  GR: 'eur', IE: 'eur', IT: 'eur', LT: 'eur', LU: 'eur', LV: 'eur', MT: 'eur', NL: 'eur',
  PT: 'eur', SI: 'eur', SK: 'eur', HR: 'eur',
  AU: 'aud', BR: 'brl', CA: 'cad', CH: 'chf', CZ: 'czk', DK: 'dkk', HK: 'hkd',
  HU: 'huf', IN: 'inr', JP: 'jpy', KR: 'krw', MX: 'mxn', NO: 'nok', NZ: 'nzd',
  PL: 'pln', RO: 'ron', SE: 'sek', SG: 'sgd', TH: 'thb', TR: 'try', TW: 'twd', ZA: 'zar',
};

function resolveCountry(reqCountry, cfCountry, acceptLanguage) {
  if (reqCountry) return reqCountry.toUpperCase();
  if (cfCountry) return cfCountry.toUpperCase();
  if (acceptLanguage) {
    const match = acceptLanguage.match(/[a-z]{2}-([A-Z]{2})/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Resolve pricing for a customer.
 * Returns: { currency, pricingMode, monthly, yearly, standardMonthly, standardYearly } in minor units.
 * pricingMode: 'manual' | 'adaptive' | 'fallback' | 'default'
 */
function resolvePricing(reqCurrency, country, acceptLanguage) {
  // 1. Determine target currency
  let currency = reqCurrency?.toLowerCase();
  if (!currency) {
    const cc = resolveCountry(country, null, acceptLanguage);
    currency = cc ? (COUNTRY_CURRENCY[cc] || null) : null;
  }

  // 2. Manual currency → exact known amounts
  if (currency && MANUAL_CURRENCIES.has(currency)) {
    return { currency, pricingMode: 'manual', ...MANUAL_AMOUNTS[currency] };
  }

  // 3. Adaptive currency → Stripe will convert at checkout; show base EUR amounts as estimate
  const base = MANUAL_AMOUNTS[BASE_CURRENCY];
  if (currency && ADAPTIVE_CURRENCIES.has(currency)) {
    return { currency: BASE_CURRENCY, presentmentCurrency: currency, pricingMode: 'adaptive', ...base };
  }

  // 4. Fallback → EUR
  return { currency: BASE_CURRENCY, pricingMode: currency ? 'fallback' : 'default', ...base };
}

function formatAmount(amount, currency) {
  try {
    // Whole amounts drop the decimals (€4, not €4.00); anything with cents keeps
    // both digits: a flat minimumFractionDigits: 0 renders £3.50 as "£3.5".
    const digits = amount % 100 === 0 ? 0 : 2;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: digits, maximumFractionDigits: digits })
      .format(amount / 100);
  } catch { return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`; }
}

/** The JSON body of GET /api/billing/pricing for a resolved price. */
function pricingBody(resolved, { trialDays, trialEligible }) {
  const displayCur = resolved.currency;
  const savingsPercent = resolved.monthly > 0
    ? Math.round((1 - (resolved.yearly / 12) / resolved.monthly) * 100)
    : 0;

  return {
    currency: displayCur,
    baseCurrency: BASE_CURRENCY,
    pricingMode: resolved.pricingMode,
    ...(resolved.presentmentCurrency ? { presentmentCurrency: resolved.presentmentCurrency } : {}),
    plans: [
      {
        planId: 'monthly',
        interval: 'month',
        currency: displayCur,
        amount: resolved.monthly,
        formattedAmount: formatAmount(resolved.monthly, displayCur),
        trialDays: 0,
        trialEligible,
      },
      {
        planId: 'yearly',
        interval: 'year',
        currency: displayCur,
        amount: resolved.yearly,
        formattedAmount: formatAmount(resolved.yearly, displayCur),
        monthlyEquivalent: formatAmount(Math.round(resolved.yearly / 12), displayCur),
        savingsPercent,
        trialDays,
        trialEligible,
      },
    ],
    // Standard price after early access, in the same currency as the plans.
    // Display only; checkout always charges the plan amounts above.
    standard: {
      monthly: resolved.standardMonthly,
      yearly: resolved.standardYearly,
      formattedMonthly: formatAmount(resolved.standardMonthly, displayCur),
      formattedYearly: formatAmount(resolved.standardYearly, displayCur),
    },
  };
}

module.exports = {
  BASE_CURRENCY,
  MANUAL_AMOUNTS,
  resolveCountry,
  resolvePricing,
  formatAmount,
  pricingBody,
};
