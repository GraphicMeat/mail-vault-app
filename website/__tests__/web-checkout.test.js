import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// The web-first purchase path: checkout without an email, the customer row made
// from the webhook, and the one-time token that activates a fresh install.
// The logic lives in website/api/web-billing.js so it runs here without booting
// server.js. The fakes mirror the calls the module makes: mysql2's execute and
// the handful of Stripe SDK calls.
const require = createRequire(import.meta.url);
const web = require('../api/web-billing.js');

const quiet = { warn() {}, error() {} };
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const SESSION = 'cs_test_a1B2c3D4e5F6g7H8i9J0';

// ── fake MySQL ──────────────────────────────────────────────────────────────
function fakeDb({ customers = [], subs = [] } = {}) {
  const state = { customers: [...customers], subs: [...subs], tokens: [], aliases: [], nextId: 100 };
  const lower = (s) => s.replace(/\s+/g, ' ').trim();
  return {
    state,
    execute: async (rawSql, params = []) => {
      const sql = lower(rawSql);
      if (/^SELECT \* FROM billing_customers WHERE stripe_customer_id = \?/.test(sql)) {
        return [state.customers.filter((c) => c.stripe_customer_id === params[0]), []];
      }
      if (/^SELECT \* FROM billing_customers WHERE email = \?/.test(sql)) {
        return [state.customers.filter((c) => c.email === params[0]), []];
      }
      if (/^SELECT bc\.\* FROM billing_customer_aliases a JOIN billing_customers bc ON bc\.id = a\.billing_customer_id WHERE a\.stripe_customer_id = \?/.test(sql)) {
        const a = state.aliases.find((x) => x.stripe_customer_id === params[0]);
        return [a ? state.customers.filter((c) => c.id === a.billing_customer_id) : [], []];
      }
      if (/^INSERT INTO billing_customers \(email, stripe_customer_id\) VALUES \(\?, \?\)$/.test(sql)) {
        const [email, stripeId] = params;
        if (!email) throw new Error('empty email would collide on the UNIQUE key');
        if (state.customers.some((c) => c.email === email || c.stripe_customer_id === stripeId)) {
          throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
        }
        state.customers.push({ id: state.nextId++, email, stripe_customer_id: stripeId });
        return [{ affectedRows: 1 }, undefined];
      }
      if (/^INSERT IGNORE INTO billing_customer_aliases/.test(sql)) {
        if (!state.aliases.some((x) => x.stripe_customer_id === params[0])) state.aliases.push({ stripe_customer_id: params[0], billing_customer_id: params[1] });
        return [{ affectedRows: 1 }, undefined];
      }
      if (/^SELECT id FROM billing_subscriptions WHERE billing_customer_id = \? AND stripe_subscription_id != \?/.test(sql)) {
        return [state.subs.filter((s) => s.billing_customer_id === params[0] && s.stripe_subscription_id !== params[1]).map((s) => ({ id: s.id })), []];
      }
      if (/^INSERT INTO billing_subscriptions/.test(sql)) {
        const [billingCustomerId, subId, priceId, interval, status, premium] = params;
        const prev = state.subs.find((s) => s.stripe_subscription_id === subId);
        const row = { id: prev?.id ?? state.nextId++, billing_customer_id: billingCustomerId, stripe_subscription_id: subId, stripe_price_id: priceId, price_interval: interval, status, premium_access: premium };
        if (prev) Object.assign(prev, row); else state.subs.push(row);
        return [{ affectedRows: 1 }, undefined];
      }
      if (/^DELETE FROM billing_activation_tokens WHERE stripe_session_id = \? AND used_at IS NULL/.test(sql)) {
        const before = state.tokens.length;
        state.tokens = state.tokens.filter((t) => !(t.stripe_session_id === params[0] && t.used_at === null));
        return [{ affectedRows: before - state.tokens.length }, undefined];
      }
      if (/^DELETE FROM billing_activation_tokens WHERE expires_at < \?/.test(sql)) {
        const before = state.tokens.length;
        state.tokens = state.tokens.filter((t) => !(t.expires_at < params[0]));
        return [{ affectedRows: before - state.tokens.length }, undefined];
      }
      if (/^INSERT INTO billing_activation_tokens/.test(sql)) {
        const [hash, session, customerId, expiresAt] = params;
        state.tokens.push({ token_hash: hash, stripe_session_id: session, billing_customer_id: customerId, expires_at: expiresAt, used_at: null });
        return [{ affectedRows: 1 }, undefined];
      }
      if (/^UPDATE billing_activation_tokens SET used_at = \? WHERE token_hash = \? AND used_at IS NULL AND expires_at > \?/.test(sql)) {
        const [usedAt, hash, now] = params;
        const t = state.tokens.find((x) => x.token_hash === hash && x.used_at === null && x.expires_at > now);
        if (t) t.used_at = usedAt;
        return [{ affectedRows: t ? 1 : 0 }, undefined];
      }
      if (/^SELECT bc\.stripe_customer_id, bc\.email FROM billing_activation_tokens t JOIN billing_customers bc ON bc\.id = t\.billing_customer_id WHERE t\.token_hash = \?/.test(sql)) {
        const t = state.tokens.find((x) => x.token_hash === params[0]);
        const c = t && state.customers.find((x) => x.id === t.billing_customer_id);
        return [c ? [{ stripe_customer_id: c.stripe_customer_id, email: c.email }] : [], []];
      }
      throw new Error('fakeDb: unhandled SQL: ' + sql);
    },
  };
}

// ── fake Stripe ─────────────────────────────────────────────────────────────
const sec = (ms) => Math.floor(ms / 1000);
function subscription(over = {}) {
  return {
    id: 'sub_new', customer: 'cus_new', status: 'trialing', cancel_at_period_end: false, canceled_at: null,
    items: { data: [{ price: { id: 'price_y', recurring: { interval: 'year' } }, current_period_start: sec(NOW), current_period_end: sec(NOW + 14 * 864e5) }] },
    ...over,
  };
}
function checkoutSession(over = {}) {
  return {
    id: SESSION, mode: 'subscription', status: 'complete', payment_status: 'no_payment_required',
    created: sec(NOW - 60_000), customer: 'cus_new', subscription: 'sub_new',
    customer_email: null, customer_details: { email: 'Buyer@Example.com' }, metadata: { source: 'web' },
    ...over,
  };
}
function fakeStripe({ session = checkoutSession(), sub = subscription(), customerEmail = 'buyer@example.com', missingSession = false } = {}) {
  const calls = { update: [], customersRetrieve: [], sessionsRetrieve: [] };
  let current = sub;
  return {
    calls,
    checkout: {
      sessions: {
        retrieve: async (id) => {
          calls.sessionsRetrieve.push(id);
          if (missingSession) throw Object.assign(new Error('No such checkout.session'), { code: 'resource_missing' });
          return session;
        },
      },
    },
    subscriptions: {
      retrieve: async () => current,
      update: async (id, params) => {
        calls.update.push([id, params]);
        current = { ...current, status: 'active' };
        return current;
      },
    },
    customers: { retrieve: async (id) => { calls.customersRetrieve.push(id); return { id, email: customerEmail }; } },
  };
}
const priorSub = (customerRowId) => ({ id: 7, billing_customer_id: customerRowId, stripe_subscription_id: 'sub_old', status: 'canceled' });

// ── checkout params ─────────────────────────────────────────────────────────
describe('web checkout session params', () => {
  const base = { priceId: 'price_y', interval: 'yearly', trialDays: 14, successUrl: 'https://mailvaultapp.com/billing-success.html', cancelUrl: 'https://mailvaultapp.com/billing-cancel.html' };

  it('asks Stripe for the email: no customer, no customer_email', () => {
    const p = web.webSessionParams(base);
    expect(p).not.toHaveProperty('customer');
    expect(p).not.toHaveProperty('customer_email');
    // customer_creation is payment-mode only; subscription mode always makes the customer.
    expect(p).not.toHaveProperty('customer_creation');
    expect(p.mode).toBe('subscription');
    expect(p.line_items).toEqual([{ price: 'price_y', quantity: 1 }]);
  });

  it('gives the yearly plan the trial and the monthly plan neither trial nor a missing promo field', () => {
    expect(web.webSessionParams(base).subscription_data).toEqual({ trial_period_days: 14 });
    expect(web.webSessionParams(base).allow_promotion_codes).toBe(false);
    const monthly = web.webSessionParams({ ...base, interval: 'monthly', priceId: 'price_m' });
    expect(monthly).not.toHaveProperty('subscription_data');
    expect(monthly.allow_promotion_codes).toBe(true);
  });

  it('returns the buyer to the welcome page with the session id Stripe fills in', () => {
    expect(web.webSessionParams(base).success_url).toBe('https://mailvaultapp.com/billing-success.html?session_id={CHECKOUT_SESSION_ID}');
    expect(web.webSessionParams({ ...base, successUrl: 'https://x.test/w?a=1' }).success_url).toBe('https://x.test/w?a=1&session_id={CHECKOUT_SESSION_ID}');
    expect(web.webSessionParams(base).cancel_url).toBe(base.cancelUrl);
  });

  it('marks the session as web and keeps only the whitelisted, bounded utm tags', () => {
    const p = web.webSessionParams({ ...base, attribution: { utm_source: 'ads', utm_campaign: 'x'.repeat(900), evil: 'nope', utm_medium: '' } });
    expect(p.metadata.source).toBe('web');
    expect(p.metadata.utm_source).toBe('ads');
    expect(p.metadata.utm_campaign).toHaveLength(500);
    expect(p.metadata).not.toHaveProperty('evil');
    expect(p.metadata).not.toHaveProperty('utm_medium');
  });
});

// ── customer row ────────────────────────────────────────────────────────────
describe('ensureBillingCustomer', () => {
  it('creates the row from the checkout email, lowercased', async () => {
    const db = fakeDb();
    const row = await web.ensureBillingCustomer(db, fakeStripe(), 'cus_new', 'Buyer@Example.com');
    expect(row).toMatchObject({ email: 'buyer@example.com', stripe_customer_id: 'cus_new' });
    expect(db.state.customers).toHaveLength(1);
  });

  it('asks Stripe for the email when the event carries none (subscription event first)', async () => {
    const db = fakeDb();
    const stripe = fakeStripe({ customerEmail: 'later@example.com' });
    const row = await web.ensureBillingCustomer(db, stripe, 'cus_new', '');
    expect(row.email).toBe('later@example.com');
    expect(stripe.calls.customersRetrieve).toEqual(['cus_new']);
  });

  it('writes nothing while the customer has no email yet', async () => {
    const db = fakeDb();
    expect(await web.ensureBillingCustomer(db, fakeStripe({ customerEmail: null }), 'cus_new', '')).toBeNull();
    expect(db.state.customers).toEqual([]);
  });

  it('leaves a known customer alone and never calls Stripe for it', async () => {
    const db = fakeDb({ customers: [{ id: 1, email: 'a@b.c', stripe_customer_id: 'cus_new' }] });
    const stripe = fakeStripe();
    expect((await web.ensureBillingCustomer(db, stripe, 'cus_new', '')).id).toBe(1);
    expect(stripe.calls.customersRetrieve).toEqual([]);
  });

  it('never hands an existing row to another Stripe customer: the email at checkout is unverified', async () => {
    const db = fakeDb({ customers: [{ id: 5, email: 'buyer@example.com', stripe_customer_id: 'cus_old' }], subs: [priorSub(5)] });
    const row = await web.ensureBillingCustomer(db, fakeStripe(), 'cus_new', 'buyer@example.com');
    // The row keeps its owner; the new Stripe customer is only an alias for it.
    expect(row).toMatchObject({ id: 5, stripe_customer_id: 'cus_old' });
    expect(db.state.customers).toMatchObject([{ id: 5, stripe_customer_id: 'cus_old' }]);
    expect(db.state.aliases).toEqual([{ stripe_customer_id: 'cus_new', billing_customer_id: 5 }]);
    expect(db.state.subs[0].billing_customer_id).toBe(5);
  });

  it('finds the same row again through the alias, without asking Stripe or writing twice', async () => {
    const db = fakeDb({ customers: [{ id: 5, email: 'buyer@example.com', stripe_customer_id: 'cus_old' }] });
    const stripe = fakeStripe();
    await web.ensureBillingCustomer(db, stripe, 'cus_new', 'buyer@example.com');
    const again = await web.ensureBillingCustomer(db, stripe, 'cus_new', '');
    expect(again.id).toBe(5);
    expect(db.state.aliases).toHaveLength(1);
    expect(stripe.calls.customersRetrieve).toEqual([]);
  });

  it('survives two events creating the same new customer at once', async () => {
    const db = fakeDb();
    const [a, b] = await Promise.all([
      web.ensureBillingCustomer(db, fakeStripe(), 'cus_new', 'buyer@example.com'),
      web.ensureBillingCustomer(db, fakeStripe(), 'cus_new', 'buyer@example.com'),
    ]);
    expect(a.id).toBe(b.id);
    expect(db.state.customers).toHaveLength(1);
  });
});

// ── checkout.session.completed ──────────────────────────────────────────────
describe('applyCheckoutCompleted', () => {
  it('creates the customer and the subscription for a buyer with no earlier row', async () => {
    const db = fakeDb();
    const stripe = fakeStripe();
    const out = await web.applyCheckoutCompleted({ db, stripe, session: checkoutSession(), log: quiet });
    expect(db.state.customers).toMatchObject([{ email: 'buyer@example.com', stripe_customer_id: 'cus_new' }]);
    expect(db.state.subs).toMatchObject([{ stripe_subscription_id: 'sub_new', status: 'trialing', premium_access: true }]);
    expect(stripe.calls.update).toEqual([]);
    expect(out.trialEnded).toBe(false);
  });

  it('ends the trial of a web buyer whose email already had a subscription', async () => {
    const db = fakeDb({ customers: [{ id: 5, email: 'buyer@example.com', stripe_customer_id: 'cus_old' }], subs: [priorSub(5)] });
    const stripe = fakeStripe();
    const out = await web.applyCheckoutCompleted({ db, stripe, session: checkoutSession(), log: quiet });
    expect(stripe.calls.update).toEqual([['sub_new', { trial_end: 'now' }]]);
    expect(out.trialEnded).toBe(true);
    expect(db.state.subs.find((s) => s.stripe_subscription_id === 'sub_new').status).toBe('active');
  });

  it('attaches a returning buyer\'s new subscription to the existing row, owner unchanged', async () => {
    const db = fakeDb({ customers: [{ id: 5, email: 'buyer@example.com', stripe_customer_id: 'cus_old' }], subs: [priorSub(5)] });
    await web.applyCheckoutCompleted({ db, stripe: fakeStripe(), session: checkoutSession(), log: quiet });
    expect(db.state.customers[0].stripe_customer_id).toBe('cus_old');
    expect(db.state.subs.find((s) => s.stripe_subscription_id === 'sub_new').billing_customer_id).toBe(5);
  });

  it('leaves the trial of the app checkout (email entered first) to the code that decided it', async () => {
    const db = fakeDb({ customers: [{ id: 5, email: 'buyer@example.com', stripe_customer_id: 'cus_new' }], subs: [priorSub(5)] });
    const stripe = fakeStripe();
    await web.applyCheckoutCompleted({ db, stripe, session: checkoutSession({ metadata: {} }), log: quiet });
    expect(stripe.calls.update).toEqual([]);
  });

  it('does nothing on a replay: no second trial_end, no duplicate rows', async () => {
    const db = fakeDb({ customers: [{ id: 5, email: 'buyer@example.com', stripe_customer_id: 'cus_old' }], subs: [priorSub(5)] });
    const stripe = fakeStripe();
    await web.applyCheckoutCompleted({ db, stripe, session: checkoutSession(), log: quiet });
    await web.applyCheckoutCompleted({ db, stripe, session: checkoutSession(), log: quiet });
    expect(stripe.calls.update).toHaveLength(1);
    expect(db.state.subs.filter((s) => s.stripe_subscription_id === 'sub_new')).toHaveLength(1);
    expect(db.state.customers).toHaveLength(1);
  });

  it('keeps the trial when the only other subscription is this one (webhook retry after a partial write)', async () => {
    const db = fakeDb();
    const stripe = fakeStripe();
    await web.applyCheckoutCompleted({ db, stripe, session: checkoutSession(), log: quiet });
    await web.applyCheckoutCompleted({ db, stripe, session: checkoutSession(), log: quiet });
    expect(stripe.calls.update).toEqual([]);
  });

  it('fails loudly, so Stripe retries, when the session has no email anywhere', async () => {
    const db = fakeDb();
    const stripe = fakeStripe({ customerEmail: null });
    await expect(web.applyCheckoutCompleted({ db, stripe, session: checkoutSession({ customer_details: { email: null } }), log: quiet })).rejects.toThrow(/email/i);
    expect(db.state.customers).toEqual([]);
  });

  it('skips anything that is not a subscription checkout', async () => {
    const db = fakeDb();
    expect(await web.applyCheckoutCompleted({ db, stripe: fakeStripe(), session: checkoutSession({ mode: 'payment', subscription: null }), log: quiet })).toBeNull();
    expect(db.state.customers).toEqual([]);
  });
});

// ── activation tokens ───────────────────────────────────────────────────────
describe('mintActivationToken', () => {
  const mint = (db, stripe, sessionId = SESSION, now = NOW) => web.mintActivationToken({ db, stripe, sessionId, now: () => now, log: quiet });

  it('hands out an unguessable token, stores only its hash, and expires it in 15 minutes', async () => {
    const db = fakeDb();
    const out = await mint(db, fakeStripe());
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.expiresAt).toBe(NOW + 15 * 60_000);
    expect(db.state.tokens).toHaveLength(1);
    expect(JSON.stringify(db.state)).not.toContain(out.token);
    expect(db.state.tokens[0].token_hash).toBe(web.hashToken(out.token));
  });

  it('works before the webhook ran: it makes the customer and the subscription itself', async () => {
    const db = fakeDb();
    await mint(db, fakeStripe());
    expect(db.state.customers).toHaveLength(1);
    expect(db.state.subs).toMatchObject([{ stripe_subscription_id: 'sub_new', premium_access: true }]);
  });

  it('keeps one live token per session: a fresh mint voids the unused one', async () => {
    const db = fakeDb();
    const first = await mint(db, fakeStripe());
    const second = await mint(db, fakeStripe());
    expect(second.token).not.toBe(first.token);
    expect(db.state.tokens).toHaveLength(1);
    expect(await web.redeemActivationToken({ db, token: first.token, now: () => NOW })).toBeNull();
    expect(await web.redeemActivationToken({ db, token: second.token, now: () => NOW })).not.toBeNull();
  });

  it.each([
    ['not a session id', 'nope', 'invalid_session', 400],
    ['a payment intent id', 'pi_test_123', 'invalid_session', 400],
  ])('refuses %s without asking Stripe', async (_n, id, code, status) => {
    const stripe = fakeStripe();
    await expect(mint(fakeDb(), stripe, id)).rejects.toMatchObject({ code, status });
    expect(stripe.calls.sessionsRetrieve).toEqual([]);
  });

  it('answers 404 for a session Stripe does not know', async () => {
    await expect(mint(fakeDb(), fakeStripe({ missingSession: true }))).rejects.toMatchObject({ code: 'session_not_found', status: 404 });
  });

  it('refuses a checkout that was not completed and paid for', async () => {
    await expect(mint(fakeDb(), fakeStripe({ session: checkoutSession({ status: 'open' }) }))).rejects.toMatchObject({ code: 'session_incomplete', status: 409 });
    await expect(mint(fakeDb(), fakeStripe({ session: checkoutSession({ payment_status: 'unpaid' }) }))).rejects.toMatchObject({ code: 'session_incomplete', status: 409 });
  });

  it('stops minting once the checkout is a day old', async () => {
    const old = checkoutSession({ created: sec(NOW - 25 * 3600_000) });
    await expect(mint(fakeDb(), fakeStripe({ session: old }))).rejects.toMatchObject({ code: 'session_expired', status: 410 });
  });

  it('sweeps expired tokens', async () => {
    const db = fakeDb();
    db.state.tokens.push({ token_hash: 'old', stripe_session_id: 'cs_test_zzz', billing_customer_id: 1, expires_at: NOW - 2 * 864e5, used_at: null });
    await mint(db, fakeStripe());
    expect(db.state.tokens.find((t) => t.token_hash === 'old')).toBeUndefined();
  });
});

describe('redeemActivationToken for a returning buyer', () => {
  it('signs in as the original customer, whose status now includes the new subscription', async () => {
    const db = fakeDb({ customers: [{ id: 5, email: 'buyer@example.com', stripe_customer_id: 'cus_old' }], subs: [priorSub(5)] });
    const { token } = await web.mintActivationToken({ db, stripe: fakeStripe(), sessionId: SESSION, now: () => NOW, log: quiet });
    expect(await web.redeemActivationToken({ db, token, now: () => NOW })).toEqual({ customerId: 'cus_old', customerEmail: 'buyer@example.com' });
  });
});

describe('redeemActivationToken', () => {
  async function minted() {
    const db = fakeDb();
    const { token } = await web.mintActivationToken({ db, stripe: fakeStripe(), sessionId: SESSION, now: () => NOW, log: quiet });
    return { db, token };
  }

  it('returns who paid, once', async () => {
    const { db, token } = await minted();
    expect(await web.redeemActivationToken({ db, token, now: () => NOW + 1000 })).toEqual({ customerId: 'cus_new', customerEmail: 'buyer@example.com' });
    expect(await web.redeemActivationToken({ db, token, now: () => NOW + 2000 })).toBeNull();
  });

  it('lets exactly one of two simultaneous redeems win', async () => {
    const { db, token } = await minted();
    const [a, b] = await Promise.all([
      web.redeemActivationToken({ db, token, now: () => NOW + 1000 }),
      web.redeemActivationToken({ db, token, now: () => NOW + 1000 }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('refuses an expired token, an unknown token and junk', async () => {
    const { db, token } = await minted();
    expect(await web.redeemActivationToken({ db, token, now: () => NOW + 16 * 60_000 })).toBeNull();
    expect(await web.redeemActivationToken({ db, token: 'A'.repeat(43), now: () => NOW })).toBeNull();
    expect(await web.redeemActivationToken({ db, token: '', now: () => NOW })).toBeNull();
    expect(await web.redeemActivationToken({ db, token: undefined, now: () => NOW })).toBeNull();
    expect(await web.redeemActivationToken({ db, token: { $ne: 1 }, now: () => NOW })).toBeNull();
  });
});

describe('computePremiumAccess', () => {
  it('grants trialing, active and past_due, and a canceled plan until its period ends', () => {
    expect(web.computePremiumAccess('trialing')).toBe(true);
    expect(web.computePremiumAccess('active')).toBe(true);
    expect(web.computePremiumAccess('past_due')).toBe(true);
    expect(web.computePremiumAccess('canceled', false, new Date(Date.now() + 864e5))).toBe(true);
    expect(web.computePremiumAccess('canceled', false, new Date(Date.now() - 864e5))).toBe(false);
    expect(web.computePremiumAccess('incomplete')).toBe(false);
  });
});

// ── server wiring (server.js cannot boot under vitest) ──────────────────────
describe('server wiring', () => {
  const server = readFileSync('website/api/server.js', 'utf8');

  it('takes a checkout with no email and lets Stripe collect it', () => {
    expect(server).toMatch(/const webCheckout = !email;/);
    expect(server).toMatch(/if \(!webCheckout && !isValidEmail\(email\)\)/);
    expect(server).toMatch(/webSessionParams\(/);
  });

  it('answers a plain form post with a redirect to Stripe', () => {
    expect(server).toMatch(/isFormPost\(req\)[\s\S]{0,200}res\.redirect\(303, session\.url\)/);
  });

  it('builds the customer from the webhook, subscription events included', () => {
    expect(server).toMatch(/applyCheckoutCompleted\(\{ db, stripe, session/);
    expect(server).toMatch(/ensureBillingCustomer\(db, stripe, sub\.customer/);
  });

  it('serves the mint and the redeem on rate-limited routes', () => {
    expect(server).toMatch(/app\.post\('\/api\/billing\/activation-token', mutationLimiter, requireBilling/);
    expect(server).toMatch(/app\.post\('\/api\/billing\/activate', mutationLimiter, requireBilling/);
    expect(server).toMatch(/mintActivationToken\(/);
    expect(server).toMatch(/redeemActivationToken\(/);
  });

  it('creates the token table at startup', () => {
    expect(readFileSync('website/api/database.js', 'utf8')).toMatch(/CREATE TABLE IF NOT EXISTS billing_activation_tokens/);
    expect(readFileSync('website/api/database.js', 'utf8')).toMatch(/CREATE TABLE IF NOT EXISTS billing_customer_aliases/);
  });
});

void vi;
