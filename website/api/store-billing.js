// App Store and Google Play receipt verification for the phone app, plus the two
// store webhooks that keep `store_subscriptions` current.
//
//   POST /api/billing/store/apple/verify    {signedTransaction, installId, restore?}
//   POST /api/billing/store/google/verify   {purchaseToken, productId, installId, restore?}
//   POST /api/billing/store/apple/notifications  {signedPayload}   (ASSN v2)
//   POST /api/billing/store/google/rtdn          Pub/Sub push, OIDC bearer
//
// Phone contract (src-mobile-engine billing_client.rs):
//   200 {entitled, source, expiresMs}   valid receipt, entitled or not (expired, grace,
//                                       on hold all answer 200 entitled:false)
//   4xx {error}                         receipt refused: the phone drops it and Premium
//   429                                 rate limited (server.js limiter): cache kept
//   5xx {error}                         our side or the store failed: cache kept
// A misconfigured server must answer 5xx, never 4xx, or every phone loses Premium.
//
// A receipt names the install it was bought on (Apple appAccountToken, Google
// obfuscatedExternalAccountId). A different install is refused 403 wrong_account unless it
// is already in that purchase's install set, or the call says `restore: true` (the user
// tapped Restore on a phone signed into the purchasing store account): then the install
// joins the set, capped at MAX_INSTALLS_PER_PURCHASE.
//
// Replay protection is the store's signature plus the claims (bundle, product, install
// id, environment), not one-time use: the phone re-posts its last accepted receipt on
// every refresh, and gets the CURRENT state of that subscription back.
//
// Apple: the JWS is verified by its x5c chain up to the bundled Apple Root CA G3
// (fingerprint pinned), with the Apple marker OIDs on leaf and intermediate, ES256 with
// raw r||s signatures. Certificate validity is checked at the payload's signedDate, as
// Apple's own library does without online checks, so an older stored receipt stays
// verifiable after its leaf certificate expires.
// Google: subscriptionsv2 is fetched on every verify and RTDN; it is the current state.
// No secret is logged. Only node crypto, no dependencies.
const crypto = require('crypto');
const fs = require('fs');
const pathMod = require('path');

const BUNDLE_ID = 'com.mailvault.app';
// Console layout (ruling P6), the same two ids on both platforms: App Store Connect has
// one subscription group with two subscriptions (monthly, yearly); Google Play has TWO
// subscriptions (not one subscription with two base plans) with these product ids, one
// base plan each. Play's subscriptionId is therefore the product id.
const PRODUCT_IDS = new Set(['com.mailvault.app.premium.monthly', 'com.mailvault.app.premium.yearly']);
const APPLE_ROOT_G3_SHA256 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';
const APPLE_ROOT_PATH = pathMod.join(__dirname, 'apple-root-ca-g3.pem');
const OID_APPLE_LEAF = '1.2.840.113635.100.6.11.1';
const OID_APPLE_INTERMEDIATE = '1.2.840.113635.100.6.2.1';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${BUNDLE_ID}/purchases`;
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const MAX_SIGNED_TRANSACTION = 16 * 1024;
const MAX_SIGNED_PAYLOAD = 60 * 1024;
const MAX_PURCHASE_TOKEN = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 5 * 60 * 1000;
const TOKEN_EARLY_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10 * 1000;

// One purchase can serve this many installs (restore on a new phone); the 6th drops the
// least recently seen. Same limit as the web device limit.
const MAX_INSTALLS_PER_PURCHASE = 5;

const TERMINAL = new Set(['revoked', 'refunded']);

// A refusal answers 4xx; Unavailable answers 5xx (the phone keeps its cache).
class Refusal extends Error {
  constructor(code, status = 403) { super(code); this.code = code; this.status = status; }
}
class Unavailable extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const refuse = (code) => new Refusal(code);
const badRequest = () => new Refusal('invalid_request', 400);

// DER TLV of an OBJECT IDENTIFIER, e.g. 1.2.840.113635.100.6.11.1 -> 06 0a 2a 86 48 ...
function derOid(dotted) {
  const arcs = dotted.split('.').map(Number);
  const body = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const bytes = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) bytes.unshift((v & 0x7f) | 0x80);
    body.push(...bytes);
  }
  return Buffer.from([0x06, body.length, ...body]);
}
const LEAF_MARKER = derOid(OID_APPLE_LEAF);
const INTERMEDIATE_MARKER = derOid(OID_APPLE_INTERMEDIATE);

// node's X509Certificate exposes no arbitrary extensions; the marker's DER encoding in the
// certificate is the check (the chain to the pinned root is what makes it trustworthy).
const hasMarker = (cert, marker) => cert.raw.indexOf(marker) !== -1;

/** Loads the bundled Apple Root CA G3 and refuses any file that is not it. */
function loadAppleRoot(file = APPLE_ROOT_PATH) {
  const cert = new crypto.X509Certificate(fs.readFileSync(file));
  if (cert.fingerprint256 !== APPLE_ROOT_G3_SHA256) {
    throw new Error('Apple root certificate fingerprint mismatch');
  }
  return cert;
}

/** Play's obfuscatedAccountId for an install: lowercase hex SHA-256 of the lowercase UUID. */
const obfuscatedAccountId = (installId) => crypto.createHash('sha256').update(String(installId).toLowerCase()).digest('hex');

function b64urlJson(part) {
  if (typeof part !== 'string' || !part || !B64URL_RE.test(part)) throw refuse('invalid_signature');
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw refuse('invalid_signature');
  }
}

const certTime = (cert, which) => {
  const d = cert[`${which}Date`];
  return d instanceof Date ? d.getTime() : Date.parse(cert[which]);
};
const validAt = (cert, at) => at >= certTime(cert, 'validFrom') && at <= certTime(cert, 'validTo');

/**
 * Verifies an App Store JWS (transaction, renewal info or notification) and returns its
 * payload. Throws Refusal('invalid_signature') on anything wrong with it.
 */
function verifyAppleJws(token, roots, now) {
  const fail = () => refuse('invalid_signature');
  if (typeof token !== 'string') throw fail();
  const parts = token.split('.');
  if (parts.length !== 3) throw fail();
  const header = b64urlJson(parts[0]);
  if (header.alg !== 'ES256') throw fail();
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === 'string' && B64_RE.test(c))) throw fail();

  let leaf; let intermediate;
  try {
    leaf = new crypto.X509Certificate(Buffer.from(x5c[0], 'base64'));
    intermediate = new crypto.X509Certificate(Buffer.from(x5c[1], 'base64'));
  } catch {
    throw fail();
  }
  // The presented root (x5c[2]) is never trusted: the intermediate must be issued and
  // signed by one of OUR roots.
  const root = roots.find((r) => {
    try { return intermediate.checkIssued(r) && intermediate.verify(r.publicKey); } catch { return false; }
  });
  if (!root) throw fail();
  let leafOk = false;
  try { leafOk = leaf.checkIssued(intermediate) && leaf.verify(intermediate.publicKey); } catch { leafOk = false; }
  if (!leafOk) throw fail();
  if (intermediate.ca !== true || leaf.ca !== false) throw fail();
  if (!hasMarker(leaf, LEAF_MARKER) || !hasMarker(intermediate, INTERMEDIATE_MARKER)) throw fail();

  const key = leaf.publicKey;
  if (key.asymmetricKeyType !== 'ec' || !key.asymmetricKeyDetails || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') throw fail();
  if (!B64URL_RE.test(parts[2])) throw fail();
  const sig = Buffer.from(parts[2], 'base64url');
  if (sig.length !== 64) throw fail();
  let ok = false;
  try {
    ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch { ok = false; }
  if (!ok) throw fail();

  const payload = b64urlJson(parts[1]);
  const signedAt = payload.signedDate;
  if (!Number.isFinite(signedAt) || signedAt > now + CLOCK_SKEW_MS) throw fail();
  if (![leaf, intermediate, root].every((c) => validAt(c, signedAt))) throw fail();
  return payload;
}

/**
 * Folds an incoming observation into the stored row. Authorities:
 *   'receipt'  a JWS the phone posted (may be old: it never lowers expiry or undoes a refund)
 *   'fetch'    Google's subscriptionsv2 answer (current state, but a refund stays)
 *   'notice'   a store notification with an explicit status
 *   'reversal' Apple REFUND_REVERSED: the only thing that lifts a refund at the same expiry
 * The latest expiry wins. A refund or revocation always lands.
 */
function mergeState(row, inc, authority) {
  if (!row) return { ...inc };
  const next = { ...row, installId: row.installId || inc.installId || null };
  if (inc.expiresMs > row.expiresMs) {
    Object.assign(next, {
      expiresMs: inc.expiresMs, status: inc.status, productId: inc.productId, environment: inc.environment,
    });
    if (inc.latestToken) next.latestToken = inc.latestToken;
    return next;
  }
  if (TERMINAL.has(inc.status)) {
    next.status = inc.status;
  } else if (inc.expiresMs === row.expiresMs) {
    if (authority === 'reversal') next.status = inc.status;
    else if ((authority === 'notice' || authority === 'fetch') && !TERMINAL.has(row.status)) next.status = inc.status;
  }
  return next;
}

const entitledNow = (state, now) => state.status === 'active' && state.expiresMs > now;

/**
 * @param {object} deps
 * @param {() => {execute: Function}} deps.getDb   mysql2 pool (lazy)
 * @param {typeof fetch} deps.fetch
 * @param {() => number} [deps.now]
 * @param {import('crypto').X509Certificate[] | null} deps.appleRoots  null: Apple answers 503
 * @param {object} [deps.env]   APPLE_IAP_ENV, APPLE_IAP_ALLOW_SANDBOX, GOOGLE_PLAY_SA_JSON,
 *                              GOOGLE_RTDN_AUDIENCE, GOOGLE_RTDN_SA_EMAIL
 * @param {(msg: string) => void} [deps.logError]
 */
function createStoreBilling({
  getDb, fetch, now = Date.now, appleRoots, env = process.env, logError = (m) => console.error(m),
}) {
  const roots = Array.isArray(appleRoots) && appleRoots.length ? appleRoots : null;
  let accessToken = null;    // { token, expiresAt, key }
  let jwks = null;           // { keys: Map<kid, KeyObject>, fetchedAt }
  let jwksPending = null;

  const sandboxAllowed = () => env.APPLE_IAP_ALLOW_SANDBOX === '1';
  function appleEnvironments() {
    const allowed = new Set();
    const main = env.APPLE_IAP_ENV || 'Production';
    if (main === 'Production') allowed.add('Production');
    if (sandboxAllowed()) allowed.add('Sandbox');
    return allowed;
  }

  // ------------------------------------------------------------------ storage
  async function findRow(platform, id) {
    const [rows] = await getDb().execute(
      'SELECT id, original_id, install_id, product_id, expires_at, status, environment, latest_token FROM store_subscriptions WHERE platform = ? AND (original_id = ? OR latest_token = ?) ORDER BY expires_at DESC LIMIT 1',
      [platform, id, id],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id, originalId: r.original_id, installId: r.install_id, productId: r.product_id,
      expiresMs: Number(r.expires_at), status: r.status, environment: r.environment, latestToken: r.latest_token,
    };
  }

  // Reads, merges and writes one subscription. Returns the stored state.
  async function record(platform, originalId, lookupIds, inc, authority, attempt = 0) {
    let row = null;
    for (const id of lookupIds) {
      if (!id) continue;
      row = await findRow(platform, id);
      if (row) break;
    }
    const at = now();
    if (!row) {
      const s = { ...inc };
      const [res] = await getDb().execute(
        'INSERT IGNORE INTO store_subscriptions (platform, original_id, install_id, product_id, expires_at, status, environment, latest_token, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [platform, originalId, s.installId || null, s.productId, s.expiresMs, s.status, s.environment, s.latestToken || null, at],
      );
      if (res.affectedRows) return { ...s, id: res.insertId };
      if (attempt > 0) throw new Error('store_subscriptions insert raced twice');
      return record(platform, originalId, [originalId, ...lookupIds], inc, authority, attempt + 1);
    }
    const next = mergeState(row, inc, authority);
    const changed = ['installId', 'productId', 'expiresMs', 'status', 'environment', 'latestToken']
      .some((k) => (next[k] ?? null) !== (row[k] ?? null));
    if (changed) {
      await getDb().execute(
        'UPDATE store_subscriptions SET install_id = ?, product_id = ?, expires_at = ?, status = ?, environment = ?, latest_token = ?, updated_at = ? WHERE id = ?',
        [next.installId || null, next.productId, next.expiresMs, next.status, next.environment, next.latestToken || null, at, row.id],
      );
    }
    return next;
  }

  async function isInstalled(subId, installId) {
    const [rows] = await getDb().execute(
      'SELECT install_id FROM store_subscription_installs WHERE subscription_id = ? AND install_id = ?',
      [subId, installId],
    );
    return rows.length > 0;
  }
  // Adds or refreshes an install of a purchase, then drops the least recently seen ones
  // beyond the cap (never the one just touched).
  async function touchInstall(subId, installId) {
    const at = now();
    await getDb().execute(
      'INSERT INTO store_subscription_installs (subscription_id, install_id, last_seen_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)',
      [subId, installId, at],
    );
    const [rows] = await getDb().execute(
      'SELECT install_id, last_seen_at FROM store_subscription_installs WHERE subscription_id = ?',
      [subId],
    );
    const others = rows.filter((r) => r.install_id !== installId)
      .sort((a, b) => Number(b.last_seen_at) - Number(a.last_seen_at));
    for (const r of others.slice(MAX_INSTALLS_PER_PURCHASE - 1)) {
      await getDb().execute(
        'DELETE FROM store_subscription_installs WHERE subscription_id = ? AND install_id = ?',
        [subId, r.install_id],
      );
    }
  }

  async function seen(eventId) {
    const [rows] = await getDb().execute('SELECT event_id FROM processed_store_events WHERE event_id = ?', [eventId]);
    return rows.length > 0;
  }
  async function markSeen(eventId, platform) {
    await getDb().execute(
      'INSERT IGNORE INTO processed_store_events (event_id, platform, processed_at) VALUES (?, ?, ?)',
      [eventId, platform, now()],
    );
  }

  // Wraps a handler: Refusal -> its 4xx, Unavailable -> its 5xx, anything else -> 500.
  async function answer(tag, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Refusal) return [err.status, { error: err.code }];
      if (err instanceof Unavailable) {
        if (err.status >= 500 && err.code !== 'not_configured') logError(`[store/${tag}] ${err.code}`);
        return [err.status, { error: err.code }];
      }
      logError(`[store/${tag}] ${err && (err.code || err.message)}`);
      return [500, { error: 'server_error' }];
    }
  }
  const verdict = (source, state) => {
    if (TERMINAL.has(state.status)) throw refuse('revoked');
    return [200, { entitled: entitledNow(state, now()), source, expiresMs: state.expiresMs }];
  };

  // ------------------------------------------------------------------ Apple
  function appleTransaction(token) {
    const t = verifyAppleJws(token, roots, now());
    if (t.bundleId !== BUNDLE_ID) throw refuse('wrong_bundle');
    if (!PRODUCT_IDS.has(t.productId)) throw refuse('wrong_product');
    if (!appleEnvironments().has(t.environment)) throw refuse('wrong_environment');
    if (typeof t.originalTransactionId !== 'string' || !t.originalTransactionId
      || !Number.isFinite(t.expiresDate)) throw refuse('invalid_receipt');
    return t;
  }
  const appleState = (t, status) => ({
    expiresMs: t.expiresDate,
    status: status || (t.revocationDate ? 'revoked' : 'active'),
    productId: t.productId,
    environment: t.environment,
    installId: typeof t.appAccountToken === 'string' && UUID_RE.test(t.appAccountToken) ? t.appAccountToken.toLowerCase() : null,
    latestToken: null,
  });

  function appleVerify(body) {
    return answer('apple/verify', async () => {
      const { signedTransaction, installId, restore } = body || {};
      if (typeof signedTransaction !== 'string' || !signedTransaction || signedTransaction.length > MAX_SIGNED_TRANSACTION
        || typeof installId !== 'string' || !UUID_RE.test(installId)) throw badRequest();
      if (!roots) throw new Unavailable('not_configured', 503);
      const t = appleTransaction(signedTransaction);
      const own = typeof t.appAccountToken === 'string' && t.appAccountToken.toLowerCase() === installId.toLowerCase();
      if (!own && restore !== true) {
        const known = await findRow('apple', t.originalTransactionId);
        if (!known || !(await isInstalled(known.id, installId.toLowerCase()))) throw refuse('wrong_account');
      }
      if (t.revocationDate) throw refuse('revoked');
      const state = await record('apple', t.originalTransactionId, [t.originalTransactionId], appleState(t), 'receipt');
      await touchInstall(state.id, installId.toLowerCase());
      return verdict('apple', state);
    });
  }

  // notificationType -> [status for the transaction, authority]
  function appleNoticeStatus(type, subtype, t) {
    switch (type) {
      case 'REFUND': return ['refunded', 'notice'];
      case 'REVOKE': return ['revoked', 'notice'];
      case 'REFUND_REVERSED': return ['active', 'reversal'];
      case 'EXPIRED':
      case 'GRACE_PERIOD_EXPIRED': return ['expired', 'notice'];
      case 'DID_FAIL_TO_RENEW': return [subtype === 'GRACE_PERIOD' ? 'grace' : 'on_hold', 'notice'];
      default: return [t.revocationDate ? 'revoked' : 'active', 'notice'];
    }
  }

  function appleNotification(body) {
    return answer('apple/notifications', async () => {
      const signedPayload = body && body.signedPayload;
      if (typeof signedPayload !== 'string' || !signedPayload || signedPayload.length > MAX_SIGNED_PAYLOAD) throw badRequest();
      if (!roots) throw new Unavailable('not_configured', 503);
      let n;
      try {
        n = verifyAppleJws(signedPayload, roots, now());
      } catch (err) {
        if (err instanceof Refusal) throw new Refusal(err.code, 400);
        throw err;
      }
      if (typeof n.notificationUUID !== 'string' || !n.notificationUUID || n.notificationUUID.length > 200) throw badRequest();
      const data = n.data && typeof n.data === 'object' ? n.data : null;
      // Another app or an environment this server does not serve: acknowledge, record nothing.
      if (!data || data.bundleId !== BUNDLE_ID || !appleEnvironments().has(data.environment)) return [200, { ok: true }];
      const eventId = `apple:${n.notificationUUID}`;
      if (await seen(eventId)) return [200, { ok: true }];

      if (typeof data.signedTransactionInfo === 'string' && data.signedTransactionInfo) {
        let t;
        try {
          t = verifyAppleJws(data.signedTransactionInfo, roots, now());
        } catch (err) {
          if (err instanceof Refusal) throw new Refusal(err.code, 400);
          throw err;
        }
        const usable = t.bundleId === BUNDLE_ID && PRODUCT_IDS.has(t.productId)
          && t.environment === data.environment && typeof t.originalTransactionId === 'string'
          && t.originalTransactionId && Number.isFinite(t.expiresDate);
        if (usable) {
          const [status, authority] = appleNoticeStatus(n.notificationType, n.subtype, t);
          await record('apple', t.originalTransactionId, [t.originalTransactionId], appleState(t, status), authority);
        }
      }
      await markSeen(eventId, 'apple');
      return [200, { ok: true }];
    });
  }

  // ------------------------------------------------------------------ Google
  function serviceAccount() {
    const raw = env.GOOGLE_PLAY_SA_JSON;
    if (!raw || typeof raw !== 'string') throw new Unavailable('not_configured', 503);
    let sa;
    try {
      sa = JSON.parse(raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8'));
    } catch {
      throw new Unavailable('not_configured', 503);
    }
    if (!sa || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') throw new Unavailable('not_configured', 503);
    return sa;
  }

  async function upstream(url, opts) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: 'error' });
    } catch {
      throw new Unavailable('upstream_error', 502);
    }
  }

  async function googleAccessToken() {
    const sa = serviceAccount();
    const at = now();
    if (accessToken && accessToken.key === sa.client_email && at < accessToken.expiresAt - TOKEN_EARLY_MS) return accessToken.token;
    const iat = Math.floor(at / 1000);
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({
      iss: sa.client_email, scope: GOOGLE_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 3600,
    })).toString('base64url');
    let sig;
    try {
      sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), sa.private_key).toString('base64url');
    } catch {
      throw new Unavailable('not_configured', 503);
    }
    const res = await upstream(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}`,
      }).toString(),
    });
    if (!res.ok) throw new Unavailable('upstream_error', 502);
    let out;
    try { out = await res.json(); } catch { throw new Unavailable('upstream_error', 502); }
    if (!out || typeof out.access_token !== 'string') throw new Unavailable('upstream_error', 502);
    const ttl = Number.isFinite(out.expires_in) ? out.expires_in : 3600;
    accessToken = { token: out.access_token, expiresAt: at + ttl * 1000, key: sa.client_email };
    return accessToken.token;
  }

  // -> the SubscriptionPurchaseV2, or null when Google does not know the token under our package.
  async function fetchSubscription(token) {
    const bearer = await googleAccessToken();
    const res = await upstream(`${GOOGLE_API}/subscriptionsv2/tokens/${encodeURIComponent(token)}`, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    });
    if (res.status === 400 || res.status === 404 || res.status === 410) return null;
    if (res.status === 401) accessToken = null;
    if (!res.ok) throw new Unavailable('upstream_error', 502);
    try {
      const sub = await res.json();
      if (!sub || typeof sub !== 'object') throw new Error('shape');
      return sub;
    } catch {
      throw new Unavailable('upstream_error', 502);
    }
  }

  async function acknowledge(productId, token) {
    try {
      const bearer = await googleAccessToken();
      const res = await upstream(
        `${GOOGLE_API}/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`,
        { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) logError(`[store/google] acknowledge failed: ${res.status}`);
    } catch (err) {
      logError(`[store/google] acknowledge failed: ${err && err.code}`);
    }
  }

  const GOOGLE_STATES = {
    SUBSCRIPTION_STATE_ACTIVE: 'active',
    // auto-renew off: paid until expiryTime (spec: entitlement ends at the store's expiry)
    SUBSCRIPTION_STATE_CANCELED: 'active',
    SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace',
    SUBSCRIPTION_STATE_ON_HOLD: 'on_hold',
    SUBSCRIPTION_STATE_PAUSED: 'on_hold',
    SUBSCRIPTION_STATE_PENDING: 'on_hold',
    SUBSCRIPTION_STATE_EXPIRED: 'expired',
    SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired',
  };

  // The line item for productId and its expiry, or null.
  function lineExpiry(sub, productId) {
    const items = Array.isArray(sub.lineItems) ? sub.lineItems : [];
    let best = null;
    for (const li of items) {
      if (!li || li.productId !== productId) continue;
      const t = Date.parse(li.expiryTime);
      if (Number.isFinite(t) && (best === null || t > best)) best = t;
    }
    return best;
  }

  function googleState(sub, productId, expiresMs, installId) {
    return {
      expiresMs,
      status: GOOGLE_STATES[sub.subscriptionState] || 'expired',
      productId,
      environment: sub.testPurchase ? 'Test' : 'Production',
      installId: installId || null,
      latestToken: null,
    };
  }

  const linkedOf = (sub) => (typeof sub.linkedPurchaseToken === 'string' && sub.linkedPurchaseToken ? sub.linkedPurchaseToken : null);
  // The row a token, or the token it replaced, already belongs to.
  async function googleRow(token, sub) {
    for (const id of [token, linkedOf(sub)]) {
      if (!id) continue;
      const row = await findRow('google', id);
      if (row) return row;
    }
    return null;
  }

  async function recordGoogle(token, sub, inc, authority) {
    const linked = linkedOf(sub);
    // The chain root.
    const root = (await googleRow(token, sub))?.originalId || null;
    return record('google', root || linked || token, [token, linked], { ...inc, latestToken: token }, authority);
  }

  const ackPending = (sub) => sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING';

  function googleVerify(body) {
    return answer('google/verify', async () => {
      const { purchaseToken, productId, installId, restore } = body || {};
      if (typeof purchaseToken !== 'string' || !purchaseToken || purchaseToken.length > MAX_PURCHASE_TOKEN
        || !TOKEN_RE.test(purchaseToken) || typeof productId !== 'string'
        || typeof installId !== 'string' || !UUID_RE.test(installId)) throw badRequest();
      if (!PRODUCT_IDS.has(productId)) throw refuse('wrong_product');
      serviceAccount();
      const sub = await fetchSubscription(purchaseToken);
      if (!sub) throw refuse('unknown_purchase');
      const expiresMs = lineExpiry(sub, productId);
      if (expiresMs === null) throw refuse('wrong_product');
      const ids = sub.externalAccountIdentifiers || {};
      if (ids.obfuscatedExternalAccountId !== obfuscatedAccountId(installId) && restore !== true) {
        const known = await googleRow(purchaseToken, sub);
        if (!known || !(await isInstalled(known.id, installId.toLowerCase()))) throw refuse('wrong_account');
      }
      if (sub.testPurchase && !sandboxAllowed()) throw refuse('wrong_environment');

      const state = await recordGoogle(purchaseToken, sub, googleState(sub, productId, expiresMs, installId.toLowerCase()), 'fetch');
      await touchInstall(state.id, installId.toLowerCase());
      // Acknowledged only after the purchase is recorded; a failed acknowledge is retried
      // on the next verify or RTDN (Play refunds after 3 days without one).
      if (ackPending(sub) && entitledNow(state, now())) await acknowledge(productId, purchaseToken);
      return verdict('google', state);
    });
  }

  // ------------------------------------------------------------------ RTDN
  async function loadJwks(force) {
    const at = now();
    if (jwks && !force && at - jwks.fetchedAt < JWKS_TTL_MS) return jwks;
    if (jwks && force && at - jwks.fetchedAt < JWKS_MIN_REFETCH_MS) return jwks;
    if (!jwksPending) {
      jwksPending = (async () => {
        const res = await upstream(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Unavailable('upstream_error', 502);
        let doc;
        try { doc = await res.json(); } catch { throw new Unavailable('upstream_error', 502); }
        const keys = new Map();
        for (const k of (doc && Array.isArray(doc.keys) ? doc.keys : [])) {
          if (!k || k.kty !== 'RSA' || typeof k.kid !== 'string') continue;
          try { keys.set(k.kid, crypto.createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e }, format: 'jwk' })); } catch { /* skip */ }
        }
        jwks = { keys, fetchedAt: now() };
        return jwks;
      })().finally(() => { jwksPending = null; });
    }
    return jwksPending;
  }

  // Verifies the Pub/Sub push OIDC token. Throws Refusal('unauthorized', 401).
  async function verifyPushToken(authorization, audience, email) {
    const deny = () => new Refusal('unauthorized', 401);
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw deny();
    const token = authorization.slice(7).trim();
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => p && B64URL_RE.test(p))) throw deny();
    let header; let claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw deny();
    }
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !claims || typeof claims !== 'object') throw deny();
    let set = await loadJwks(false);
    if (!set.keys.has(header.kid)) set = await loadJwks(true);
    const key = set.keys.get(header.kid);
    if (!key) throw deny();
    let ok = false;
    try {
      ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    } catch { ok = false; }
    if (!ok) throw deny();
    const at = now();
    if (!GOOGLE_ISSUERS.has(claims.iss)) throw deny();
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw deny();
    if (claims.email !== email || claims.email_verified !== true) throw deny();
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= at - 60_000) throw deny();
    if (Number.isFinite(claims.iat) && claims.iat * 1000 > at + CLOCK_SKEW_MS) throw deny();
  }

  function googleRtdn({ authorization, body } = {}) {
    return answer('google/rtdn', async () => {
      const audience = env.GOOGLE_RTDN_AUDIENCE;
      const email = env.GOOGLE_RTDN_SA_EMAIL;
      if (!audience || !email) throw new Unavailable('not_configured', 503);
      await verifyPushToken(authorization, audience, email);

      const message = body && body.message;
      const messageId = message && (message.messageId || message.message_id);
      if (typeof messageId !== 'string' || !messageId || messageId.length > 200) return [200, { ok: true }];
      let data;
      try {
        data = JSON.parse(Buffer.from(String(message.data || ''), 'base64').toString('utf8'));
      } catch {
        return [200, { ok: true }];
      }
      if (!data || data.packageName !== BUNDLE_ID) return [200, { ok: true }];
      const eventId = `google:${messageId}`;
      if (await seen(eventId)) return [200, { ok: true }];

      const sn = data.subscriptionNotification;
      const voided = data.voidedPurchaseNotification;
      if (sn && typeof sn.purchaseToken === 'string' && TOKEN_RE.test(sn.purchaseToken)
        && sn.purchaseToken.length <= MAX_PURCHASE_TOKEN && PRODUCT_IDS.has(sn.subscriptionId)) {
        serviceAccount();
        const sub = await fetchSubscription(sn.purchaseToken);
        const expiresMs = sub && lineExpiry(sub, sn.subscriptionId);
        if (sub && expiresMs !== null) {
          const inc = googleState(sub, sn.subscriptionId, expiresMs, null);
          // 12 = SUBSCRIPTION_REVOKED (refund or revocation before expiry)
          const revoked = Number(sn.notificationType) === 12;
          if (revoked) inc.status = 'revoked';
          const state = await recordGoogle(sn.purchaseToken, sub, inc, revoked ? 'notice' : 'fetch');
          if (ackPending(sub) && entitledNow(state, now())) await acknowledge(sn.subscriptionId, sn.purchaseToken);
        }
      } else if (voided && typeof voided.purchaseToken === 'string' && Number(voided.productType) === 1) {
        // PRODUCT_TYPE_SUBSCRIPTION voided (refunded): mark the row, if we know it.
        const row = await findRow('google', voided.purchaseToken);
        if (row) {
          await record('google', row.originalId, [row.originalId], { ...row, status: 'refunded' }, 'notice');
        }
      }
      await markSeen(eventId, 'google');
      return [200, { ok: true }];
    });
  }

  return { appleVerify, appleNotification, googleVerify, googleRtdn };
}

module.exports = {
  createStoreBilling,
  loadAppleRoot,
  verifyAppleJws,
  mergeState,
  derOid,
  obfuscatedAccountId,
  APPLE_ROOT_G3_SHA256,
  BUNDLE_ID,
  PRODUCT_IDS,
};
