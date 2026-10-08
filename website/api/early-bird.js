// Early Bird & Family Pricing is capped at the first 100 subscribers. This module
// counts the spots taken (GET /api/billing/early-bird) and decides which Stripe
// price checkout sells. Kept free of server.js so it can be tested with a fake
// Stripe client and a fake database (server.js cannot boot under vitest).
//
// A spot is held by a subscription on an early-bird price (STRIPE_PRICE_MONTHLY /
// STRIPE_PRICE_YEARLY, EUR variants first) whose status is active, trialing or
// past_due. Customers in EARLY_BIRD_EXCLUDE_CUSTOMERS (the owner's own test
// subscriptions) never hold one.

const EARLY_BIRD_CAP = 100;
const HOLDING_STATUSES = ['active', 'trialing', 'past_due'];
const HOLDING = new Set(HOLDING_STATUSES);
const CACHE_TTL_MS = 10 * 60_000;      // a Stripe count
const FALLBACK_TTL_MS = 60_000;        // a database count: ask Stripe again soon
const GUARD_MAX_AGE_MS = 60_000;       // checkout never trusts an older count
const EARLY_BIRD_FULL_MESSAGE = 'Early Bird spots are taken; standard pricing opens soon.';

function parseIdList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function earlyBirdPrices(env) {
  return {
    monthly: env.STRIPE_PRICE_MONTHLY_EUR || env.STRIPE_PRICE_MONTHLY || null,
    yearly: env.STRIPE_PRICE_YEARLY_EUR || env.STRIPE_PRICE_YEARLY || null,
  };
}

function standardPrices(env) {
  return {
    monthly: env.STRIPE_PRICE_MONTHLY_STANDARD_EUR || env.STRIPE_PRICE_MONTHLY_STANDARD || null,
    yearly: env.STRIPE_PRICE_YEARLY_STANDARD_EUR || env.STRIPE_PRICE_YEARLY_STANDARD || null,
  };
}

const customerIdOf = (c) => (typeof c === 'string' ? c : c && c.id) || null;

async function countFromStripe(stripe, priceIds, excluded) {
  const held = new Set();
  // One listing per price (the API filters by a single price), every status, so
  // the holding rule is applied here and nowhere else. The SDK auto-paginates.
  for (const price of priceIds) {
    for await (const sub of stripe.subscriptions.list({ price, status: 'all', limit: 100 })) {
      if (!HOLDING.has(sub.status)) continue;
      if (excluded.has(customerIdOf(sub.customer))) continue;
      held.add(sub.id);
    }
  }
  return held.size;
}

async function countFromDb(db, priceIds, excluded) {
  // billing_subscriptions is kept in sync by the Stripe webhooks. The customer id
  // lives on billing_customers, so the exclusion list needs the join.
  const [rows] = await db.execute(
    `SELECT s.stripe_subscription_id AS subscription_id, s.status, c.stripe_customer_id AS customer_id
       FROM billing_subscriptions s
       LEFT JOIN billing_customers c ON c.id = s.billing_customer_id
      WHERE s.status IN (${HOLDING_STATUSES.map((s) => `'${s}'`).join(', ')})
        AND s.stripe_price_id IN (${priceIds.map(() => '?').join(', ')})`,
    priceIds,
  );
  const held = new Set();
  for (const r of rows) {
    if (!HOLDING.has(r.status) || excluded.has(r.customer_id)) continue;
    held.add(r.subscription_id);
  }
  return held.size;
}

/**
 * status({ maxAgeMs }) -> { cap, taken, remaining, source }, cached; throws when
 * neither Stripe nor the database can count. peek() returns the cached answer
 * without counting; invalidate() drops it (subscription webhooks call it).
 */
function createEarlyBirdCounter({
  stripe, getDb, priceIds, excludeCustomers = [], cap = EARLY_BIRD_CAP,
  now = Date.now, ttlMs = CACHE_TTL_MS, fallbackTtlMs = FALLBACK_TTL_MS, log = console,
}) {
  const ids = [...new Set((priceIds || []).filter(Boolean))];
  const excluded = new Set(excludeCustomers);
  let cached = null;   // { value, at, ttl }
  let inflight = null;

  const result = (taken, source) => ({ cap, taken, remaining: Math.max(0, cap - taken), source });

  async function count() {
    if (!ids.length) throw new Error('early-bird price ids are not configured');
    if (stripe) {
      try {
        return { value: result(await countFromStripe(stripe, ids, excluded), 'stripe'), ttl: ttlMs };
      } catch (err) {
        log.warn('[early-bird] Stripe count failed, using the billing tables:', err.message);
      }
    }
    const db = getDb ? getDb() : null;
    if (!db) throw new Error('no database to count early-bird spots');
    return { value: result(await countFromDb(db, ids, excluded), 'database'), ttl: fallbackTtlMs };
  }

  async function status({ maxAgeMs } = {}) {
    if (cached) {
      const age = now() - cached.at;
      if (age < cached.ttl && (maxAgeMs === undefined || age < maxAgeMs)) return cached.value;
    }
    if (!inflight) {
      inflight = count()
        .then(({ value, ttl }) => { cached = { value, at: now(), ttl }; return value; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  return {
    status,
    peek: () => (cached && now() - cached.at < cached.ttl ? cached.value : null),
    invalidate: () => { cached = null; },
  };
}

/** The JSON body of GET /api/billing/early-bird: counts only. */
function publicBody({ cap, taken, remaining }) {
  return { cap, taken, remaining };
}

/** True once every spot is taken. A count that cannot be had keeps today's checkout. */
async function isEarlyBirdFull(counter, log = console) {
  if (!counter) return false;
  try {
    const { cap, taken } = await counter.status({ maxAgeMs: GUARD_MAX_AGE_MS });
    return taken >= cap;
  } catch (err) {
    log.warn('[early-bird] count unavailable, checkout keeps the early-bird price:', err.message);
    return false;
  }
}

/** The Stripe price a checkout for `interval` sells, or why it cannot sell one. */
function checkoutPrice({ interval, full, earlyBird, standard }) {
  if (!full) return { priceId: earlyBird[interval], tier: 'early_bird' };
  if (standard && standard[interval]) return { priceId: standard[interval], tier: 'standard' };
  return { error: 'early_bird_full', message: EARLY_BIRD_FULL_MESSAGE };
}

/** Pricing to quote: the standard amounts once checkout sells the standard prices. */
function pricingFor(resolved, { full, standard }) {
  if (!full || !standard || !standard.monthly || !standard.yearly) return resolved;
  return { ...resolved, monthly: resolved.standardMonthly, yearly: resolved.standardYearly };
}

module.exports = {
  EARLY_BIRD_CAP,
  HOLDING_STATUSES,
  EARLY_BIRD_FULL_MESSAGE,
  parseIdList,
  earlyBirdPrices,
  standardPrices,
  createEarlyBirdCounter,
  publicBody,
  isEarlyBirdFull,
  checkoutPrice,
  pricingFor,
};
