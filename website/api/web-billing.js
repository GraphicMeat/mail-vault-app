// The web-first purchase path: checkout without a pre-entered email, the
// customer row made from the webhook, and the one-time token that activates a
// fresh install. Kept free of server.js so it can be tested with a fake Stripe
// client and a fake database (server.js cannot boot under vitest).
//
// Trial rule: one free yearly trial per customer. The app's checkout knows the
// email before Stripe does, so it decides up front. The web checkout does not,
// so the rule is enforced after payment: a web buyer whose email already had a
// subscription has the trial ended on the spot (trial_end: 'now').

const crypto = require('crypto');

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,}$/;
const TOKEN_TTL_MS = 15 * 60_000;       // long enough to click through to the app, short enough to be worthless later
const SESSION_MAX_AGE_MS = 24 * 3600_000; // a Stripe session id is a bearer credential: stop minting after a day
const SWEEP_AFTER_MS = 24 * 3600_000;
const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'landing'];
const METADATA_VALUE_MAX = 500;         // Stripe's limit per metadata value

class ActivationError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.name = 'ActivationError';
    this.code = code;
    this.status = status;
  }
}

// Whether a Stripe status grants premium access.
function computePremiumAccess(status, cancelAtPeriodEnd, currentPeriodEnd) {
  if (['trialing', 'active', 'past_due'].includes(status)) return true;
  if (status === 'canceled' && currentPeriodEnd && new Date(currentPeriodEnd) > new Date()) return true;
  return false;
}

function attributionMetadata(attribution) {
  const out = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = attribution && attribution[key];
    if (typeof value === 'string' && value) out[key] = value.slice(0, METADATA_VALUE_MAX);
  }
  return out;
}

/**
 * Stripe Checkout params for a buyer who has not given us an email. Stripe asks
 * for it and creates the customer (subscription mode always does; customer_creation
 * is payment-mode only, so it must not be sent).
 */
function webSessionParams({ priceId, interval, trialDays, successUrl, cancelUrl, attribution }) {
  const joiner = successUrl.includes('?') ? '&' : '?';
  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${successUrl}${joiner}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    // Monthly only; the yearly invoice covers 12 months, so a repeating coupon would be a free year.
    allow_promotion_codes: interval === 'monthly',
    metadata: { source: 'web', ...attributionMetadata(attribution) },
  };
  if (interval === 'yearly') params.subscription_data = { trial_period_days: trialDays };
  return params;
}

const emailOf = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

// The row a Stripe customer belongs to: its own, or the one it is an alias of.
async function findBillingCustomer(db, stripeCustomerId) {
  const [own] = await db.execute('SELECT * FROM billing_customers WHERE stripe_customer_id = ?', [stripeCustomerId]);
  if (own.length > 0) return own[0];
  const [aliased] = await db.execute(
    `SELECT bc.* FROM billing_customer_aliases a
     JOIN billing_customers bc ON bc.id = a.billing_customer_id WHERE a.stripe_customer_id = ?`,
    [stripeCustomerId]
  );
  return aliased[0] || null;
}

/**
 * The billing_customers row for a Stripe customer, made when it does not exist
 * yet. The email comes from the event, else from Stripe. Returns null while the
 * customer has no email: nothing is written (an empty email would collide on
 * the UNIQUE key), and the next event carries it.
 *
 * The email typed at Stripe Checkout is unverified, so an existing row is never
 * handed to another Stripe customer: that would let anyone who knows an address
 * take over its portal and its webhook updates. A second Stripe customer with
 * the same email becomes an alias of the existing row instead (its
 * subscriptions attach to that row; the row keeps its owner).
 */
async function ensureBillingCustomer(db, stripe, stripeCustomerId, emailHint) {
  if (!stripeCustomerId) return null;
  const known = await findBillingCustomer(db, stripeCustomerId);
  if (known) return known;

  let email = emailOf(emailHint);
  if (!email) email = emailOf((await stripe.customers.retrieve(stripeCustomerId)).email);
  if (!email) return null;

  const [sameEmail] = await db.execute('SELECT * FROM billing_customers WHERE email = ?', [email]);
  if (sameEmail.length > 0) {
    await db.execute('INSERT IGNORE INTO billing_customer_aliases (stripe_customer_id, billing_customer_id) VALUES (?, ?)', [stripeCustomerId, sameEmail[0].id]);
    return sameEmail[0];
  }
  try {
    await db.execute('INSERT INTO billing_customers (email, stripe_customer_id) VALUES (?, ?)', [email, stripeCustomerId]);
  } catch (err) {
    // A concurrent event made the row first; read it instead of failing the webhook.
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  }
  return (await findBillingCustomer(db, stripeCustomerId))
    || (await db.execute('SELECT * FROM billing_customers WHERE email = ?', [email]))[0][0] || null;
}

// Upsert a subscription from a Stripe object into the database.
async function upsertSubscription(db, stripeCustomerId, sub) {
  const customer = await findBillingCustomer(db, stripeCustomerId);
  if (!customer) return;

  const billingCustomerId = customer.id;
  const priceItem = sub.items?.data?.[0];
  const priceId = priceItem?.price?.id || null;
  const interval = priceItem?.price?.recurring?.interval || null;
  // 2025-03-31.basil moved the billing period off the subscription onto its items. The SDK is
  // pinned to acacia so its own calls still return the old shape; webhooks follow the account's
  // default version, which can be either. Read both.
  const periodStartTs = sub.current_period_start ?? priceItem?.current_period_start;
  const periodEndTs = sub.current_period_end ?? priceItem?.current_period_end;
  const periodStart = periodStartTs ? new Date(periodStartTs * 1000) : null;
  const periodEnd = periodEndTs ? new Date(periodEndTs * 1000) : null;
  const canceledAt = sub.canceled_at ? new Date(sub.canceled_at * 1000) : null;
  const premiumAccess = computePremiumAccess(sub.status, sub.cancel_at_period_end, periodEnd);

  await db.execute(
    `INSERT INTO billing_subscriptions
       (billing_customer_id, stripe_subscription_id, stripe_price_id, price_interval, status, premium_access,
        current_period_start, current_period_end, cancel_at_period_end, canceled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       stripe_price_id = VALUES(stripe_price_id), price_interval = VALUES(price_interval),
       status = VALUES(status), premium_access = VALUES(premium_access),
       current_period_start = VALUES(current_period_start), current_period_end = VALUES(current_period_end),
       cancel_at_period_end = VALUES(cancel_at_period_end), canceled_at = VALUES(canceled_at), updated_at = NOW()`,
    [billingCustomerId, sub.id, priceId, interval, sub.status, premiumAccess, periodStart, periodEnd, !!sub.cancel_at_period_end, canceledAt]
  );
}

async function hadAnotherSubscription(db, billingCustomerId, stripeSubscriptionId) {
  const [rows] = await db.execute(
    'SELECT id FROM billing_subscriptions WHERE billing_customer_id = ? AND stripe_subscription_id != ? LIMIT 1',
    [billingCustomerId, stripeSubscriptionId]
  );
  return rows.length > 0;
}

// Ends the trial now. A concurrent run (webhook and activation mint) may get there
// first; a subscription that is no longer trialing is the outcome we wanted.
async function endTrial(stripe, sub) {
  try {
    return await stripe.subscriptions.update(sub.id, { trial_end: 'now' });
  } catch (err) {
    const fresh = await stripe.subscriptions.retrieve(sub.id);
    if (fresh.status !== 'trialing') return fresh;
    throw err;
  }
}

/**
 * checkout.session.completed: make the customer row, store the subscription, and
 * hold a web buyer to one trial. Idempotent, so the webhook and the activation
 * mint can both run it. Returns null for a session that is not a subscription.
 */
async function applyCheckoutCompleted({ db, stripe, session, log = console }) {
  if (session.mode !== 'subscription' || !session.subscription) return null;
  const hint = session.customer_email || session.customer_details?.email;
  const customer = await ensureBillingCustomer(db, stripe, session.customer, hint);
  if (!customer) throw new Error(`checkout session ${session.id} has no email for customer ${session.customer}`);

  let sub = await stripe.subscriptions.retrieve(session.subscription);
  let trialEnded = false;
  if (session.metadata?.source === 'web' && sub.status === 'trialing' && await hadAnotherSubscription(db, customer.id, sub.id)) {
    sub = await endTrial(stripe, sub);
    trialEnded = true;
    log.warn(`[billing] web checkout ${session.id}: ${customer.email} already had a subscription, trial ended`);
  }
  await upsertSubscription(db, session.customer, sub);
  return { customer, sub, trialEnded };
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Mints the one-time token the welcome page turns into a mailvault:// link.
 * Authority is the Stripe session id from success_url; it must be a completed,
 * paid (or trialing) subscription checkout under a day old. Safe to run before
 * the webhook: it makes the customer and subscription itself. One live token per
 * session; a new mint voids the previous unused one.
 */
async function mintActivationToken({ db, stripe, sessionId, now = Date.now, log = console }) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    throw new ActivationError('invalid_session', 400, 'Not a checkout session id.');
  }
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    if (err.code === 'resource_missing') throw new ActivationError('session_not_found', 404, 'No such checkout session.');
    throw err;
  }
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (session.mode !== 'subscription' || session.status !== 'complete' || !paid) {
    throw new ActivationError('session_incomplete', 409, 'Checkout is not complete.');
  }
  const t = now();
  if (t - session.created * 1000 > SESSION_MAX_AGE_MS) {
    throw new ActivationError('session_expired', 410, 'This checkout is too old to activate from.');
  }

  const applied = await applyCheckoutCompleted({ db, stripe, session, log });
  if (!applied) throw new ActivationError('session_incomplete', 409, 'Checkout is not a subscription.');
  // The email typed at Checkout is unverified. When the payer is only an alias of
  // an existing row, a token for that row would hand them its Stripe customer id
  // (and with it its billing portal), so they sign in with the email instead.
  if (applied.customer.stripe_customer_id !== session.customer) {
    throw new ActivationError('verification_required', 409, 'Sign in with the email you already use.');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await db.execute('DELETE FROM billing_activation_tokens WHERE expires_at < ?', [new Date(t - SWEEP_AFTER_MS)]);
  await db.execute('DELETE FROM billing_activation_tokens WHERE stripe_session_id = ? AND used_at IS NULL', [sessionId]);
  const expiresAt = t + TOKEN_TTL_MS;
  await db.execute(
    'INSERT INTO billing_activation_tokens (token_hash, stripe_session_id, billing_customer_id, expires_at) VALUES (?, ?, ?, ?)',
    [hashToken(token), sessionId, applied.customer.id, new Date(expiresAt)]
  );
  return { token, expiresAt };
}

/**
 * Spends a token. Returns who paid, or null when the token is unknown, expired
 * or already used. The single UPDATE is the lock: only one caller sees
 * affectedRows 1.
 */
async function redeemActivationToken({ db, token, now = Date.now }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  const hash = hashToken(token);
  const t = now();
  const [result] = await db.execute(
    'UPDATE billing_activation_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    [new Date(t), hash, new Date(t)]
  );
  if (!result || result.affectedRows !== 1) return null;
  const [rows] = await db.execute(
    `SELECT bc.stripe_customer_id, bc.email FROM billing_activation_tokens t
     JOIN billing_customers bc ON bc.id = t.billing_customer_id WHERE t.token_hash = ?`,
    [hash]
  );
  if (rows.length === 0) return null;
  return { customerId: rows[0].stripe_customer_id, customerEmail: rows[0].email };
}

module.exports = {
  ActivationError,
  TOKEN_TTL_MS,
  computePremiumAccess,
  webSessionParams,
  ensureBillingCustomer,
  upsertSubscription,
  applyCheckoutCompleted,
  hashToken,
  mintActivationToken,
  redeemActivationToken,
};
