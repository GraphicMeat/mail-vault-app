/**
 * The billingProfile shape a shots run seeds to unlock every premium screen
 * (wdio.screenshots.conf.js, seedFrontendSettings). Exported on its own —
 * rather than left as an inline literal — so the coverage test can feed it
 * straight into the app's own hasPremiumAccess() and assert it actually
 * grants access, instead of merely pattern-matching the seed's source text.
 */
export const PREMIUM_BILLING_PROFILE = { hasSubscription: true, premiumAccess: true, status: 'active' };
