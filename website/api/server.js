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
const csrf = require('csrf');
const rateLimit = require('express-rate-limit');
let stripe;
try { stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null; } catch { stripe = null; }
const path = require('path');
const analytics = require('meatlytics');
const { getPool, initDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;
let dbError = null;

// Self-hosted analytics (meatlytics): /gm.js, /gm/e, /_analytics, /gm/api/*.
// Mounted first — it reads POST /gm/e's raw body itself, so it must run before
// the JSON body parser and rate limiter below would otherwise touch it.
const analyticsPeers = [];
if (process.env.GRAPHICMEAT_ANALYTICS_URL) {
  analyticsPeers.push({
    name: 'graphicmeat',
    url: process.env.GRAPHICMEAT_ANALYTICS_URL,
    apiKey: process.env.GRAPHICMEAT_ANALYTICS_KEY,
  });
}
app.use(analytics({
  siteId: 'mailvault',
  dbPath: path.join(__dirname, 'analytics.db'),
  apiKey: process.env.ANALYTICS_API_KEY,
  peers: analyticsPeers,
}));

// ---- GraphicMeat partner API ----
//
// This site used to build its own nodemailer transport here. It never worked:
// `nodemailer` was not installed in the deployed tree, the require threw, and
// every sendMail call sat behind a null check — no contact notification or
// welcome mail ever went out. Rather than install the dependency and keep a
// second copy of the Purelymail credentials on this host, all mail now goes
// through graphicmeat.com, which already had a working sender.
//
// This site therefore needs NO SMTP_* variables at all.
//
// graphicmeat.com owns the Purelymail credentials and the shared subscriber
// table; this site holds neither. One mail path, one credential to rotate.
// Rows land there tagged source='mailvault' so they can never be swept into a
// GraphicMeat newsletter send — those addresses did not consent to that.
const GM_URL = (process.env.GRAPHICMEAT_PARTNER_URL || '').replace(/\/$/, '');
const GM_KEY = process.env.GRAPHICMEAT_PARTNER_KEY;
const gmConfigured = () => Boolean(GM_URL && GM_KEY);

if (!gmConfigured()) {
  console.warn('GRAPHICMEAT_PARTNER_URL/KEY not set — contact and subscribe mail will not be sent.');
}

async function sendViaGraphicMeat(endpoint, payload) {
  if (!gmConfigured()) throw new Error('graphicmeat partner API not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // never hang a form submit on it
  try {
    const res = await fetch(`${GM_URL}/api/partner/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-partner-key': GM_KEY },
      body: JSON.stringify({ source: 'mailvault', ...payload }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `partner ${endpoint} failed: ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

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
  origin: (process.env.CORS_ORIGIN || '*').split(','),
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

// CSRF protection: require custom header on mutating endpoints
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      req.originalUrl !== '/api/billing/webhook' &&
      !req.headers['x-requested-with']) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

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
  res.json({ status: 'ok', timestamp: new Date().toISOString(), prices: pricesOk });
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

    // Mirror the subscriber into GraphicMeat's table (tagged source='mailvault')
    // and let it send the welcome mail — it holds the only SMTP credentials.
    // The local row above is this site's own record and stands on its own, so a
    // partner failure is logged, not surfaced: the visitor did subscribe here.
    sendViaGraphicMeat('subscribe', {
      email: email.toLowerCase(),
      fromName: 'MailVault',
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
</div>`,
    }).catch(err => console.error('Failed to mirror subscriber to GraphicMeat:', err.message));

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

    // Notification goes out through GraphicMeat, which holds the SMTP creds.
    // The message is already stored above, so a mail failure is logged and
    // swallowed rather than losing the submission the user just made.
    sendViaGraphicMeat('contact', {
      name,
      email: email.toLowerCase(),
      category: category || 'general',
      message,
    }).catch(err => console.error('Failed to send contact notification:', err.message));

    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error submitting contact:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ===========================================
// Privacy-safe aggregate metrics
// Daily counters only — no IP, no UA, no cookies, no per-request rows.
// ===========================================

// Events accepted from the public POST endpoint
const PUBLIC_METRICS = new Set(['pricing_view', 'download_click']);
// All known events (public + server-side counters); guards the DB write against typos
const ALL_METRICS = new Set([...PUBLIC_METRICS, 'checkout_created', 'sub_activated']);

// Increment today's counter for an event. Never throws — metrics must never break a caller.
async function bumpMetric(event) {
  try {
    if (!ALL_METRICS.has(event) || dbError) return;
    const db = getPool();
    await db.execute(
      `INSERT INTO metrics_daily (day, event, count) VALUES (CURDATE(), ?, 1)
       ON DUPLICATE KEY UPDATE count = count + 1`,
      [event]
    );
  } catch (err) {
    console.error('[metrics] bump failed:', err.message);
  }
}

// Light rate limit so the beacon can't be spammed into skewing counters
const metricsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {}, // silent
});

// POST /api/metrics/e — body is a plain-text event name. Always 204 (silent).
app.post('/api/metrics/e', metricsLimiter, express.text({ type: '*/*', limit: '128b' }), (req, res) => {
  const event = (typeof req.body === 'string' ? req.body : '').trim();
  if (PUBLIC_METRICS.has(event)) bumpMetric(event); // fire-and-forget
  res.status(204).end();
});

// GET /api/metrics/summary — daily counters for the last 60 days. Token-guarded.
// If METRICS_TOKEN is unset the endpoint does not exist (404).
app.get('/api/metrics/summary', metricsLimiter, async (req, res) => {
  if (!process.env.METRICS_TOKEN) return res.status(404).end();
  const token = req.headers['x-metrics-token'] || req.query.token;
  if (token !== process.env.METRICS_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = getPool();
    const [rows] = await db.execute(
      `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS date, event, count
       FROM metrics_daily
       WHERE day >= CURDATE() - INTERVAL 60 DAY
       ORDER BY day DESC, event ASC`
    );
    res.json(rows);
  } catch (error) {
    console.error('Error getting metrics summary:', error);
    res.status(500).json({ error: 'Failed to get metrics summary' });
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

// ── Hybrid pricing: EUR base, manual USD/GBP, Adaptive for others ───────────
// Two EUR-based Stripe prices with currency_options for USD and GBP.
// Stripe Adaptive Pricing handles other eligible currencies from the EUR base.
const BASE_CURRENCY = 'eur';
const PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY_EUR || process.env.STRIPE_PRICE_MONTHLY;
const PRICE_YEARLY = process.env.STRIPE_PRICE_YEARLY_EUR || process.env.STRIPE_PRICE_YEARLY;

// Price IDs are only exercised at checkout, and /pricing serves MANUAL_AMOUNTS without
// asking Stripe — so a price belonging to another account ("No such price") advertises a
// plan nobody can buy, silently. Retrieve both once at boot and refuse to sell if they're
// unusable. null = not checked yet.
let pricesOk = null;
async function validatePrices() {
  if (!stripe || !PRICE_MONTHLY || !PRICE_YEARLY) { pricesOk = false; return; }
  try {
    await Promise.all([stripe.prices.retrieve(PRICE_MONTHLY), stripe.prices.retrieve(PRICE_YEARLY)]);
    pricesOk = true;
  } catch (error) {
    pricesOk = false;
    console.error('[billing] configured price IDs unusable — checkout will fail:', error.message);
  }
}

// Manual currency_options amounts (in minor units). These match what's set on the Stripe price.
const MANUAL_AMOUNTS = {
  eur: { monthly: 400, yearly: 2500 },
  usd: { monthly: 400, yearly: 2500 },
  gbp: { monthly: 350, yearly: 2100 },
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
 * Returns: { currency, pricingMode, monthly: {amount, formatted}, yearly: {amount, formatted} }
 * pricingMode: 'manual' | 'adaptive' | 'fallback'
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
    const amounts = MANUAL_AMOUNTS[currency];
    return { currency, pricingMode: 'manual', monthly: amounts.monthly, yearly: amounts.yearly };
  }

  // 3. Adaptive currency → Stripe will convert at checkout; show base EUR amounts as estimate
  if (currency && ADAPTIVE_CURRENCIES.has(currency)) {
    const base = MANUAL_AMOUNTS[BASE_CURRENCY];
    return { currency: BASE_CURRENCY, presentmentCurrency: currency, pricingMode: 'adaptive', monthly: base.monthly, yearly: base.yearly };
  }

  // 4. Fallback → EUR
  const base = MANUAL_AMOUNTS[BASE_CURRENCY];
  return { currency: BASE_CURRENCY, pricingMode: currency ? 'fallback' : 'default', monthly: base.monthly, yearly: base.yearly };
}

function formatAmount(amount, currency) {
  try {
    // Whole amounts drop the decimals (€4, not €4.00); anything with cents keeps
    // both digits — a flat minimumFractionDigits: 0 renders £3.50 as "£3.5".
    const digits = amount % 100 === 0 ? 0 : 2;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: digits, maximumFractionDigits: digits })
      .format(amount / 100);
  } catch { return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`; }
}

// Trial applies to the YEARLY plan only — monthly bills from day one.
// TRIAL_DAYS is the knob; YEARLY_TRIAL_DAYS honored for backward compat.
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS) || parseInt(process.env.YEARLY_TRIAL_DAYS) || 14;

// Check if a customer has ever had a subscription (used trial or paid)
async function hasCustomerEverSubscribed(db, billingCustomerId) {
  if (!billingCustomerId) return false;
  const [rows] = await db.execute(
    'SELECT id FROM billing_subscriptions WHERE billing_customer_id = ? LIMIT 1',
    [billingCustomerId]
  );
  return rows.length > 0;
}

// GET /api/billing/pricing — returns plans for the customer's resolved currency
// Optional: ?email=...&customerId=... to check trial eligibility
app.get('/api/billing/pricing', statusLimiter, async (req, res) => {
  if (!PRICE_MONTHLY || !PRICE_YEARLY || pricesOk === false) return res.status(503).json({ error: 'pricing_unavailable' });

  const { currency: reqCurrency, country, email, customerId } = req.query;
  const cfCountry = req.headers['cf-ipcountry'];
  const resolved = resolvePricing(
    reqCurrency,
    country || cfCountry,
    req.headers['accept-language']
  );

  // Determine trial eligibility: one free yearly trial per customer, never used before
  let trialEligible = true; // default for unknown/new users
  try {
    if ((email || customerId) && getPool) {
      const db = getPool();
      let custId = null;
      if (customerId) {
        const [rows] = await db.execute('SELECT id FROM billing_customers WHERE stripe_customer_id = ?', [customerId]);
        custId = rows[0]?.id;
      }
      if (!custId && email) {
        const [rows] = await db.execute('SELECT id FROM billing_customers WHERE email = ?', [email.toLowerCase()]);
        custId = rows[0]?.id;
      }
      if (custId) {
        trialEligible = !(await hasCustomerEverSubscribed(db, custId));
      }
    }
  } catch { /* non-fatal — default to eligible */ }

  const displayCur = resolved.currency;
  const monthlyFormatted = formatAmount(resolved.monthly, displayCur);
  const yearlyFormatted = formatAmount(resolved.yearly, displayCur);
  const monthlyEquiv = formatAmount(Math.round(resolved.yearly / 12), displayCur);
  const savingsPercent = resolved.monthly > 0
    ? Math.round((1 - (resolved.yearly / 12) / resolved.monthly) * 100)
    : 0;

  res.json({
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
        formattedAmount: monthlyFormatted,
        trialDays: 0,
        trialEligible,
      },
      {
        planId: 'yearly',
        interval: 'year',
        currency: displayCur,
        amount: resolved.yearly,
        formattedAmount: yearlyFormatted,
        monthlyEquivalent: monthlyEquiv,
        savingsPercent,
        trialDays: TRIAL_DAYS,
        trialEligible,
      },
    ],
  });
});

// POST /api/billing/checkout-session
app.post('/api/billing/checkout-session', checkoutLimiter, requireBilling, async (req, res) => {
  try {
    const { email, priceType, planId } = req.body;
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Valid email required.' });

    // Always use the EUR-based prices — Stripe handles currency via currency_options + adaptive
    const interval = planId === 'yearly' || priceType === 'yearly' ? 'yearly' : 'monthly';
    const priceId = interval === 'yearly' ? PRICE_YEARLY : PRICE_MONTHLY;
    if (!priceId) return res.status(503).json({ error: 'billing_unavailable', message: 'Price not configured.' });

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

    // Determine trial eligibility (yearly plan only — monthly bills immediately)
    let applyTrial = false;
    try {
      const [custRows] = await db.execute('SELECT id FROM billing_customers WHERE stripe_customer_id = ?', [customerId]);
      const custId = custRows[0]?.id;
      if (custId) {
        applyTrial = !(await hasCustomerEverSubscribed(db, custId));
      } else {
        applyTrial = true; // brand new customer
      }
    } catch { applyTrial = false; }

    const sessionParams = {
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: process.env.BILLING_SUCCESS_URL || 'https://mailvaultapp.com/billing-success.html',
      cancel_url: process.env.BILLING_CANCEL_URL || 'https://mailvaultapp.com/billing-cancel.html',
      // Monthly only. A repeating coupon discounts whole invoices, and the yearly invoice
      // covers 12 months — so "100% off for 3 months" redeemed on the yearly plan is a
      // free year, not a free quarter. Both prices share one Stripe product, so the coupon
      // itself can't be fenced (applies_to is per-product); withholding the promo field
      // from yearly sessions is the enforcement.
      allow_promotion_codes: interval === 'monthly',
    };
    const trialApplied = applyTrial && interval === 'yearly';
    if (trialApplied) {
      sessionParams.subscription_data = { trial_period_days: TRIAL_DAYS };
    }

    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionParams);
    } catch (error) {
      // Rows minted while STRIPE_SECRET_KEY pointed at another Stripe account
      // hold customer ids that don't exist here ("No such customer") and
      // permanently block checkout for that email. Nothing can be attached to
      // a customer Stripe says is missing, so recreating it loses nothing:
      // mint a fresh customer, repoint the row, retry once.
      if (error.code !== 'resource_missing' || error.param !== 'customer') throw error;
      const customer = await stripe.customers.create({ email: email.toLowerCase() });
      await db.execute('UPDATE billing_customers SET stripe_customer_id = ? WHERE email = ?', [customer.id, email.toLowerCase()]);
      console.warn(`[billing/checkout-session] replaced missing customer ${customerId} with ${customer.id}`);
      customerId = customer.id;
      sessionParams.customer = customer.id;
      session = await stripe.checkout.sessions.create(sessionParams);
    }

    bumpMetric('checkout_created');
    res.json({ url: session.url, customerId, trialApplied });
  } catch (error) {
    console.error('[billing/checkout-session]', error.message);
    // Echo Stripe's error code (never the message — it can carry ids): enough to tell a
    // config rot from a card/customer problem without shelling into journalctl.
    res.status(500).json({ error: 'checkout_failed', code: error.code || null, message: 'Could not create checkout session. Please try again.' });
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
    // A stored customer id Stripe doesn't recognize has no portal to show —
    // that's "no billing account", not a server fault.
    if (error.code === 'resource_missing' && error.param === 'customer') {
      return res.status(404).json({ error: 'No billing customer found.' });
    }
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
        // One activation event per completed checkout (trialing or active both count as conversion)
        if (computePremiumAccess(sub.status, sub.cancel_at_period_end, sub.current_period_end ? new Date(sub.current_period_end * 1000) : null)) {
          bumpMetric('sub_activated');
        }
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on port ${PORT}`);

  validatePrices();

  // Initialize database after server is listening
  initDatabase().then(() => {
    console.log('Database connected');
  }).catch(err => {
    dbError = err.message;
    console.error('Database initialization failed:', err.message);
  });
});

module.exports = app;
