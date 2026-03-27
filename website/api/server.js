// Load .env from multiple possible locations
const fs = require('fs');
const pathMod = require('path');
function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const val = trimmed.substring(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    return true;
  } catch { return false; }
}
// Try: same dir as server.js, then project root
loadEnvFile(pathMod.join(__dirname, '.env')) ||
loadEnvFile(pathMod.join(process.cwd(), '.env')) ||
loadEnvFile('/home/u369747114/domains/mailvaultapp.com/.env');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }
let stripe;
try { stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null; } catch { stripe = null; }
const path = require('path');
const { getPool, initDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;
let dbError = null;

// Email transporter (configured via env vars)
const transporter = (nodemailer && process.env.SMTP_HOST) ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: (parseInt(process.env.SMTP_PORT) || 465) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
}) : null;

// ===========================================
// Middleware
// ===========================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS - allow requests from your website
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Parse JSON bodies — skip for Stripe webhook (needs raw body for signature verification)
app.use((req, res, next) => {
  if (req.originalUrl === '/api/billing/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

// Stricter rate limit for voting
const voteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many votes, please try again later.' }
});

// Strict rate limit for contact form
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many messages. Please try again later.' }
});

// ===========================================
// Helper: Get client IP
// ===========================================
function getClientIP(req) {
  return req.ip ||
         req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.connection?.remoteAddress ||
         'unknown';
}

// ===========================================
// Serve Static Website
// ===========================================
app.use(express.static(path.join(__dirname, '..'), {
  index: 'index.html'
}));

// ===========================================
// API Routes
// ===========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// -------------------------------------------
// "I Want This" Votes
// -------------------------------------------

// Get total vote count
app.get('/api/votes', async (req, res) => {
  try {
    const db = getPool();
    const [rows] = await db.execute('SELECT COUNT(*) as count FROM votes');
    res.json({ count: rows[0].count });
  } catch (error) {
    console.error('Error getting votes:', error);
    res.status(500).json({ error: 'Failed to get vote count' });
  }
});

// Submit a vote
app.post('/api/votes', voteLimiter, async (req, res) => {
  try {
    const db = getPool();
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'] || '';
    const ipHash = hashIP(ip);

    // Check if already voted (by IP)
    const [existing] = await db.execute('SELECT id FROM votes WHERE ip_hash = ?', [ipHash]);

    if (existing.length > 0) {
      const [rows] = await db.execute('SELECT COUNT(*) as count FROM votes');
      return res.json({ count: rows[0].count, alreadyVoted: true });
    }

    // Insert new vote
    await db.execute(
      'INSERT INTO votes (ip_hash, user_agent) VALUES (?, ?)',
      [ipHash, userAgent]
    );

    const [rows] = await db.execute('SELECT COUNT(*) as count FROM votes');
    res.json({ count: rows[0].count, alreadyVoted: false });
  } catch (error) {
    console.error('Error submitting vote:', error);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

// -------------------------------------------
// Feature Voting
// -------------------------------------------

// Get all features with vote counts
app.get('/api/features', async (req, res) => {
  try {
    const db = getPool();
    const [features] = await db.execute(`
      SELECT
        f.id,
        f.name,
        f.description,
        COUNT(fv.id) as votes
      FROM features f
      LEFT JOIN feature_votes fv ON f.id = fv.feature_id
      GROUP BY f.id, f.name, f.description
      ORDER BY votes DESC, f.id ASC
    `);
    res.json(features);
  } catch (error) {
    console.error('Error getting features:', error);
    res.status(500).json({ error: 'Failed to get features' });
  }
});

// Vote for a feature
app.post('/api/features/:id/vote', voteLimiter, async (req, res) => {
  try {
    const db = getPool();
    const featureId = parseInt(req.params.id);
    const ip = getClientIP(req);
    const ipHash = hashIP(ip);

    // Check if feature exists
    const [feature] = await db.execute('SELECT id FROM features WHERE id = ?', [featureId]);
    if (feature.length === 0) {
      return res.status(404).json({ error: 'Feature not found' });
    }

    // Check if already voted for this feature (by IP)
    const [existing] = await db.execute(
      'SELECT id FROM feature_votes WHERE feature_id = ? AND ip_hash = ?',
      [featureId, ipHash]
    );

    if (existing.length > 0) {
      return res.json({ success: true, alreadyVoted: true });
    }

    // Insert vote
    await db.execute(
      'INSERT INTO feature_votes (feature_id, ip_hash) VALUES (?, ?)',
      [featureId, ipHash]
    );

    res.json({ success: true, alreadyVoted: false });
  } catch (error) {
    console.error('Error voting for feature:', error);
    res.status(500).json({ error: 'Failed to vote for feature' });
  }
});

// -------------------------------------------
// Newsletter Subscription
// -------------------------------------------

app.post('/api/subscribe', async (req, res) => {
  try {
    const db = getPool();
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    // Check if already subscribed
    const [existing] = await db.execute('SELECT id FROM subscribers WHERE email = ?', [email.toLowerCase()]);

    if (existing.length > 0) {
      return res.json({ success: true, message: 'Already subscribed' });
    }

    // Insert subscriber
    await db.execute(
      'INSERT INTO subscribers (email, ip_hash) VALUES (?, ?)',
      [email.toLowerCase(), hashIP(getClientIP(req))]
    );

    // Send emails
    if (transporter && process.env.SMTP_USER) {
      if (process.env.NOTIFY_EMAIL) {
        transporter.sendMail({
          from: `"MailVault" <${process.env.SMTP_USER}>`,
          to: process.env.NOTIFY_EMAIL,
          subject: '[MailVault] New subscriber',
          text: `New newsletter subscriber: ${email}`,
          html: `<p>New newsletter subscriber: <strong>${email}</strong></p><p>Subscribed at: ${new Date().toISOString()}</p>`
        }).catch(err => console.error('Failed to send subscriber notification:', err));
      }

      transporter.sendMail({
        from: `"MailVault" <${process.env.SMTP_USER}>`,
        to: email.toLowerCase(),
        subject: 'Welcome to MailVault updates!',
        text: `Thanks for subscribing to MailVault updates!\n\nYou'll be the first to know about new releases, features, and tips.\n\nIn the meantime:\n- Download MailVault: https://mailvaultapp.com\n- Source code: https://github.com/GraphicMeat/mail-vault-app\n- Join the discussion: https://github.com/GraphicMeat/mail-vault-app/discussions\n\n— The MailVault Team`,
        html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto;">
  <h2 style="color: #6366f1;">Welcome to MailVault!</h2>
  <p>Thanks for subscribing. You'll be the first to know about new releases, features, and tips.</p>
  <p>In the meantime:</p>
  <ul>
    <li><a href="https://mailvaultapp.com" style="color: #6366f1;">Download MailVault</a></li>
    <li><a href="https://github.com/GraphicMeat/mail-vault-app" style="color: #6366f1;">Source code on GitHub</a></li>
    <li><a href="https://github.com/GraphicMeat/mail-vault-app/discussions" style="color: #6366f1;">Join the discussion</a></li>
  </ul>
  <p style="color: #94a3b8; font-size: 14px;">— The MailVault Team</p>
</div>`
      }).catch(err => console.error('Failed to send welcome email:', err));
    }

    res.json({ success: true, message: 'Subscribed successfully' });
  } catch (error) {
    console.error('Error subscribing:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// -------------------------------------------
// Contact Form
// -------------------------------------------

app.post('/api/contact', contactLimiter, async (req, res) => {
  try {
    const db = getPool();
    const { name, email, category, message, website: honeypot, _t } = req.body;

    // Honeypot: if the hidden field is filled, it's a bot
    if (honeypot) {
      return res.json({ success: true, message: 'Message sent successfully' });
    }

    // Timing: reject if submitted faster than 3 seconds
    if (_t && (Date.now() - parseInt(_t)) < 3000) {
      return res.json({ success: true, message: 'Message sent successfully' });
    }

    // Validation
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    // Insert contact message
    await db.execute(
      'INSERT INTO contacts (name, email, category, message, ip_hash) VALUES (?, ?, ?, ?, ?)',
      [name, email.toLowerCase(), category || 'other', message, hashIP(getClientIP(req))]
    );

    // Send email notification
    if (transporter && process.env.NOTIFY_EMAIL) {
      transporter.sendMail({
        from: `"MailVault Contact" <${process.env.SMTP_USER}>`,
        to: process.env.NOTIFY_EMAIL,
        replyTo: email,
        subject: `[MailVault] ${category || 'general'}: New message from ${name}`,
        text: `Name: ${name}\nEmail: ${email}\nCategory: ${category || 'general'}\n\nMessage:\n${message}`,
        html: `<p><strong>Name:</strong> ${name}</p>
<p><strong>Email:</strong> ${email}</p>
<p><strong>Category:</strong> ${category || 'general'}</p>
<hr>
<p>${message.replace(/\n/g, '<br>')}</p>`
      }).catch(err => console.error('Failed to send notification email:', err));
    }

    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error submitting contact:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ===========================================
// Billing Routes (Stripe)
// ===========================================

// Route-specific rate limiters so status polling cannot block checkout/portal
const statusLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many status checks. Please try again shortly.' },
});
const mutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many billing requests. Please try again later.' },
});
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many checkout requests. Please try again later.' },
});

// In-memory billing status cache (key: customerId or email, TTL: 15s)
const _billingCache = new Map();
const BILLING_CACHE_TTL = 15_000;
function getCachedBilling(key) {
  const entry = _billingCache.get(key);
  if (entry && Date.now() - entry.ts < BILLING_CACHE_TTL) return entry.data;
  _billingCache.delete(key);
  return null;
}
function setCachedBilling(key, data) {
  _billingCache.set(key, { data, ts: Date.now() });
  // Evict old entries periodically
  if (_billingCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _billingCache) { if (now - v.ts > BILLING_CACHE_TTL) _billingCache.delete(k); }
  }
}

function requireBilling(req, res, next) {
  if (!stripe) return res.status(503).json({ error: 'billing_unavailable', message: 'Billing service is not configured.' });
  if (dbError) return res.status(503).json({ error: 'database_unavailable', message: 'Database is not available. Please try again later.' });
  next();
}

// Compute whether a Stripe status grants premium access
function computePremiumAccess(status, cancelAtPeriodEnd, currentPeriodEnd) {
  if (['trialing', 'active', 'past_due'].includes(status)) return true;
  if (status === 'canceled' && currentPeriodEnd && new Date(currentPeriodEnd) > new Date()) return true;
  return false;
}

// ── Multi-currency pricing ──────────────────────────────────────────────────
// Each supported currency has a monthly + yearly Stripe price ID pair.
// Env vars: STRIPE_PRICES_<CURRENCY>_MONTHLY / _YEARLY (fallback to single STRIPE_PRICE_MONTHLY/YEARLY for USD)
function loadPricingTable() {
  const table = {};
  const currencies = (process.env.STRIPE_SUPPORTED_CURRENCIES || 'usd,eur,gbp').split(',').map(c => c.trim().toLowerCase());
  for (const cur of currencies) {
    const upper = cur.toUpperCase();
    const monthly = process.env[`STRIPE_PRICES_${upper}_MONTHLY`] || (cur === 'usd' ? process.env.STRIPE_PRICE_MONTHLY : null);
    const yearly = process.env[`STRIPE_PRICES_${upper}_YEARLY`] || (cur === 'usd' ? process.env.STRIPE_PRICE_YEARLY : null);
    const monthlyAmount = parseInt(process.env[`STRIPE_PRICES_${upper}_MONTHLY_AMOUNT`] || (cur === 'usd' ? '300' : '0'), 10);
    const yearlyAmount = parseInt(process.env[`STRIPE_PRICES_${upper}_YEARLY_AMOUNT`] || (cur === 'usd' ? '2500' : '0'), 10);
    if (monthly && yearly) {
      table[cur] = { monthly: { priceId: monthly, amount: monthlyAmount }, yearly: { priceId: yearly, amount: yearlyAmount } };
    }
  }
  // Ensure USD is always present as fallback
  if (!table.usd && process.env.STRIPE_PRICE_MONTHLY && process.env.STRIPE_PRICE_YEARLY) {
    table.usd = { monthly: { priceId: process.env.STRIPE_PRICE_MONTHLY, amount: 300 }, yearly: { priceId: process.env.STRIPE_PRICE_YEARLY, amount: 2500 } };
  }
  return table;
}
const PRICING_TABLE = loadPricingTable();
const DEFAULT_CURRENCY = 'usd';

// Map country code to likely currency
const COUNTRY_CURRENCY = {
  US: 'usd', GB: 'gbp', UK: 'gbp',
  AT: 'eur', BE: 'eur', CY: 'eur', DE: 'eur', EE: 'eur', ES: 'eur', FI: 'eur', FR: 'eur',
  GR: 'eur', IE: 'eur', IT: 'eur', LT: 'eur', LU: 'eur', LV: 'eur', MT: 'eur', NL: 'eur',
  PT: 'eur', SI: 'eur', SK: 'eur', HR: 'eur',
};

function resolveCurrency(requestedCurrency, countryHint, acceptLanguage) {
  // 1. Explicit request
  if (requestedCurrency) {
    const c = requestedCurrency.toLowerCase();
    if (PRICING_TABLE[c]) return { currency: c, source: 'requested' };
  }
  // 2. Country hint (from query param or CF/IP header)
  if (countryHint) {
    const mapped = COUNTRY_CURRENCY[countryHint.toUpperCase()];
    if (mapped && PRICING_TABLE[mapped]) return { currency: mapped, source: 'country' };
  }
  // 3. Accept-Language header heuristic
  if (acceptLanguage) {
    const match = acceptLanguage.match(/[a-z]{2}-([A-Z]{2})/);
    if (match) {
      const mapped = COUNTRY_CURRENCY[match[1]];
      if (mapped && PRICING_TABLE[mapped]) return { currency: mapped, source: 'locale' };
    }
  }
  // 4. Fallback to USD
  return { currency: DEFAULT_CURRENCY, source: 'default' };
}

function formatAmount(amount, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 0, maximumFractionDigits: 2 })
      .format(amount / 100);
  } catch { return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`; }
}

// GET /api/billing/pricing — returns available plans for detected currency
app.get('/api/billing/pricing', statusLimiter, (req, res) => {
  const { currency: reqCurrency, country } = req.query;
  const cfCountry = req.headers['cf-ipcountry']; // Cloudflare geo header
  const { currency, source } = resolveCurrency(reqCurrency, country || cfCountry, req.headers['accept-language']);
  const plans = PRICING_TABLE[currency];

  if (!plans) {
    return res.status(503).json({ error: 'pricing_unavailable', message: 'No pricing available.' });
  }

  const monthlyFormatted = formatAmount(plans.monthly.amount, currency);
  const yearlyFormatted = formatAmount(plans.yearly.amount, currency);
  const monthlyEquiv = formatAmount(Math.round(plans.yearly.amount / 12), currency);
  const savingsPercent = plans.monthly.amount > 0
    ? Math.round((1 - (plans.yearly.amount / 12) / plans.monthly.amount) * 100)
    : 0;

  res.json({
    currency,
    currencySource: source,
    supportedCurrencies: Object.keys(PRICING_TABLE),
    plans: [
      {
        planId: `${currency}_monthly`,
        interval: 'month',
        currency,
        amount: plans.monthly.amount,
        formattedAmount: monthlyFormatted,
        priceId: plans.monthly.priceId,
      },
      {
        planId: `${currency}_yearly`,
        interval: 'year',
        currency,
        amount: plans.yearly.amount,
        formattedAmount: yearlyFormatted,
        priceId: plans.yearly.priceId,
        monthlyEquivalent: monthlyEquiv,
        savingsPercent,
      },
    ],
  });
});

// POST /api/billing/checkout-session
app.post('/api/billing/checkout-session', checkoutLimiter, requireBilling, async (req, res) => {
  try {
    const { email, priceType, planId, currency: reqCurrency } = req.body;
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Valid email required.' });

    // Resolve the price ID: prefer planId, fall back to priceType + currency resolution
    let priceId;
    if (planId) {
      // planId format: "eur_monthly" or "gbp_yearly"
      const [cur, interval] = planId.split('_');
      const plans = PRICING_TABLE[cur];
      priceId = plans?.[interval]?.priceId;
    }
    if (!priceId && priceType) {
      if (!['monthly', 'yearly'].includes(priceType)) return res.status(400).json({ error: 'priceType must be monthly or yearly.' });
      const { currency } = resolveCurrency(reqCurrency, req.headers['cf-ipcountry'], req.headers['accept-language']);
      const plans = PRICING_TABLE[currency];
      priceId = plans?.[priceType]?.priceId;
    }
    if (!priceId) return res.status(400).json({ error: 'billing_unavailable', message: 'Could not resolve price. Please try again.' });

    const db = getPool();

    // Find or create Stripe customer
    let customerId;
    const [existing] = await db.execute('SELECT stripe_customer_id FROM billing_customers WHERE email = ?', [email.toLowerCase()]);
    if (existing.length > 0) {
      customerId = existing[0].stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({ email: email.toLowerCase() });
      customerId = customer.id;
      await db.execute('INSERT INTO billing_customers (email, stripe_customer_id) VALUES (?, ?)', [email.toLowerCase(), customerId]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: process.env.BILLING_SUCCESS_URL || 'https://mailvaultapp.com/billing-success.html',
      cancel_url: process.env.BILLING_CANCEL_URL || 'https://mailvaultapp.com/billing-cancel.html',
      allow_promotion_codes: true,
    });

    res.json({ url: session.url, customerId });
  } catch (error) {
    console.error('[billing/checkout-session]', error.message);
    res.status(500).json({ error: 'checkout_failed', message: 'Could not create checkout session. Please try again.' });
  }
});

// POST /api/billing/portal-session
app.post('/api/billing/portal-session', checkoutLimiter, requireBilling, async (req, res) => {
  try {
    const { customerId, email } = req.body;
    let stripeCustomerId = customerId;

    // Fallback: look up by email if customerId not provided
    if (!stripeCustomerId && email) {
      const db = getPool();
      const [rows] = await db.execute('SELECT stripe_customer_id FROM billing_customers WHERE email = ?', [email.toLowerCase()]);
      if (rows.length > 0) stripeCustomerId = rows[0].stripe_customer_id;
    }

    if (!stripeCustomerId) return res.status(404).json({ error: 'No billing customer found.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: process.env.BILLING_SUCCESS_URL || 'https://mailvaultapp.com/',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('[billing/portal-session]', error.message);
    res.status(500).json({ error: 'portal_failed', message: 'Could not open billing portal. Please try again.' });
  }
});

// Helper: get active clients for a billing customer (non-revoked, seen within 30 days)
async function getActiveClients(db, billingCustomerId) {
  const [rows] = await db.execute(
    `SELECT id, client_id, client_name, platform, app_version, os_version, first_seen_at, last_seen_at
     FROM billing_clients
     WHERE billing_customer_id = ? AND revoked_at IS NULL AND last_seen_at >= NOW() - INTERVAL 30 DAY
     ORDER BY last_seen_at DESC`,
    [billingCustomerId]
  );
  return rows;
}

const CLIENT_LIMIT = 5;

// GET /api/billing/subscription-status
// Supports ?register=1&clientName=...&platform=...&appVersion=...&osVersion=... to combine
// status check + client registration in one round trip.
app.get('/api/billing/subscription-status', statusLimiter, async (req, res) => {
  try {
    const { customerId, email, clientId, register, clientName, platform, appVersion, osVersion } = req.query;
    if (!customerId && !email) return res.status(400).json({ error: 'customerId or email required.' });

    // Check in-memory cache (same customer+client pair within TTL → return cached)
    const cacheKey = `${customerId || ''}:${(email || '').toLowerCase()}:${clientId || ''}`;
    if (!register) {
      const cached = getCachedBilling(cacheKey);
      if (cached) return res.json(cached);
    }

    const db = getPool();
    let customerRow;

    if (customerId) {
      const [rows] = await db.execute('SELECT * FROM billing_customers WHERE stripe_customer_id = ?', [customerId]);
      customerRow = rows[0];
    }
    if (!customerRow && email) {
      const [rows] = await db.execute('SELECT * FROM billing_customers WHERE email = ?', [email.toLowerCase()]);
      customerRow = rows[0];
    }

    const noSubBase = {
      customerId: customerRow?.stripe_customer_id || null,
      customerEmail: customerRow?.email || email || null,
      hasSubscription: false, status: null, priceId: null, interval: null,
      currentPeriodEnd: null, cancelAtPeriodEnd: false, premiumAccess: false,
      clientLimit: CLIENT_LIMIT, activeClientCount: 0, activeClients: [],
      currentClientId: clientId || null, clientAccessGranted: false,
    };

    if (!customerRow) { setCachedBilling(cacheKey, noSubBase); return res.json(noSubBase); }

    const [subs] = await db.execute(
      `SELECT * FROM billing_subscriptions WHERE billing_customer_id = ? ORDER BY current_period_end DESC LIMIT 1`,
      [customerRow.id]
    );

    if (subs.length === 0) { setCachedBilling(cacheKey, noSubBase); return res.json(noSubBase); }

    const sub = subs[0];
    const premiumAccess = computePremiumAccess(sub.status, sub.cancel_at_period_end, sub.current_period_end);
    let replacedClient = null;

    if (clientId) {
      // Update last_seen_at for existing active client
      await db.execute(
        `UPDATE billing_clients SET last_seen_at = NOW() WHERE billing_customer_id = ? AND client_id = ? AND revoked_at IS NULL`,
        [customerRow.id, clientId]
      );

      // Unified register: if register=1 and premium, auto-register this client
      if (register === '1' && premiumAccess) {
        const [existingClient] = await db.execute(
          `SELECT * FROM billing_clients WHERE billing_customer_id = ? AND client_id = ?`,
          [customerRow.id, clientId]
        );

        if (existingClient.length > 0) {
          // Reactivate if revoked, update metadata
          await db.execute(
            `UPDATE billing_clients SET client_name = COALESCE(?, client_name), platform = COALESCE(?, platform),
             app_version = COALESCE(?, app_version), os_version = COALESCE(?, os_version),
             last_seen_at = NOW(), revoked_at = NULL
             WHERE billing_customer_id = ? AND client_id = ?`,
            [clientName || null, platform || null, appVersion || null, osVersion || null, customerRow.id, clientId]
          );
        } else {
          // New client — check limit and insert
          const currentActive = await getActiveClients(db, customerRow.id);
          if (currentActive.length >= CLIENT_LIMIT) {
            const oldest = currentActive[currentActive.length - 1];
            await db.execute(
              `UPDATE billing_clients SET revoked_at = NOW() WHERE billing_customer_id = ? AND client_id = ?`,
              [customerRow.id, oldest.client_id]
            );
            replacedClient = { clientId: oldest.client_id, clientName: oldest.client_name, platform: oldest.platform, lastSeenAt: oldest.last_seen_at };
          }
          await db.execute(
            `INSERT INTO billing_clients (billing_customer_id, client_id, client_name, platform, app_version, os_version)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [customerRow.id, clientId, clientName || null, platform || null, appVersion || null, osVersion || null]
          );
        }
      }
    }

    const activeClients = await getActiveClients(db, customerRow.id);
    const clientInList = clientId ? activeClients.some(c => c.client_id === clientId) : false;

    const result = {
      customerId: customerRow.stripe_customer_id,
      customerEmail: customerRow.email,
      hasSubscription: true,
      status: sub.status,
      priceId: sub.stripe_price_id,
      interval: sub.price_interval || null,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      premiumAccess,
      clientLimit: CLIENT_LIMIT,
      activeClientCount: activeClients.length,
      activeClients: activeClients.map(c => ({
        clientId: c.client_id, clientName: c.client_name, platform: c.platform,
        appVersion: c.app_version, osVersion: c.os_version,
        firstSeenAt: c.first_seen_at, lastSeenAt: c.last_seen_at,
      })),
      currentClientId: clientId || null,
      clientAccessGranted: premiumAccess && clientInList,
      ...(replacedClient ? { replacedClient } : {}),
    };

    setCachedBilling(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('[billing/subscription-status]', error.message);
    res.status(500).json({ error: 'status_failed', message: 'Could not check subscription status. Please try again.' });
  }
});

// POST /api/billing/register-client
app.post('/api/billing/register-client', mutationLimiter, requireBilling, async (req, res) => {
  try {
    const { customerId, email, clientId, clientName, platform, appVersion, osVersion } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId is required.' });
    if (!customerId && !email) return res.status(400).json({ error: 'customerId or email required.' });

    const db = getPool();
    let customerRow;

    if (customerId) {
      const [rows] = await db.execute('SELECT * FROM billing_customers WHERE stripe_customer_id = ?', [customerId]);
      customerRow = rows[0];
    }
    if (!customerRow && email) {
      const [rows] = await db.execute('SELECT * FROM billing_customers WHERE email = ?', [email.toLowerCase()]);
      customerRow = rows[0];
    }

    if (!customerRow) return res.status(404).json({ error: 'customer_not_found', message: 'No billing customer found.' });

    // Check for active premium subscription
    const [subs] = await db.execute(
      `SELECT * FROM billing_subscriptions WHERE billing_customer_id = ? ORDER BY current_period_end DESC LIMIT 1`,
      [customerRow.id]
    );

    if (subs.length === 0 || !computePremiumAccess(subs[0].status, subs[0].cancel_at_period_end, subs[0].current_period_end)) {
      return res.status(403).json({ error: 'no_premium', message: 'An active premium subscription is required to register a client.' });
    }

    const sub = subs[0];
    const billingCustomerId = customerRow.id;

    // Check if this client is already registered (even if revoked)
    const [existingClient] = await db.execute(
      `SELECT * FROM billing_clients WHERE billing_customer_id = ? AND client_id = ?`,
      [billingCustomerId, clientId]
    );

    let replacedClient = null;

    if (existingClient.length > 0) {
      // Client already registered — update it (reactivate if revoked)
      await db.execute(
        `UPDATE billing_clients SET client_name = ?, platform = ?, app_version = ?, os_version = ?, last_seen_at = NOW(), revoked_at = NULL
         WHERE billing_customer_id = ? AND client_id = ?`,
        [clientName || existingClient[0].client_name, platform || existingClient[0].platform,
         appVersion || existingClient[0].app_version, osVersion || existingClient[0].os_version,
         billingCustomerId, clientId]
      );
    } else {
      // New client — check active client count
      const activeClients = await getActiveClients(db, billingCustomerId);

      if (activeClients.length >= CLIENT_LIMIT) {
        // Revoke the oldest active client (by last_seen_at) to make room
        const oldest = activeClients[activeClients.length - 1]; // sorted DESC, so last is oldest
        await db.execute(
          `UPDATE billing_clients SET revoked_at = NOW() WHERE billing_customer_id = ? AND client_id = ?`,
          [billingCustomerId, oldest.client_id]
        );
        replacedClient = {
          clientId: oldest.client_id, clientName: oldest.client_name, platform: oldest.platform,
          lastSeenAt: oldest.last_seen_at,
        };
      }

      // Insert the new client
      await db.execute(
        `INSERT INTO billing_clients (billing_customer_id, client_id, client_name, platform, app_version, os_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [billingCustomerId, clientId, clientName || null, platform || null, appVersion || null, osVersion || null]
      );
    }

    // Return full billing status + client info
    const activeClients = await getActiveClients(db, billingCustomerId);
    const premiumAccess = computePremiumAccess(sub.status, sub.cancel_at_period_end, sub.current_period_end);

    res.json({
      customerId: customerRow.stripe_customer_id,
      customerEmail: customerRow.email,
      hasSubscription: true,
      status: sub.status,
      premiumAccess,
      clientLimit: CLIENT_LIMIT,
      activeClientCount: activeClients.length,
      activeClients: activeClients.map(c => ({
        clientId: c.client_id, clientName: c.client_name, platform: c.platform,
        appVersion: c.app_version, osVersion: c.os_version,
        firstSeenAt: c.first_seen_at, lastSeenAt: c.last_seen_at,
      })),
      currentClientId: clientId,
      clientAccessGranted: true,
      replacedClient,
    });
  } catch (error) {
    console.error('[billing/register-client]', error.message);
    res.status(500).json({ error: 'register_failed', message: 'Could not register client. Please try again.' });
  }
});

// POST /api/billing/unregister-client
app.post('/api/billing/unregister-client', mutationLimiter, requireBilling, async (req, res) => {
  try {
    const { customerId, email, clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId is required.' });
    if (!customerId && !email) return res.status(400).json({ error: 'customerId or email required.' });

    const db = getPool();
    let customerRow;

    if (customerId) {
      const [rows] = await db.execute('SELECT * FROM billing_customers WHERE stripe_customer_id = ?', [customerId]);
      customerRow = rows[0];
    }
    if (!customerRow && email) {
      const [rows] = await db.execute('SELECT * FROM billing_customers WHERE email = ?', [email.toLowerCase()]);
      customerRow = rows[0];
    }

    if (!customerRow) return res.status(404).json({ error: 'customer_not_found', message: 'No billing customer found.' });

    // Revoke the client
    await db.execute(
      `UPDATE billing_clients SET revoked_at = NOW() WHERE billing_customer_id = ? AND client_id = ? AND revoked_at IS NULL`,
      [customerRow.id, clientId]
    );

    // Return updated client list
    const activeClients = await getActiveClients(db, customerRow.id);

    res.json({
      customerId: customerRow.stripe_customer_id,
      customerEmail: customerRow.email,
      clientLimit: CLIENT_LIMIT,
      activeClientCount: activeClients.length,
      activeClients: activeClients.map(c => ({
        clientId: c.client_id, clientName: c.client_name, platform: c.platform,
        appVersion: c.app_version, osVersion: c.os_version,
        firstSeenAt: c.first_seen_at, lastSeenAt: c.last_seen_at,
      })),
    });
  } catch (error) {
    console.error('[billing/unregister-client]', error.message);
    res.status(500).json({ error: 'unregister_failed', message: 'Could not unregister client. Please try again.' });
  }
});

// POST /api/billing/webhook (Stripe webhook — raw body)
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Webhook not configured.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = getPool();

  try {
    // Idempotency: skip already-processed events
    const [existing] = await db.execute('SELECT event_id FROM processed_stripe_events WHERE event_id = ?', [event.id]);
    if (existing.length > 0) {
      return res.json({ received: true, duplicate: true });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription' || !session.subscription) break;
        const email = (session.customer_email || session.customer_details?.email || '').toLowerCase();
        const customerId = session.customer;
        // Upsert customer
        await db.execute(
          `INSERT INTO billing_customers (email, stripe_customer_id) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE stripe_customer_id = VALUES(stripe_customer_id), updated_at = NOW()`,
          [email, customerId]
        );
        // Fetch subscription from Stripe for full details
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        await upsertSubscription(db, customerId, sub);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await upsertSubscription(db, sub.customer, sub);
        break;
      }

      case 'customer.subscription.deleted': {
        // Use upsertSubscription so premium_access is computed from period end, not forced FALSE
        const sub = event.data.object;
        await upsertSubscription(db, sub.customer, sub);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await db.execute(
            `UPDATE billing_subscriptions SET latest_invoice_status = 'failed', updated_at = NOW()
             WHERE stripe_subscription_id = ?`,
            [invoice.subscription]
          );
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await db.execute(
            `UPDATE billing_subscriptions SET latest_invoice_status = 'paid', updated_at = NOW()
             WHERE stripe_subscription_id = ?`,
            [invoice.subscription]
          );
        }
        break;
      }
    }

    // Record event as processed
    await db.execute(
      'INSERT IGNORE INTO processed_stripe_events (event_id, event_type) VALUES (?, ?)',
      [event.id, event.type]
    );

    res.json({ received: true });
  } catch (err) {
    console.error(`Webhook processing error [${event.id} ${event.type}]:`, err.message);
    // Return 500 so Stripe retries — billing state was not durably written
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

// Upsert subscription from Stripe object into DB
async function upsertSubscription(db, stripeCustomerId, sub) {
  const [custRows] = await db.execute('SELECT id FROM billing_customers WHERE stripe_customer_id = ?', [stripeCustomerId]);
  if (custRows.length === 0) return;

  const billingCustomerId = custRows[0].id;
  const priceItem = sub.items?.data?.[0];
  const priceId = priceItem?.price?.id || null;
  const interval = priceItem?.price?.recurring?.interval || null;
  const periodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000) : null;
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
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

// ===========================================
// Admin Routes (protected)
// ===========================================

app.get('/api/admin/subscribers', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db = getPool();
    const [subscribers] = await db.execute('SELECT id, email, created_at FROM subscribers ORDER BY created_at DESC');
    res.json(subscribers);
  } catch (error) {
    console.error('Error getting subscribers:', error);
    res.status(500).json({ error: 'Failed to get subscribers' });
  }
});

app.get('/api/admin/contacts', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db = getPool();
    const [contacts] = await db.execute('SELECT id, name, email, category, message, created_at FROM contacts ORDER BY created_at DESC');
    res.json(contacts);
  } catch (error) {
    console.error('Error getting contacts:', error);
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

// ===========================================
// Utilities
// ===========================================

function hashIP(ip) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'mailvault-salt')).digest('hex').substring(0, 32);
}

function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// ===========================================
// Start Server
// ===========================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);

  // Initialize database after server is listening
  initDatabase().then(() => {
    console.log('Database connected');
  }).catch(err => {
    dbError = err.message;
    console.error('Database initialization failed:', err.message);
  });
});

module.exports = app;
