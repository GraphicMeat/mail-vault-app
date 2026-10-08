import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// GET /api/billing/early-bird counts the Early Bird spots that are taken. The
// logic lives in website/api/early-bird.js so it runs here without booting
// server.js. The fakes mirror the calls the module makes: the Stripe SDK's
// auto-paginating subscriptions.list (async iteration) and mysql2's execute.
const require = createRequire(import.meta.url);
const earlyBird = require('../api/early-bird.js');

const EARLY = { monthly: 'price_early_m', yearly: 'price_early_y' };
const STANDARD = { monthly: 'price_std_m', yearly: 'price_std_y' };

const sub = (id, status, price, customer = 'cus_' + id) => ({ id, status, customer, price });

// Fake Stripe: subscriptions.list({ price, status: 'all' }) yields every
// subscription on that price, two per page, like the SDK's auto-pagination.
function fakeStripe(subs, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    subscriptions: {
      list(params) {
        calls.push(params);
        if (fail) {
          return { [Symbol.asyncIterator]() { return { next: () => Promise.reject(new Error('stripe down')) }; } };
        }
        const matching = subs.filter((s) => s.price === params.price).map(({ price, ...s }) => ({
          ...s,
          items: { data: [{ price: { id: price } }] },
        }));
        return {
          async *[Symbol.asyncIterator]() {
            for (let i = 0; i < matching.length; i += 2) {
              await Promise.resolve();
              yield* matching.slice(i, i + 2);
            }
          },
        };
      },
    },
  };
}

// Fake MySQL: applies the WHERE the module sends (status list and price ids in
// the params) to rows shaped like billing_subscriptions JOIN billing_customers.
function fakeDb(rows, { fail = false } = {}) {
  const queries = [];
  return {
    queries,
    execute: async (sql, params) => {
      queries.push({ sql, params });
      if (fail) throw new Error('db down');
      const statuses = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      const out = rows
        .filter((r) => params.includes(r.stripe_price_id) && statuses.includes(r.status))
        .map((r) => ({ subscription_id: r.stripe_subscription_id, status: r.status, customer_id: r.stripe_customer_id, price_id: r.stripe_price_id }));
      return [out, []];
    },
  };
}
const row = (id, status, price, customer = 'cus_' + id) => ({ stripe_subscription_id: id, status, stripe_price_id: price, stripe_customer_id: customer });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const quiet = { warn() {}, error() {} };
const counter = (opts) => earlyBird.createEarlyBirdCounter({ priceIds: [EARLY.monthly, EARLY.yearly], log: quiet, ...opts });

describe('early-bird spot counter', () => {
  it('counts live subscriptions on the early-bird prices from Stripe', async () => {
    const stripe = fakeStripe([
      sub('a', 'active', EARLY.monthly),
      sub('b', 'trialing', EARLY.yearly),
      sub('c', 'past_due', EARLY.yearly),
      sub('d', 'active', EARLY.yearly),
      sub('e', 'active', EARLY.yearly),
    ]);
    const status = await counter({ stripe, getDb: () => fakeDb([]) }).status();
    expect(status).toEqual({ cap: 100, taken: 5, remaining: 95, source: 'stripe' });
    // One listing per early-bird price, every status, so the filter is ours.
    expect(stripe.calls.map((c) => [c.price, c.status])).toEqual([[EARLY.monthly, 'all'], [EARLY.yearly, 'all']]);
  });

  it('holds a spot only while active, trialing or past due', async () => {
    const stripe = fakeStripe(['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused']
      .map((s, i) => sub('s' + i, s, EARLY.yearly)));
    expect((await counter({ stripe }).status()).taken).toBe(3);
  });

  it('counts a subscription once even if both listings return it', async () => {
    const stripe = fakeStripe([sub('a', 'active', EARLY.monthly), sub('a', 'active', EARLY.yearly)]);
    expect((await counter({ stripe }).status()).taken).toBe(1);
  });

  it('ignores subscriptions on other prices', async () => {
    const stripe = fakeStripe([sub('a', 'active', EARLY.monthly), sub('b', 'active', STANDARD.yearly), sub('c', 'active', 'price_other')]);
    expect((await counter({ stripe }).status()).taken).toBe(1);
  });

  it('leaves out the excluded customers', async () => {
    const stripe = fakeStripe([sub('a', 'active', EARLY.monthly, 'cus_owner'), sub('b', 'active', EARLY.yearly, 'cus_test'), sub('c', 'active', EARLY.yearly)]);
    const c = counter({ stripe, excludeCustomers: earlyBird.parseIdList(' cus_owner, cus_test ,,') });
    expect((await c.status()).taken).toBe(1);
  });

  it('reads an expanded customer object as well as a customer id', async () => {
    const stripe = fakeStripe([sub('a', 'active', EARLY.monthly, { id: 'cus_owner' }), sub('b', 'active', EARLY.monthly, { id: 'cus_x' })]);
    expect((await counter({ stripe, excludeCustomers: ['cus_owner'] }).status()).taken).toBe(1);
  });

  it('never reports fewer than zero spots remaining', async () => {
    const subs = Array.from({ length: 103 }, (_, i) => sub('s' + i, 'active', i % 2 ? EARLY.monthly : EARLY.yearly));
    expect(await counter({ stripe: fakeStripe(subs) }).status()).toMatchObject({ cap: 100, taken: 103, remaining: 0 });
  });

  it('caches the Stripe count for 10 minutes', async () => {
    const t = clock();
    const stripe = fakeStripe([sub('a', 'active', EARLY.monthly)]);
    const c = counter({ stripe, now: t.now });
    await c.status();
    t.advance(9 * 60_000);
    await c.status();
    expect(stripe.calls).toHaveLength(2);
    t.advance(60_001);
    await c.status();
    expect(stripe.calls).toHaveLength(4);
  });

  it('shares one Stripe listing between concurrent requests', async () => {
    const stripe = fakeStripe([sub('a', 'active', EARLY.monthly)]);
    const c = counter({ stripe });
    await Promise.all([c.status(), c.status(), c.status()]);
    expect(stripe.calls).toHaveLength(2);
  });

  it('counts again when the caller asks for a fresher answer or the cache is invalidated', async () => {
    const t = clock();
    const stripe = fakeStripe([sub('a', 'active', EARLY.monthly)]);
    const c = counter({ stripe, now: t.now });
    await c.status();
    t.advance(30_000);
    await c.status({ maxAgeMs: 60_000 });
    expect(stripe.calls).toHaveLength(2);
    t.advance(31_000);
    await c.status({ maxAgeMs: 60_000 });
    expect(stripe.calls).toHaveLength(4);
    c.invalidate();
    await c.status();
    expect(stripe.calls).toHaveLength(6);
  });

  it('peeks at the cached answer without counting', async () => {
    const stripe = fakeStripe([sub('a', 'active', EARLY.monthly)]);
    const c = counter({ stripe });
    expect(c.peek()).toBeNull();
    await c.status();
    expect(c.peek()).toMatchObject({ taken: 1, remaining: 99 });
    expect(stripe.calls).toHaveLength(2);
  });

  it('falls back to the billing tables when Stripe is not configured', async () => {
    const db = fakeDb([
      row('a', 'active', EARLY.monthly),
      row('b', 'trialing', EARLY.yearly),
      row('c', 'canceled', EARLY.yearly),
      row('d', 'active', STANDARD.yearly),
      row('e', 'past_due', EARLY.yearly, 'cus_owner'),
    ]);
    const status = await counter({ stripe: null, getDb: () => db, excludeCustomers: ['cus_owner'] }).status();
    expect(status).toEqual({ cap: 100, taken: 2, remaining: 98, source: 'database' });
    expect(db.queries).toHaveLength(1);
    const { sql, params } = db.queries[0];
    // The customer id lives on billing_customers, so the exclusion needs the join.
    expect(sql).toMatch(/FROM billing_subscriptions\b[\s\S]*JOIN billing_customers\b/);
    expect(sql).toMatch(/'active'[\s\S]*'trialing'[\s\S]*'past_due'/);
    expect(params).toEqual([EARLY.monthly, EARLY.yearly]);
  });

  it('falls back to the billing tables when Stripe fails', async () => {
    const status = await counter({ stripe: fakeStripe([], { fail: true }), getDb: () => fakeDb([row('a', 'active', EARLY.yearly)]) }).status();
    expect(status).toEqual({ cap: 100, taken: 1, remaining: 99, source: 'database' });
  });

  it('retries Stripe sooner after a database fallback', async () => {
    const t = clock();
    const stripe = fakeStripe([], { fail: true });
    const c = counter({ stripe, getDb: () => fakeDb([]), now: t.now });
    await c.status();
    t.advance(61_000);
    await c.status();
    expect(stripe.calls).toHaveLength(2);
  });

  it('throws when neither Stripe nor the database can count, and caches nothing', async () => {
    const c = counter({ stripe: fakeStripe([], { fail: true }), getDb: () => fakeDb([], { fail: true }) });
    await expect(c.status()).rejects.toThrow();
    expect(c.peek()).toBeNull();
    await expect(counter({ stripe: null, getDb: null }).status()).rejects.toThrow();
  });

  it('cannot count without early-bird price ids', async () => {
    const c = earlyBird.createEarlyBirdCounter({ priceIds: [undefined, ''], stripe: fakeStripe([]), getDb: () => fakeDb([]), log: quiet });
    await expect(c.status()).rejects.toThrow();
  });
});

describe('public body', () => {
  it('returns counts only', () => {
    expect(earlyBird.publicBody({ cap: 100, taken: 14, remaining: 86, source: 'stripe' })).toEqual({ cap: 100, taken: 14, remaining: 86 });
  });
});

describe('price ids from the environment', () => {
  it('reads the early-bird ids the checkout already sells', () => {
    expect(earlyBird.earlyBirdPrices({ STRIPE_PRICE_MONTHLY_EUR: 'm_eur', STRIPE_PRICE_MONTHLY: 'm', STRIPE_PRICE_YEARLY: 'y' })).toEqual({ monthly: 'm_eur', yearly: 'y' });
  });

  it('reads optional standard ids, EUR variants first', () => {
    expect(earlyBird.standardPrices({})).toEqual({ monthly: null, yearly: null });
    expect(earlyBird.standardPrices({ STRIPE_PRICE_MONTHLY_STANDARD: 'sm', STRIPE_PRICE_YEARLY_STANDARD: 'sy' })).toEqual({ monthly: 'sm', yearly: 'sy' });
    expect(earlyBird.standardPrices({ STRIPE_PRICE_MONTHLY_STANDARD_EUR: 'sme', STRIPE_PRICE_MONTHLY_STANDARD: 'sm', STRIPE_PRICE_YEARLY_STANDARD_EUR: 'sye' })).toEqual({ monthly: 'sme', yearly: 'sye' });
  });

  it('parses the exclusion list', () => {
    expect(earlyBird.parseIdList(undefined)).toEqual([]);
    expect(earlyBird.parseIdList('cus_a, cus_b,,cus_c ')).toEqual(['cus_a', 'cus_b', 'cus_c']);
  });
});

describe('checkout guard', () => {
  const pick = (interval, full, standard = STANDARD) => earlyBird.checkoutPrice({ interval, full, earlyBird: EARLY, standard });

  it('sells the early-bird price unchanged while spots remain', () => {
    expect(pick('monthly', false)).toEqual({ priceId: EARLY.monthly, tier: 'early_bird' });
    expect(pick('yearly', false)).toEqual({ priceId: EARLY.yearly, tier: 'early_bird' });
    expect(pick('yearly', false, { monthly: null, yearly: null })).toEqual({ priceId: EARLY.yearly, tier: 'early_bird' });
  });

  it('switches to the standard price once the spots are taken', () => {
    expect(pick('monthly', true)).toEqual({ priceId: STANDARD.monthly, tier: 'standard' });
    expect(pick('yearly', true)).toEqual({ priceId: STANDARD.yearly, tier: 'standard' });
  });

  it('refuses to sell early bird when the spots are taken and no standard price exists', () => {
    for (const standard of [{ monthly: null, yearly: null }, { monthly: STANDARD.monthly, yearly: null }]) {
      const res = earlyBird.checkoutPrice({ interval: 'yearly', full: true, earlyBird: EARLY, standard });
      expect(res.priceId).toBeUndefined();
      expect(res.error).toBe('early_bird_full');
      expect(res.message).toBe('Early Bird spots are taken; standard pricing opens soon.');
      expect(res.message).not.toMatch(/—/);
    }
  });

  it('treats the cap as reached at exactly 100 taken', async () => {
    const c = (taken) => ({ status: async () => ({ cap: 100, taken, remaining: Math.max(0, 100 - taken) }) });
    expect(await earlyBird.isEarlyBirdFull(c(99), quiet)).toBe(false);
    expect(await earlyBird.isEarlyBirdFull(c(100), quiet)).toBe(true);
    expect(await earlyBird.isEarlyBirdFull(c(140), quiet)).toBe(true);
  });

  it('asks for a count no older than a minute', async () => {
    let asked;
    await earlyBird.isEarlyBirdFull({ status: async (opts) => { asked = opts; return { cap: 100, taken: 1, remaining: 99 }; } }, quiet);
    expect(asked.maxAgeMs).toBeLessThanOrEqual(60_000);
  });

  it('keeps selling as today when the count is unavailable', async () => {
    expect(await earlyBird.isEarlyBirdFull({ status: async () => { throw new Error('down'); } }, quiet)).toBe(false);
    expect(await earlyBird.isEarlyBirdFull(null, quiet)).toBe(false);
  });
});

describe('pricing once the spots are taken', () => {
  const resolved = { currency: 'gbp', pricingMode: 'manual', monthly: 350, yearly: 2100, standardMonthly: 500, standardYearly: 3300 };

  it('quotes the standard amounts when checkout sells the standard price', () => {
    expect(earlyBird.pricingFor(resolved, { full: true, standard: STANDARD })).toEqual({ ...resolved, monthly: 500, yearly: 3300 });
  });

  it('changes nothing while spots remain, or while no standard price is sold', () => {
    expect(earlyBird.pricingFor(resolved, { full: false, standard: STANDARD })).toBe(resolved);
    expect(earlyBird.pricingFor(resolved, { full: true, standard: { monthly: null, yearly: null } })).toBe(resolved);
  });
});

describe('server wiring', () => {
  const server = readFileSync('website/api/server.js', 'utf8');

  it('serves the count on its own rate-limited public route', () => {
    expect(server).toMatch(/app\.get\('\/api\/billing\/early-bird', earlyBirdLimiter,/);
    expect(server).toMatch(/const earlyBirdLimiter = rateLimit\(/);
    expect(server).toMatch(/publicBody: earlyBirdBody/);
    expect(server).toMatch(/res\.json\(earlyBirdBody\(status\)\)/);
  });

  it('guards checkout and pricing with the count', () => {
    expect(server).toMatch(/isEarlyBirdFull\(earlyBirdCounter/);
    expect(server).toMatch(/checkoutPrice\(\{/);
    expect(server).toMatch(/pricingFor\(/);
    expect(server).toMatch(/earlyBirdCounter\.invalidate\(\)/);
  });
});
