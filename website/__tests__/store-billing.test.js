import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const store = require('../api/store-billing.js');
const { createStoreBilling, loadAppleRoot, APPLE_ROOT_G3_SHA256, derOid, obfuscatedAccountId, mergeState } = store;

const FIX = path.join(__dirname, 'fixtures', 'store');
const fx = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const derB64 = (pem) => new crypto.X509Certificate(fx(pem)).raw.toString('base64');
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2027-03-01T00:00:00Z');
const INSTALL = '3f1c2b7a-9d4e-4c51-8a2f-6b0e5d9c1a77';
const OTHER_INSTALL = '00000000-1111-4222-8333-444444444444';
const MONTHLY = 'com.mailvault.app.premium.monthly';
const YEARLY = 'com.mailvault.app.premium.yearly';
const TEST_ROOT = new crypto.X509Certificate(fx('root.pem'));

// StoreKit's appAccountToken for an install: a one-way UUID of the install id, so a receipt
// (whose payload anyone holding it can read) never reveals the install id. Written out here
// independently of the server; the engine (premium.rs) pins the same vector.
function acct(installId) {
  const h = crypto.createHash('sha256').update(`mailvault/appAccountToken/v1:${installId.toLowerCase()}`).digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Apple JWS fixtures: signed with the test leaf key, raw r||s like the App Store.
// ---------------------------------------------------------------------------
function jws(payload, {
  chain = ['leaf.pem', 'intermediate.pem', 'root.pem'], key = 'leaf-private-key.pem', alg = 'ES256', header = {},
} = {}) {
  const h = b64url({ alg, x5c: chain.map(derB64), ...header });
  const p = b64url(payload);
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: fx(key), dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${sig.toString('base64url')}`;
}

function tx(over = {}) {
  return {
    transactionId: '2000000111',
    originalTransactionId: '2000000100',
    bundleId: 'com.mailvault.app',
    productId: MONTHLY,
    purchaseDate: NOW - 5 * DAY,
    originalPurchaseDate: NOW - 5 * DAY,
    expiresDate: NOW + 25 * DAY,
    type: 'Auto-Renewable Subscription',
    inAppOwnershipType: 'PURCHASED',
    signedDate: NOW - 60_000,
    environment: 'Production',
    appAccountToken: acct(INSTALL),
    ...over,
  };
}

// The StoreKit 2 AppTransaction payload (App Store Server Library AppTransaction model).
function appTx(over = {}) {
  return {
    receiptType: 'Production',
    appAppleId: 1234567890,
    bundleId: 'com.mailvault.app',
    applicationVersion: '1',
    versionExternalIdentifier: 0,
    receiptCreationDate: NOW - 60_000,
    originalPurchaseDate: NOW - 100 * DAY,
    originalApplicationVersion: '1',
    deviceVerification: 'dGVzdA==',
    deviceVerificationNonce: '1b2c3d4e-0000-4000-8000-000000000000',
    appTransactionId: '704000000000001',
    originalPlatform: 'iOS',
    ...over,
  };
}

function notification(type, txOver = {}, over = {}) {
  const t = tx(txOver);
  return jws({
    notificationType: type,
    notificationUUID: over.uuid || crypto.randomUUID(),
    version: '2.0',
    signedDate: NOW - 1000,
    data: {
      bundleId: 'com.mailvault.app',
      environment: t.environment,
      signedTransactionInfo: jws(t),
      ...(over.data || {}),
    },
    ...(over.subtype ? { subtype: over.subtype } : {}),
  }, over.jwsOptions);
}

// ---------------------------------------------------------------------------
// In-memory stand-in for store_subscriptions + processed_store_events. It answers
// exactly the statements store-billing.js issues and fails loudly on any other.
// ---------------------------------------------------------------------------
function fakeDb() {
  const subs = [];
  const events = new Map();
  const installs = [];
  const calls = [];
  let nextId = 1;
  let failWhen = null;
  const pub = (r) => ({ ...r });
  return {
    subs,
    installs,
    events,
    calls,
    fail(pred) { failWhen = pred; },
    async execute(sql, p = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      calls.push([q, p]);
      if (failWhen && failWhen(q)) throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
      if (q === 'SELECT id, original_id, install_id, product_id, expires_at, status, environment, latest_token FROM store_subscriptions WHERE platform = ? AND (original_id = ? OR latest_token = ?) ORDER BY expires_at DESC LIMIT 1') {
        const r = subs.filter((s) => s.platform === p[0] && (s.original_id === p[1] || s.latest_token === p[2]))
          .sort((a, b) => b.expires_at - a.expires_at)[0];
        return [r ? [pub(r)] : [], []];
      }
      if (q === 'INSERT IGNORE INTO store_subscriptions (platform, original_id, install_id, product_id, expires_at, status, environment, latest_token, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)') {
        if (subs.some((s) => s.platform === p[0] && s.original_id === p[1])) return [{ affectedRows: 0 }, []];
        const [platform, original_id, install_id, product_id, expires_at, status, environment, latest_token, updated_at] = p;
        subs.push({ id: nextId++, platform, original_id, install_id, product_id, expires_at, status, environment, latest_token, updated_at });
        return [{ affectedRows: 1, insertId: nextId - 1 }, []];
      }
      if (q === 'UPDATE store_subscriptions SET install_id = ?, product_id = ?, expires_at = ?, status = ?, environment = ?, latest_token = ?, updated_at = ? WHERE id = ?') {
        const r = subs.find((s) => s.id === p[7]);
        if (!r) return [{ affectedRows: 0 }, []];
        [r.install_id, r.product_id, r.expires_at, r.status, r.environment, r.latest_token, r.updated_at] = p;
        return [{ affectedRows: 1 }, []];
      }
      if (q === 'INSERT INTO store_subscription_installs (subscription_id, install_id, last_seen_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)') {
        const r = installs.find((x) => x.subscription_id === p[0] && x.install_id === p[1]);
        if (r) r.last_seen_at = p[2]; else installs.push({ subscription_id: p[0], install_id: p[1], last_seen_at: p[2] });
        return [{ affectedRows: 1 }, []];
      }
      if (q === 'SELECT install_id, last_seen_at FROM store_subscription_installs WHERE subscription_id = ?') {
        return [installs.filter((r) => r.subscription_id === p[0]).map((r) => ({ install_id: r.install_id, last_seen_at: r.last_seen_at })), []];
      }
      if (q === 'SELECT COUNT(*) AS n FROM store_subscription_installs WHERE subscription_id = ? AND last_seen_at > ?') {
        return [[{ n: installs.filter((r) => r.subscription_id === p[0] && r.last_seen_at > p[1]).length }], []];
      }
      if (q === 'DELETE FROM store_subscription_installs WHERE subscription_id = ? AND install_id = ?') {
        const i = installs.findIndex((r) => r.subscription_id === p[0] && r.install_id === p[1]);
        if (i >= 0) installs.splice(i, 1);
        return [{ affectedRows: i >= 0 ? 1 : 0 }, []];
      }
      if (q === 'UPDATE store_subscription_installs SET last_seen_at = ? WHERE subscription_id = ? AND install_id = ?') {
        const r = installs.find((x) => x.subscription_id === p[1] && x.install_id === p[2]);
        if (r) r.last_seen_at = p[0];
        return [{ affectedRows: r ? 1 : 0 }, []];
      }
      if (q === 'SELECT event_id FROM processed_store_events WHERE event_id = ?') {
        return [events.has(p[0]) ? [{ event_id: p[0] }] : [], []];
      }
      if (q === 'INSERT IGNORE INTO processed_store_events (event_id, platform, processed_at) VALUES (?, ?, ?)') {
        if (events.has(p[0])) return [{ affectedRows: 0 }, []];
        events.set(p[0], { platform: p[1], processed_at: p[2] });
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`unexpected SQL: ${q}`);
    },
  };
}
const writes = (db, from = 0) => db.calls.slice(from).filter(([q]) => /^(INSERT|UPDATE)/.test(q) && q.includes('store_subscriptions'));

// ---------------------------------------------------------------------------
// Google fakes: service account, Play Developer API, Pub/Sub OIDC signer.
// ---------------------------------------------------------------------------
const SA = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const OIDC = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'play-verifier@test-project.iam.gserviceaccount.com',
  private_key: SA.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
});
const RTDN_AUD = 'https://mailvaultapp.com/api/billing/store/google/rtdn';
const RTDN_EMAIL = 'rtdn-push@test-project.iam.gserviceaccount.com';
const KID = 'test-kid-1';

function signJwt(claims, { key = OIDC.privateKey, kid = KID, alg = 'RS256' } = {}) {
  const h = b64url({ alg, kid, typ: 'JWT' });
  const p = b64url(claims);
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${sig.toString('base64url')}`;
}
const oidcClaims = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: RTDN_AUD,
  email: RTDN_EMAIL,
  email_verified: true,
  sub: '1234567890',
  iat: Math.floor(NOW / 1000) - 10,
  exp: Math.floor(NOW / 1000) + 3600,
  ...over,
});

function subV2(over = {}, line = {}) {
  return {
    kind: 'androidpublisher#subscriptionPurchaseV2',
    regionCode: 'US',
    startTime: new Date(NOW - 5 * DAY).toISOString(),
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: 'GPA.0000-0000-0000-00000',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: obfuscatedAccountId(INSTALL) },
    lineItems: [{ productId: MONTHLY, expiryTime: new Date(NOW + 25 * DAY).toISOString(), ...line }],
    ...over,
  };
}

function googleFake({ subs = {}, tokenTtl = 3600 } = {}) {
  const calls = [];
  const state = { subs, ackFail: false, subsStatus: {}, jwksFetches: 0, tokenFetches: 0 };
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  async function fetch(url, opts = {}) {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} });
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') {
      state.tokenFetches++;
      const form = new URLSearchParams(String(opts.body));
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h, p, s] = form.get('assertion').split('.');
      expect(JSON.parse(Buffer.from(h, 'base64url')).alg).toBe('RS256');
      expect(crypto.verify('sha256', Buffer.from(`${h}.${p}`), SA.publicKey, Buffer.from(s, 'base64url'))).toBe(true);
      const c = JSON.parse(Buffer.from(p, 'base64url'));
      expect(c.iss).toBe('play-verifier@test-project.iam.gserviceaccount.com');
      expect(c.scope).toBe('https://www.googleapis.com/auth/androidpublisher');
      expect(c.aud).toBe('https://oauth2.googleapis.com/token');
      return json(200, { access_token: `ya29.test-${state.tokenFetches}`, expires_in: tokenTtl, token_type: 'Bearer' });
    }
    if (u === 'https://www.googleapis.com/oauth2/v3/certs') {
      state.jwksFetches++;
      return json(200, { keys: [{ ...OIDC.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] });
    }
    const base = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
    if (u.startsWith(base)) {
      expect(opts.headers.Authorization).toMatch(/^Bearer ya29\.test-\d+$/);
      const rest = u.slice(base.length);
      let m = rest.match(/^com\.mailvault\.app\/purchases\/subscriptionsv2\/tokens\/([^/]+)$/);
      if (m) {
        const token = decodeURIComponent(m[1]);
        if (state.subsStatus[token]) return json(state.subsStatus[token], { error: { code: state.subsStatus[token] } });
        return state.subs[token] ? json(200, state.subs[token]) : json(404, { error: { code: 404, message: 'not found' } });
      }
      m = rest.match(/^com\.mailvault\.app\/purchases\/subscriptions\/([^/]+)\/tokens\/([^/]+):acknowledge$/);
      if (m && opts.method === 'POST') return state.ackFail ? json(500, {}) : json(200, {});
      return json(404, { error: { code: 404 } });
    }
    throw new Error(`unexpected fetch ${u}`);
  }
  return { fetch, calls, state };
}

function setup({ env = {}, subs, appleRoots = [TEST_ROOT], tokenTtl } = {}) {
  const db = fakeDb();
  const g = googleFake({ subs, tokenTtl });
  const clock = { t: NOW };
  const errors = [];
  const ref = { fetch: g.fetch };
  const billing = createStoreBilling({
    getDb: () => db,
    fetch: (u, o) => ref.fetch(u, o),
    now: () => clock.t,
    appleRoots,
    logError: (m) => errors.push(m),
    env: {
      GOOGLE_PLAY_SA_JSON: SA_JSON,
      GOOGLE_RTDN_AUDIENCE: RTDN_AUD,
      GOOGLE_RTDN_SA_EMAIL: RTDN_EMAIL,
      ...env,
    },
  });
  return { db, g, ref, clock, billing, errors };
}

const appleVerify = (b, t, installId = INSTALL) => b.appleVerify({ signedTransaction: t, installId });

// ===========================================================================
describe('Apple root certificate', () => {
  it('bundles the real Apple Root CA G3, pinned by fingerprint', () => {
    expect(APPLE_ROOT_G3_SHA256).toBe('63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79');
    const root = loadAppleRoot();
    expect(root.fingerprint256).toBe(APPLE_ROOT_G3_SHA256);
    expect(root.subject).toContain('Apple Root CA - G3');
  });

  it('refuses a root file whose fingerprint is not Apple Root CA G3', () => {
    expect(() => loadAppleRoot(path.join(FIX, 'root.pem'))).toThrow(/fingerprint/);
  });

  it('encodes the marker OIDs as their DER TLV', () => {
    expect(derOid('1.2.840.113635.100.6.11.1').toString('hex')).toBe('060a2a864886f76364060b01');
    expect(derOid('1.2.840.113635.100.6.2.1').toString('hex')).toBe('060a2a864886f76364060201');
  });
});

describe('POST /api/billing/store/apple/verify', () => {
  it('apple_valid_chain_and_claims_entitle', async () => {
    const { billing, db } = setup();
    const [status, body] = await appleVerify(billing, jws(tx()));
    expect(status).toBe(200);
    expect(body).toEqual({ entitled: true, source: 'apple', expiresMs: NOW + 25 * DAY });
    expect(db.subs).toHaveLength(1);
    expect(db.subs[0]).toMatchObject({
      platform: 'apple', original_id: '2000000100', install_id: INSTALL, product_id: MONTHLY,
      expires_at: NOW + 25 * DAY, status: 'active', environment: 'Production',
    });
    // appAccountToken compares case-insensitively (StoreKit prints UUIDs upper case)
    const [s2] = await appleVerify(billing, jws(tx({ appAccountToken: acct(INSTALL).toUpperCase() })));
    expect(s2).toBe(200);
    // the yearly product is accepted too
    const [s3, b3] = await appleVerify(billing, jws(tx({ productId: YEARLY, originalTransactionId: '2000000200' })));
    expect([s3, b3.entitled]).toEqual([200, true]);
  });

  it('apple_account_token_is_a_one_way_uuid_of_the_install_id', () => {
    expect(acct('3f1c2b7a-9d4e-4c51-8a2f-6b0e5d9c1a77')).toBe('5d24a09b-88e1-8e7f-93d2-e47a42508791');
    expect(acct('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toBe('5d5455f2-5303-8fc6-a255-dca43b552558');
    expect(store.appleAccountToken(INSTALL)).toBe(acct(INSTALL));
    expect(store.appleAccountToken(INSTALL.toUpperCase())).toBe(acct(INSTALL));
  });

  it('apple_receipt_holder_cannot_claim_the_buying_install', async () => {
    // The buyer's phone verified: its install is a live member of the set.
    const { billing, db } = setup();
    const receipt = jws(tx());
    expect((await appleVerify(billing, receipt))[0]).toBe(200);
    // Whoever holds the shared receipt reads its appAccountToken and posts it as the install
    // id: not the buying install, so the restore rules apply.
    const token = JSON.parse(Buffer.from(receipt.split('.')[1], 'base64url').toString('utf8')).appAccountToken;
    expect(await appleVerify(billing, receipt, token)).toEqual([403, { error: 'wrong_account' }]);
    expect(await appleVerify(billing, receipt, token.toUpperCase())).toEqual([403, { error: 'wrong_account' }]);
    expect(db.installs.map((r) => r.install_id)).toEqual([INSTALL]);
    // The row names the buying install, never the token.
    expect(db.subs[0].install_id).toBe(INSTALL);
  });

  it('apple_wrong_root_wrong_bundle_wrong_token_sandbox_in_prod_revoked_expired_are_refused', async () => {
    const cases = [
      ['wrong root', jws(tx(), { chain: ['other-leaf.pem', 'other-intermediate.pem', 'other-root.pem'], key: 'other-leaf-private-key.pem' }), 'invalid_signature'],
      ['real chain, foreign root presented as ours', jws(tx(), { chain: ['other-leaf.pem', 'other-intermediate.pem', 'root.pem'], key: 'other-leaf-private-key.pem' }), 'invalid_signature'],
      ['leaf without marker', jws(tx(), { chain: ['leaf-nomarker.pem', 'intermediate.pem', 'root.pem'] }), 'invalid_signature'],
      ['intermediate without marker', jws(tx(), { chain: ['leaf-under-nomarker.pem', 'intermediate-nomarker.pem', 'root.pem'] }), 'invalid_signature'],
      ['short chain', jws(tx(), { chain: ['leaf.pem', 'intermediate.pem'] }), 'invalid_signature'],
      ['leaf presented as intermediate', jws(tx(), { chain: ['leaf.pem', 'leaf.pem', 'root.pem'] }), 'invalid_signature'],
      ['alg none', jws(tx(), { alg: 'none' }), 'invalid_signature'],
      ['signed before the certificates were valid', jws(tx({ signedDate: Date.parse('2020-01-01T00:00:00Z') })), 'invalid_signature'],
      ['signed in the future', jws(tx({ signedDate: NOW + DAY })), 'invalid_signature'],
      ['wrong bundle', jws(tx({ bundleId: 'com.example.other' })), 'wrong_bundle'],
      ['wrong product', jws(tx({ productId: 'com.mailvault.app.lifetime' })), 'wrong_product'],
      ['wrong token', jws(tx({ appAccountToken: acct(OTHER_INSTALL) })), 'wrong_account'],
      ['raw install id as token', jws(tx({ appAccountToken: INSTALL })), 'wrong_account'],
      ['no token', jws(tx({ appAccountToken: undefined })), 'wrong_account'],
      ['xcode', jws(tx({ environment: 'Xcode' })), 'wrong_environment'],
      ['revoked', jws(tx({ revocationDate: NOW - DAY, revocationReason: 0 })), 'revoked'],
    ];
    for (const [name, t, error] of cases) {
      const { billing } = setup();
      const [status, body] = await appleVerify(billing, t);
      expect([name, status, body]).toEqual([name, 403, { error }]);
    }

    // malformed input is a 400, never a 5xx
    const { billing } = setup();
    expect(await billing.appleVerify({ signedTransaction: 'not-a-jws', installId: INSTALL })).toEqual([403, { error: 'invalid_signature' }]);
    expect(await billing.appleVerify({ signedTransaction: jws(tx()), installId: 'nope' })).toEqual([400, { error: 'invalid_request' }]);
    expect(await billing.appleVerify({})).toEqual([400, { error: 'invalid_request' }]);
    expect(await billing.appleVerify(null)).toEqual([400, { error: 'invalid_request' }]);

    // expired but valid: 200, not entitled (no grace)
    const e = setup();
    const [s, b] = await appleVerify(e.billing, jws(tx({ expiresDate: NOW - 1 })));
    expect([s, b]).toEqual([200, { entitled: false, source: 'apple', expiresMs: NOW - 1 }]);

    // a production server accepts sandbox receipts by default (App Review, TestFlight) and
    // records the environment; APPLE_IAP_ALLOW_SANDBOX=0 turns that off
    const sb = setup();
    const [s4, b4] = await appleVerify(sb.billing, jws(tx({ environment: 'Sandbox' })));
    expect([s4, b4.entitled]).toEqual([200, true]);
    expect(sb.db.subs[0].environment).toBe('Sandbox');
    const [s5] = await appleVerify(sb.billing, jws(tx({ environment: 'Xcode' })));
    expect(s5).toBe(403);
    const off = setup({ env: { APPLE_IAP_ALLOW_SANDBOX: '0' } });
    expect(await appleVerify(off.billing, jws(tx({ environment: 'Sandbox' })))).toEqual([403, { error: 'wrong_environment' }]);
    expect((await appleVerify(off.billing, jws(tx())))[0]).toBe(200);
    // a production receipt is refused by a sandbox-only server
    const so = setup({ env: { APPLE_IAP_ENV: 'Sandbox' } });
    expect((await appleVerify(so.billing, jws(tx())))[0]).toBe(403);
    expect((await appleVerify(so.billing, jws(tx({ environment: 'Sandbox' }))))[0]).toBe(200);
  });

  it('answers 503 for an APPLE_IAP_ENV it does not know, never 4xx', async () => {
    for (const value of ['production', 'Prod', 'Xcode']) {
      const { billing, db } = setup({ env: { APPLE_IAP_ENV: value } });
      expect([value, ...(await appleVerify(billing, jws(tx())))]).toEqual([value, 503, { error: 'not_configured' }]);
      expect(db.subs).toHaveLength(0);
    }
  });

  it('records a revoked receipt, so the same transaction\'s older JWS is refused too', async () => {
    const { billing, db } = setup();
    const older = jws(tx());
    expect((await appleVerify(billing, older))[1].entitled).toBe(true);
    const revoked = jws(tx({ transactionId: '2000000111', revocationDate: NOW - 1000, revocationReason: 0, signedDate: NOW - 500 }));
    expect(await appleVerify(billing, revoked)).toEqual([403, { error: 'revoked' }]);
    expect(db.subs[0].status).toBe('revoked');
    expect(await appleVerify(billing, older)).toEqual([403, { error: 'revoked' }]);
    // first seen revoked: recorded as well
    const fresh = setup();
    expect(await appleVerify(fresh.billing, revoked)).toEqual([403, { error: 'revoked' }]);
    expect(fresh.db.subs[0]).toMatchObject({ original_id: '2000000100', status: 'revoked' });
    expect(await appleVerify(fresh.billing, older)).toEqual([403, { error: 'revoked' }]);
  });

  it('a revoked earlier period is refused without ending the live later one', async () => {
    const { billing, db } = setup();
    // month 1 refunded, month 2 paid: the phone holds month 2
    const month2 = jws(tx({ transactionId: '2000000112', purchaseDate: NOW - 5 * DAY, expiresDate: NOW + 25 * DAY }));
    expect(await appleVerify(billing, month2)).toEqual([200, { entitled: true, source: 'apple', expiresMs: NOW + 25 * DAY }]);
    const month1 = jws(tx({
      transactionId: '2000000111', purchaseDate: NOW - 35 * DAY, expiresDate: NOW - 5 * DAY,
      revocationDate: NOW - 1000, revocationReason: 0, signedDate: NOW - 500,
    }));
    expect(await appleVerify(billing, month1)).toEqual([403, { error: 'revoked' }]);
    expect(db.subs).toHaveLength(1);
    expect(db.subs[0]).toMatchObject({ status: 'active', expires_at: NOW + 25 * DAY });
    expect(await appleVerify(billing, month2)).toEqual([200, { entitled: true, source: 'apple', expiresMs: NOW + 25 * DAY }]);
  });

  it('a revocation of the latest period still revokes the row', async () => {
    const { billing, db } = setup();
    const month1 = jws(tx({ transactionId: '2000000111', purchaseDate: NOW - 35 * DAY, expiresDate: NOW - 5 * DAY }));
    const month2 = jws(tx({ transactionId: '2000000112', purchaseDate: NOW - 5 * DAY, expiresDate: NOW + 25 * DAY }));
    expect((await appleVerify(billing, month1))[0]).toBe(200);
    expect((await appleVerify(billing, month2))[1].entitled).toBe(true);
    const revoked2 = jws(tx({
      transactionId: '2000000112', purchaseDate: NOW - 5 * DAY, expiresDate: NOW + 25 * DAY,
      revocationDate: NOW - 1000, revocationReason: 0, signedDate: NOW - 500,
    }));
    expect(await appleVerify(billing, revoked2)).toEqual([403, { error: 'revoked' }]);
    expect(db.subs[0]).toMatchObject({ status: 'revoked', expires_at: NOW + 25 * DAY });
    expect(await appleVerify(billing, month2)).toEqual([403, { error: 'revoked' }]);
    expect(await appleVerify(billing, month1)).toEqual([403, { error: 'revoked' }]);
  });

  it('apple_tampered_payload_fails_signature', async () => {
    const { billing, db } = setup();
    const good = jws(tx({ expiresDate: NOW - DAY }));
    const [h, , sig] = good.split('.');
    const forged = `${h}.${b64url(tx({ expiresDate: NOW + 365 * DAY }))}.${sig}`;
    expect(await appleVerify(billing, forged)).toEqual([403, { error: 'invalid_signature' }]);
    // signed by a key that is not the leaf's
    const otherKey = jws(tx(), { key: 'other-leaf-private-key.pem' });
    expect(await appleVerify(billing, otherKey)).toEqual([403, { error: 'invalid_signature' }]);
    // DER-encoded signature instead of raw r||s
    const p = b64url(tx());
    const der = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: fx('leaf-private-key.pem') });
    expect(await appleVerify(billing, `${h}.${p}.${der.toString('base64url')}`)).toEqual([403, { error: 'invalid_signature' }]);
    expect(db.subs).toHaveLength(0);
  });

  it('answers a receipt it has seen before with the current state', async () => {
    const { billing, clock } = setup();
    const first = jws(tx());
    expect((await appleVerify(billing, first))[1]).toMatchObject({ entitled: true, expiresMs: NOW + 25 * DAY });
    // the same receipt again is not a replay refusal
    expect(await appleVerify(billing, first)).toEqual([200, { entitled: true, source: 'apple', expiresMs: NOW + 25 * DAY }]);

    // a renewal arrives by webhook; the phone re-posts its stored (older) receipt
    const renewed = NOW + 55 * DAY;
    expect((await billing.appleNotification({ signedPayload: notification('DID_RENEW', { transactionId: '2000000112', expiresDate: renewed }) }))[0]).toBe(200);
    clock.t = NOW + 30 * DAY;
    expect(await appleVerify(billing, first)).toEqual([200, { entitled: true, source: 'apple', expiresMs: renewed }]);

    // a refund by webhook: the stored receipt is refused, an older one never un-refunds it
    expect((await billing.appleNotification({ signedPayload: notification('REFUND', { transactionId: '2000000112', expiresDate: renewed, revocationDate: clock.t, revocationReason: 0 }) }))[0]).toBe(200);
    expect(await appleVerify(billing, first)).toEqual([403, { error: 'revoked' }]);
  });

  it('answers 503 without a root and 500 when storage fails, never 4xx', async () => {
    const noRoot = setup({ appleRoots: null });
    expect(await appleVerify(noRoot.billing, jws(tx()))).toEqual([503, { error: 'not_configured' }]);
    const down = setup();
    down.db.fail(() => true);
    expect(await appleVerify(down.billing, jws(tx()))).toEqual([500, { error: 'server_error' }]);
  });
});

describe('restore rebinding', () => {
  const inst = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  const restoreApple = (b, t, installId, restore = true) => b.appleVerify({ signedTransaction: t, installId, restore });

  it('restore_on_a_new_install_rebinds', async () => {
    const { billing, db, g } = setup({ subs: { 'tok-1': subV2() } });
    const receipt = jws(tx());
    expect((await appleVerify(billing, receipt))[0]).toBe(200);
    // new phone, same purchase: refused without the flag, accepted with it
    expect(await appleVerify(billing, receipt, OTHER_INSTALL)).toEqual([403, { error: 'wrong_account' }]);
    expect(await restoreApple(billing, receipt, OTHER_INSTALL)).toEqual([200, { entitled: true, source: 'apple', expiresMs: NOW + 25 * DAY }]);
    expect(db.subs).toHaveLength(1);
    // now in the set: a plain verify from it answers the current state
    expect((await appleVerify(billing, receipt, OTHER_INSTALL))[1].entitled).toBe(true);
    // the original install keeps working
    expect((await appleVerify(billing, receipt))[0]).toBe(200);
    // a revoked receipt is still refused with the flag
    const revoked = jws(tx({ originalTransactionId: '2000000300', revocationDate: NOW - DAY, revocationReason: 0 }));
    expect(await restoreApple(billing, revoked, OTHER_INSTALL)).toEqual([403, { error: 'revoked' }]);
    // Google: the same
    const gv = (installId, restore) => billing.googleVerify({ purchaseToken: 'tok-1', productId: MONTHLY, installId, restore });
    expect(await gv(OTHER_INSTALL)).toEqual([403, { error: 'wrong_account' }]);
    expect((await gv(OTHER_INSTALL, true))[1]).toEqual({ entitled: true, source: 'google', expiresMs: NOW + 25 * DAY });
    expect((await gv(OTHER_INSTALL))[0]).toBe(200);
    expect(g.calls.length).toBeGreaterThan(0);
  });

  const ids = (db) => db.installs.map((r) => r.install_id).sort();
  // INSTALL (the purchasing install) plus restores of inst(1)..inst(4): a full set.
  async function fillApple(billing, clock, receipt, opts = {}) {
    expect((await appleVerify(billing, receipt))[0]).toBe(200);
    for (let n = 1; n <= 4; n += 1) {
      clock.t += 1000;
      expect((await billing.appleVerify({ signedTransaction: receipt, installId: inst(n), restore: true, ...opts }))[0]).toBe(200);
    }
  }

  it('full_set_refuses_a_new_restore_without_evicting', async () => {
    const { billing, db, clock } = setup();
    const receipt = jws(tx());
    await fillApple(billing, clock, receipt);
    expect(db.installs).toHaveLength(5);
    const before = ids(db);
    clock.t += 1000;
    const subWrites = writes(db).length;
    expect(await restoreApple(billing, receipt, inst(5))).toEqual([409, { error: 'install_limit' }]);
    expect(ids(db)).toEqual(before);
    expect(writes(db)).toHaveLength(subWrites);
    // every member keeps working, with or without the flag
    for (const id of [INSTALL, inst(1), inst(4)]) {
      expect((await appleVerify(billing, receipt, id))[1].entitled).toBe(true);
    }
    expect((await restoreApple(billing, receipt, inst(2)))[0]).toBe(200);
    expect(await restoreApple(billing, receipt, inst(5))).toEqual([409, { error: 'install_limit' }]);
    expect(ids(db)).toEqual(before);
  });

  it('idle_install_frees_its_slot_after_30_days', async () => {
    const { billing, db, clock } = setup();
    const receipt = jws(tx({ expiresDate: NOW + 365 * DAY, productId: YEARLY }));
    await fillApple(billing, clock, receipt);
    const idleSince = db.installs.find((r) => r.install_id === inst(1)).last_seen_at;
    // a refresh (no flag) from a member moves its last_seen_at
    clock.t = idleSince + 10 * DAY;
    for (const id of [INSTALL, inst(2), inst(3), inst(4)]) expect((await appleVerify(billing, receipt, id))[0]).toBe(200);
    expect(db.installs.find((r) => r.install_id === inst(2)).last_seen_at).toBe(clock.t);
    // one millisecond short of 30 days unseen: inst(1) still counts
    clock.t = idleSince + 30 * DAY - 1;
    expect(await restoreApple(billing, receipt, inst(5))).toEqual([409, { error: 'install_limit' }]);
    // 30 days unseen: its slot is free, the others stay, and inst(1) stays in the set
    clock.t = idleSince + 30 * DAY;
    expect((await restoreApple(billing, receipt, inst(5)))[0]).toBe(200);
    expect(ids(db)).toEqual([INSTALL, inst(1), inst(2), inst(3), inst(4), inst(5)].sort());
    // the idle install is never a stranger: with the live set full it meets install_limit
    // (the phone keeps its receipt and cache), never wrong_account, and its last_seen_at stays
    expect(await appleVerify(billing, receipt, inst(1))).toEqual([409, { error: 'install_limit' }]);
    expect(await restoreApple(billing, receipt, inst(1))).toEqual([409, { error: 'install_limit' }]);
    expect(db.installs.find((r) => r.install_id === inst(1)).last_seen_at).toBe(idleSince);
  });

  it('an idle install that comes back with room is answered and counts again', async () => {
    const { billing, db, clock } = setup();
    const receipt = jws(tx({ expiresDate: NOW + 365 * DAY, productId: YEARLY }));
    expect((await appleVerify(billing, receipt))[0]).toBe(200);
    expect((await restoreApple(billing, receipt, inst(1)))[0]).toBe(200);
    // months away: a plain refresh (no restore flag) from it is answered with the current state
    clock.t += 90 * DAY;
    expect(await appleVerify(billing, receipt, inst(1))).toEqual([200, { entitled: true, source: 'apple', expiresMs: NOW + 365 * DAY }]);
    expect(db.installs.find((r) => r.install_id === inst(1)).last_seen_at).toBe(clock.t);
    // Google: the same
    const gs = setup({ subs: { 'tok-1': subV2({}, { expiryTime: new Date(NOW + 365 * DAY).toISOString() }) } });
    const gv = (installId, restore) => gs.billing.googleVerify({ purchaseToken: 'tok-1', productId: MONTHLY, installId, restore });
    expect((await gv(INSTALL))[0]).toBe(200);
    expect((await gv(inst(1), true))[0]).toBe(200);
    gs.clock.t += 90 * DAY;
    expect((await gv(inst(1)))[1].entitled).toBe(true);
  });

  it('concurrent restores never take the set over the cap', async () => {
    const { billing, db, clock } = setup();
    const receipt = jws(tx());
    expect((await appleVerify(billing, receipt))[0]).toBe(200);
    for (let n = 1; n <= 3; n += 1) {
      clock.t += 1000;
      expect((await restoreApple(billing, receipt, inst(n)))[0]).toBe(200);
    }
    // four live installs; three restores race for the last place
    clock.t += 1000;
    const answers = await Promise.all([4, 5, 6].map((n) => restoreApple(billing, receipt, inst(n))));
    for (const [status] of answers) expect([200, 409]).toContain(status);
    const joined = answers.filter(([status]) => status === 200).length;
    expect(db.installs.length).toBeLessThanOrEqual(5);
    expect(db.installs).toHaveLength(4 + joined);
    // once the race is over, the place left (if any) is still available
    if (joined === 0) expect((await restoreApple(billing, receipt, inst(7)))[0]).toBe(200);
    expect(db.installs).toHaveLength(5);
    expect(await restoreApple(billing, receipt, inst(8))).toEqual([409, { error: 'install_limit' }]);
  });

  it('original_install_never_hits_the_limit', async () => {
    const { billing, db, clock } = setup();
    const receipt = jws(tx({ appAccountToken: acct(inst(0)) }));
    for (let n = 1; n <= 5; n += 1) {
      clock.t += 1000;
      expect((await restoreApple(billing, receipt, inst(n)))[0]).toBe(200);
    }
    expect(await restoreApple(billing, receipt, inst(6))).toEqual([409, { error: 'install_limit' }]);
    // the purchasing install is never refused for the limit, with or without the flag
    expect(await appleVerify(billing, receipt, inst(0))).toEqual([200, { entitled: true, source: 'apple', expiresMs: NOW + 25 * DAY }]);
    expect((await restoreApple(billing, receipt, inst(0)))[0]).toBe(200);
    expect(db.installs).toHaveLength(6);
    // ... even after it idled out
    clock.t += 40 * DAY;
    expect((await appleVerify(billing, receipt, inst(0)))[0]).toBe(200);
  });

  it('apple_restore_needs_matching_app_transaction', async () => {
    const env = { APPLE_IAP_ALLOW_SANDBOX: '1' };
    const { billing, db } = setup({ env });
    const receipt = jws(tx({ appTransactionId: '704000000000001' }));
    // the purchasing install needs no proof
    expect((await appleVerify(billing, receipt))[0]).toBe(200);
    const restore = (signedAppTransaction, restoreFlag = true) => billing.appleVerify({
      signedTransaction: receipt, installId: OTHER_INSTALL, restore: restoreFlag, signedAppTransaction,
    });
    const refusals = [
      ['missing', undefined, 403, 'wrong_account'],
      ['empty', '', 403, 'wrong_account'],
      ['another account', jws(appTx({ appTransactionId: '704000000000999' })), 403, 'wrong_account'],
      ['no id', jws(appTx({ appTransactionId: undefined })), 403, 'wrong_account'],
      ['the transaction itself', receipt, 403, 'wrong_account'],
      ['foreign root', jws(appTx(), { chain: ['other-leaf.pem', 'other-intermediate.pem', 'other-root.pem'], key: 'other-leaf-private-key.pem' }), 403, 'invalid_signature'],
      ['signed by another key', jws(appTx(), { key: 'other-leaf-private-key.pem' }), 403, 'invalid_signature'],
      ['created in the future', jws(appTx({ receiptCreationDate: NOW + DAY })), 403, 'invalid_signature'],
      ['other app', jws(appTx({ bundleId: 'com.example.other' })), 403, 'wrong_bundle'],
      ['xcode', jws(appTx({ receiptType: 'Xcode' })), 403, 'wrong_environment'],
      ['no receiptType', jws(appTx({ receiptType: undefined })), 403, 'wrong_environment'],
      ['not a string', 42, 400, 'invalid_request'],
    ];
    for (const [name, proof, status, error] of refusals) {
      expect([name, ...(await restore(proof))]).toEqual([name, status, { error }]);
    }
    // a valid proof without the restore flag does not join
    expect(await restore(jws(appTx()), false)).toEqual([403, { error: 'wrong_account' }]);
    expect(ids(db)).toEqual([INSTALL]);
    // the same Apple account: joins
    expect(await restore(jws(appTx()))).toEqual([200, { entitled: true, source: 'apple', expiresMs: NOW + 25 * DAY }]);
    expect(ids(db)).toEqual([INSTALL, OTHER_INSTALL].sort());
    // a member's refresh needs no proof
    expect((await appleVerify(billing, receipt, OTHER_INSTALL))[0]).toBe(200);
    // sandbox AppTransaction on a sandbox-allowing server, still under the cap
    expect((await billing.appleVerify({ signedTransaction: receipt, installId: inst(1), restore: true, signedAppTransaction: jws(appTx({ receiptType: 'Sandbox' })) }))[0]).toBe(200);
    // a production-only server refuses a sandbox AppTransaction
    const prod = setup({ env: { APPLE_IAP_ALLOW_SANDBOX: '0' } });
    expect(await prod.billing.appleVerify({ signedTransaction: receipt, installId: OTHER_INSTALL, restore: true, signedAppTransaction: jws(appTx({ receiptType: 'Sandbox' })) }))
      .toEqual([403, { error: 'wrong_environment' }]);
  });

  it('apple_restore_without_app_transaction_id_falls_back_to_cap', async () => {
    const { billing, db, clock } = setup();
    const receipt = jws(tx()); // bought before iOS 18.4: no appTransactionId
    expect((await appleVerify(billing, receipt))[0]).toBe(200);
    // no proof needed; whatever AppTransaction is sent is not consulted
    expect((await restoreApple(billing, receipt, inst(1)))[0]).toBe(200);
    expect((await billing.appleVerify({ signedTransaction: receipt, installId: inst(2), restore: true, signedAppTransaction: 'garbage' }))[0]).toBe(200);
    expect((await billing.appleVerify({ signedTransaction: receipt, installId: inst(3), restore: true, signedAppTransaction: jws(appTx({ appTransactionId: 'other' })) }))[0]).toBe(200);
    clock.t += 1000;
    expect((await restoreApple(billing, receipt, inst(4)))[0]).toBe(200);
    // the cap holds
    expect(await restoreApple(billing, receipt, inst(5))).toEqual([409, { error: 'install_limit' }]);
    expect(db.installs).toHaveLength(5);
  });

  it('google_restore_capped', async () => {
    const { billing, db, clock } = setup({ subs: { 'tok-1': subV2() } });
    const gv = (installId, restore) => billing.googleVerify({ purchaseToken: 'tok-1', productId: MONTHLY, installId, restore });
    expect((await gv(INSTALL))[0]).toBe(200);
    for (let n = 1; n <= 4; n += 1) {
      clock.t += 1000;
      expect((await gv(inst(n), true))[0]).toBe(200);
    }
    const before = ids(db);
    expect(before).toHaveLength(5);
    expect(await gv(inst(5), true)).toEqual([409, { error: 'install_limit' }]);
    expect(ids(db)).toEqual(before);
    // members refresh without the flag; the purchasing install is never refused
    expect((await gv(inst(3)))[1].entitled).toBe(true);
    expect((await gv(INSTALL))[0]).toBe(200);
    // an idle member frees its slot but stays in the set (a later call meets install_limit)
    const idleSince = db.installs.find((r) => r.install_id === inst(1)).last_seen_at;
    clock.t += 10 * DAY;
    for (const id of [INSTALL, inst(2), inst(3), inst(4)]) expect((await gv(id))[0]).toBe(200);
    clock.t = idleSince + 30 * DAY;
    expect((await gv(inst(5), true))[0]).toBe(200);
    expect(ids(db)).toContain(inst(1));
    expect(await gv(inst(1))).toEqual([409, { error: 'install_limit' }]);
  });

  it('no_restore_flag_still_refuses_a_foreign_receipt', async () => {
    const { billing, db } = setup({ subs: { 'tok-1': subV2() } });
    for (const restore of [undefined, false, 'true', 1]) {
      expect(await billing.appleVerify({ signedTransaction: jws(tx({ appAccountToken: acct(OTHER_INSTALL) })), installId: INSTALL, restore }))
        .toEqual([403, { error: 'wrong_account' }]);
      expect(await billing.googleVerify({ purchaseToken: 'tok-1', productId: MONTHLY, installId: OTHER_INSTALL, restore }))
        .toEqual([403, { error: 'wrong_account' }]);
    }
    expect(db.subs).toHaveLength(0);
    expect(db.installs).toHaveLength(0);
  });

});

describe('POST /api/billing/store/apple/notifications', () => {
  it('assn_refund_marks_refunded_once', async () => {
    const { billing, db } = setup();
    await appleVerify(billing, jws(tx()));
    const uuid = crypto.randomUUID();
    const refund = notification('REFUND', { revocationDate: NOW - 1000, revocationReason: 1 }, { uuid });

    expect(await billing.appleNotification({ signedPayload: refund })).toEqual([200, { ok: true }]);
    expect(db.subs[0].status).toBe('refunded');
    expect(db.events.has(`apple:${uuid}`)).toBe(true);

    // a reversal is a newer event; replaying the old refund must not apply again
    expect((await billing.appleNotification({ signedPayload: notification('REFUND_REVERSED') }))[0]).toBe(200);
    expect(db.subs[0].status).toBe('active');
    const mark = db.calls.length;
    expect(await billing.appleNotification({ signedPayload: refund })).toEqual([200, { ok: true }]);
    expect(writes(db, mark)).toHaveLength(0);
    expect(db.subs[0].status).toBe('active');
  });

  it('refuses a forged notification and ignores other apps and environments', async () => {
    const { billing, db } = setup();
    const good = notification('DID_RENEW');
    const [h, , s] = good.split('.');
    const forged = `${h}.${b64url({ notificationType: 'DID_RENEW', notificationUUID: 'x', data: {} })}.${s}`;
    expect(await billing.appleNotification({ signedPayload: forged })).toEqual([400, { error: 'invalid_signature' }]);
    expect(await billing.appleNotification({ signedPayload: notification('DID_RENEW', {}, { jwsOptions: { chain: ['other-leaf.pem', 'other-intermediate.pem', 'other-root.pem'], key: 'other-leaf-private-key.pem' } }) }))
      .toEqual([400, { error: 'invalid_signature' }]);
    expect(await billing.appleNotification({})).toEqual([400, { error: 'invalid_request' }]);

    // the inner transaction is verified too
    const innerForged = jws({
      notificationType: 'DID_RENEW', notificationUUID: crypto.randomUUID(), signedDate: NOW,
      data: { bundleId: 'com.mailvault.app', environment: 'Production', signedTransactionInfo: jws(tx(), { chain: ['other-leaf.pem', 'other-intermediate.pem', 'other-root.pem'], key: 'other-leaf-private-key.pem' }) },
    });
    expect(await billing.appleNotification({ signedPayload: innerForged })).toEqual([400, { error: 'invalid_signature' }]);

    expect((await billing.appleNotification({ signedPayload: notification('DID_RENEW', { bundleId: 'com.example.other' }, { data: { bundleId: 'com.example.other' } }) }))[0]).toBe(200);
    expect((await billing.appleNotification({ signedPayload: notification('DID_RENEW', { environment: 'Xcode' }) }))[0]).toBe(200);
    expect((await billing.appleNotification({ signedPayload: jws({ notificationType: 'TEST', notificationUUID: crypto.randomUUID(), signedDate: NOW, data: { bundleId: 'com.mailvault.app', environment: 'Production' } }) }))[0]).toBe(200);
    expect(db.subs).toHaveLength(0);
  });

  it('records lapses as not entitled and answers 500 on storage failure so Apple retries', async () => {
    const { billing, db } = setup();
    await appleVerify(billing, jws(tx()));
    expect((await billing.appleNotification({ signedPayload: notification('DID_FAIL_TO_RENEW', {}, { subtype: 'GRACE_PERIOD' }) }))[0]).toBe(200);
    expect(db.subs[0].status).toBe('grace');
    expect((await appleVerify(billing, jws(tx())))[1].entitled).toBe(false);

    const uuid = crypto.randomUUID();
    db.fail((q) => q.startsWith('UPDATE store_subscriptions'));
    expect(await billing.appleNotification({ signedPayload: notification('EXPIRED', {}, { uuid }) })).toEqual([500, { error: 'server_error' }]);
    expect(db.events.has(`apple:${uuid}`)).toBe(false);
  });
});

describe('POST /api/billing/store/google/verify', () => {
  const gVerify = (b, token, productId = MONTHLY, installId = INSTALL) => b.googleVerify({ purchaseToken: token, productId, installId });

  it('google_active_entitles_grace_on_hold_paused_do_not', async () => {
    const until = NOW + 25 * DAY;
    const states = [
      ['SUBSCRIPTION_STATE_ACTIVE', true, 'active'],
      ['SUBSCRIPTION_STATE_CANCELED', true, 'active'],
      ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', false, 'grace'],
      ['SUBSCRIPTION_STATE_ON_HOLD', false, 'on_hold'],
      ['SUBSCRIPTION_STATE_PAUSED', false, 'on_hold'],
      ['SUBSCRIPTION_STATE_PENDING', false, 'on_hold'],
      ['SUBSCRIPTION_STATE_EXPIRED', false, 'expired'],
    ];
    for (const [state, entitled, stored] of states) {
      const { billing, db } = setup({ subs: { 'tok-1': subV2({ subscriptionState: state }) } });
      expect([state, ...(await gVerify(billing, 'tok-1'))]).toEqual([state, 200, { entitled, source: 'google', expiresMs: until }]);
      expect(db.subs[0]).toMatchObject({ platform: 'google', original_id: 'tok-1', install_id: INSTALL, status: stored, environment: 'Production' });
    }
    // an active state whose expiry has passed is not entitled
    const { billing } = setup({ subs: { 'tok-1': subV2({}, { expiryTime: new Date(NOW - 1).toISOString() }) } });
    expect((await gVerify(billing, 'tok-1'))[1].entitled).toBe(false);
  });

  it('re-fetches the current state of a token it has seen before', async () => {
    const { billing, g, db } = setup({ subs: { 'tok-1': subV2() } });
    expect((await gVerify(billing, 'tok-1'))[1].entitled).toBe(true);
    g.state.subs['tok-1'] = subV2({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' });
    expect(await gVerify(billing, 'tok-1')).toEqual([200, { entitled: false, source: 'google', expiresMs: NOW + 25 * DAY }]);
    // an upgrade token links to the first: one row, chain root kept
    g.state.subs['tok-2'] = subV2({ linkedPurchaseToken: 'tok-1' }, { productId: YEARLY, expiryTime: new Date(NOW + 300 * DAY).toISOString() });
    expect((await gVerify(billing, 'tok-2', YEARLY))[1]).toEqual({ entitled: true, source: 'google', expiresMs: NOW + 300 * DAY });
    expect(db.subs).toHaveLength(1);
    expect(db.subs[0]).toMatchObject({ original_id: 'tok-1', latest_token: 'tok-2', product_id: YEARLY });
  });

  it('google_wrong_package_or_account_refused', async () => {
    const { billing, g, db } = setup({
      subs: {
        'tok-1': subV2(),
        'tok-other-acct': subV2({ externalAccountIdentifiers: { obfuscatedExternalAccountId: obfuscatedAccountId(OTHER_INSTALL) } }),
        'tok-no-acct': subV2({ externalAccountIdentifiers: undefined }),
        'tok-yearly': subV2({}, { productId: YEARLY }),
        'tok-test': subV2({ testPurchase: {} }),
      },
    });
    // a token of another package is unknown under ours: Google answers 404
    expect(await gVerify(billing, 'tok-foreign-package')).toEqual([403, { error: 'unknown_purchase' }]);
    expect(g.calls.some((c) => c.url.includes('/applications/com.mailvault.app/purchases/subscriptionsv2/tokens/tok-foreign-package'))).toBe(true);
    g.state.subsStatus['tok-gone'] = 410;
    expect(await gVerify(billing, 'tok-gone')).toEqual([403, { error: 'unknown_purchase' }]);
    expect(await gVerify(billing, 'tok-other-acct')).toEqual([403, { error: 'wrong_account' }]);
    expect(await gVerify(billing, 'tok-no-acct')).toEqual([403, { error: 'wrong_account' }]);
    expect(await gVerify(billing, 'tok-1', MONTHLY, OTHER_INSTALL)).toEqual([403, { error: 'wrong_account' }]);
    expect(await gVerify(billing, 'tok-yearly', MONTHLY)).toEqual([403, { error: 'wrong_product' }]);
    const before = g.calls.length;
    expect(await gVerify(billing, 'tok-1', 'com.other.app.premium')).toEqual([403, { error: 'wrong_product' }]);
    expect(await billing.googleVerify({ purchaseToken: 'tok-1', productId: MONTHLY })).toEqual([400, { error: 'invalid_request' }]);
    expect(await billing.googleVerify({ purchaseToken: 'a/../b', productId: MONTHLY, installId: INSTALL })).toEqual([400, { error: 'invalid_request' }]);
    // The purchase shows only sha256(install id): posted as the install id it is no install id
    // at all, and no UUID hashes to it, so a token holder cannot pass as the buying install.
    expect(await billing.googleVerify({ purchaseToken: 'tok-1', productId: MONTHLY, installId: obfuscatedAccountId(INSTALL) }))
      .toEqual([400, { error: 'invalid_request' }]);
    expect(g.calls.length).toBe(before);
    expect(db.subs).toHaveLength(0);

    // license-tester purchases are accepted by default (Play review, test tracks) and
    // recorded as Test; GOOGLE_PLAY_ALLOW_TEST=0 turns that off
    const sb = setup({ subs: { 'tok-test': subV2({ testPurchase: {} }) } });
    expect((await gVerify(sb.billing, 'tok-test'))[1].entitled).toBe(true);
    expect(sb.db.subs[0].environment).toBe('Test');
    const off = setup({ env: { GOOGLE_PLAY_ALLOW_TEST: '0' }, subs: { 'tok-test': subV2({ testPurchase: {} }) } });
    expect(await gVerify(off.billing, 'tok-test')).toEqual([403, { error: 'wrong_environment' }]);
    expect(off.db.subs).toHaveLength(0);
  });

  it('a refund seen only through the fetch lands: Google moves the expiry back', async () => {
    const { billing, g, db } = setup({ subs: { 'tok-1': subV2({}, { expiryTime: new Date(NOW + 365 * DAY).toISOString() }) } });
    expect((await gVerify(billing, 'tok-1'))[1].entitled).toBe(true);
    // refunded on Play, no RTDN: subscriptionsv2 says EXPIRED at the refund time
    g.state.subs['tok-1'] = subV2({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }, { expiryTime: new Date(NOW - 1000).toISOString() });
    expect(await gVerify(billing, 'tok-1')).toEqual([200, { entitled: false, source: 'google', expiresMs: NOW - 1000 }]);
    expect(db.subs[0]).toMatchObject({ status: 'expired', expires_at: NOW - 1000 });
    // an older token of the chain cannot lower what the current token says
    g.state.subs['tok-2'] = subV2({ linkedPurchaseToken: 'tok-1' }, { productId: YEARLY, expiryTime: new Date(NOW + 300 * DAY).toISOString() });
    expect((await gVerify(billing, 'tok-2', YEARLY))[1].entitled).toBe(true);
    expect((await gVerify(billing, 'tok-1'))[1]).toEqual({ entitled: true, source: 'google', expiresMs: NOW + 300 * DAY });
    expect(db.subs[0]).toMatchObject({ latest_token: 'tok-2', status: 'active', expires_at: NOW + 300 * DAY });
  });

  it('records the purchasing install only, never a restoring one', async () => {
    const { billing, db } = setup({ subs: { 'tok-1': subV2() } });
    // first seen through a restore from another install
    expect((await billing.googleVerify({ purchaseToken: 'tok-1', productId: MONTHLY, installId: OTHER_INSTALL, restore: true }))[0]).toBe(200);
    expect(db.subs[0].install_id).toBeNull();
    expect(db.installs.map((r) => r.install_id)).toEqual([OTHER_INSTALL]);
    expect((await gVerify(billing, 'tok-1'))[0]).toBe(200);
    expect(db.subs[0].install_id).toBe(INSTALL);
  });

  it('google_ack_only_after_record', async () => {
    const pending = () => subV2({ acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING' });
    const isAck = (c) => c.url.endsWith(':acknowledge');

    // storage fails: 500, nothing acknowledged
    const down = setup({ subs: { 'tok-1': pending() } });
    down.db.fail((q) => q.startsWith('INSERT') || q.startsWith('UPDATE'));
    expect(await gVerify(down.billing, 'tok-1')).toEqual([500, { error: 'server_error' }]);
    expect(down.g.calls.filter(isAck)).toHaveLength(0);

    // recorded first, then acknowledged once with the v1 subscriptions URL
    const order = [];
    const { billing, g, db, ref } = setup({ subs: { 'tok-1': pending() } });
    const exec = db.execute.bind(db);
    db.execute = async (q, p) => { if (/^\s*(INSERT|UPDATE) .*store_subscriptions/s.test(q)) order.push('record'); return exec(q, p); };
    const f = g.fetch;
    ref.fetch = (async (u, o) => { if (String(u).endsWith(':acknowledge')) order.push('ack'); return f(u, o); });
    expect((await gVerify(billing, 'tok-1'))[0]).toBe(200);
    expect(order).toEqual(['record', 'ack']);
    const ack = g.calls.find(isAck);
    expect(ack.url).toBe(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.mailvault.app/purchases/subscriptions/${MONTHLY}/tokens/tok-1:acknowledge`);

    // already acknowledged: no call; not entitled: no call
    const done = setup({ subs: { 'tok-1': subV2(), 'tok-2': subV2({ subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING' }) } });
    await gVerify(done.billing, 'tok-1');
    await gVerify(done.billing, 'tok-2');
    expect(done.g.calls.filter(isAck)).toHaveLength(0);

    // a failed acknowledge still answers the valid purchase (retried next time)
    const af = setup({ subs: { 'tok-1': pending() } });
    af.g.state.ackFail = true;
    expect((await gVerify(af.billing, 'tok-1'))[1].entitled).toBe(true);
  });

  it('5xx when Google or our credentials fail, 503 when unconfigured; caches the token', async () => {
    const { billing, g, clock, ref } = setup({ subs: { 'tok-1': subV2() }, tokenTtl: 3600 });
    await gVerify(billing, 'tok-1');
    await gVerify(billing, 'tok-1');
    expect(g.state.tokenFetches).toBe(1);
    clock.t = NOW + 3600 * 1000 - 59_000; // inside the last minute: refreshed
    await gVerify(billing, 'tok-1');
    expect(g.state.tokenFetches).toBe(2);

    for (const code of [401, 403, 429, 500, 503]) {
      g.state.subsStatus['tok-1'] = code;
      expect([code, ...(await gVerify(billing, 'tok-1'))]).toEqual([code, 502, { error: 'upstream_error' }]);
    }
    ref.fetch = async () => { throw new Error('ECONNRESET'); };
    expect(await gVerify(billing, 'tok-x')).toEqual([502, { error: 'upstream_error' }]);

    const un = setup({ env: { GOOGLE_PLAY_SA_JSON: '' }, subs: { 'tok-1': subV2() } });
    expect(await gVerify(un.billing, 'tok-1')).toEqual([503, { error: 'not_configured' }]);
  });
});

describe('POST /api/billing/store/google/rtdn', () => {
  const push = (token, { type = 4, messageId = String(Math.floor(Math.random() * 1e12)), packageName = 'com.mailvault.app', subscriptionId = MONTHLY } = {}) => ({
    message: {
      messageId,
      publishTime: new Date(NOW).toISOString(),
      data: Buffer.from(JSON.stringify({
        version: '1.0', packageName, eventTimeMillis: String(NOW),
        subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: token, subscriptionId },
      })).toString('base64'),
    },
    subscription: 'projects/test-project/subscriptions/rtdn-push',
  });
  const bearer = (claims, opts) => `Bearer ${signJwt(oidcClaims(claims), opts)}`;

  it('rtdn_bad_audience_or_email_rejected', async () => {
    const { billing, db, g } = setup({ subs: { 'tok-1': subV2() } });
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bad = [
      ['no header', undefined],
      ['not bearer', 'Basic abc'],
      ['wrong audience', bearer({ aud: 'https://evil.example/rtdn' })],
      ['wrong email', bearer({ email: 'someone@evil.example' })],
      ['email not verified', bearer({ email_verified: false })],
      ['wrong issuer', bearer({ iss: 'https://evil.example' })],
      ['expired', bearer({ exp: Math.floor(NOW / 1000) - 600, iat: Math.floor(NOW / 1000) - 4200 })],
      ['wrong key', bearer({}, { key: other.privateKey })],
      ['unknown kid', bearer({}, { kid: 'nope' })],
      ['HS256', bearer({}, { alg: 'HS256' })],
    ];
    for (const [name, authorization] of bad) {
      const r = await billing.googleRtdn({ authorization, body: push('tok-1') });
      expect([name, ...r]).toEqual([name, 401, { error: 'unauthorized' }]);
    }
    expect(db.subs).toHaveLength(0);
    expect(g.calls.some((c) => c.url.includes('subscriptionsv2'))).toBe(false);

    // the good one goes through, and the JWKS is cached
    const good = bearer({});
    expect(await billing.googleRtdn({ authorization: good, body: push('tok-1') })).toEqual([200, { ok: true }]);
    expect(await billing.googleRtdn({ authorization: good, body: push('tok-1') })).toEqual([200, { ok: true }]);
    expect(db.subs[0]).toMatchObject({ platform: 'google', original_id: 'tok-1', status: 'active', install_id: null });
    expect(g.state.jwksFetches).toBeLessThanOrEqual(2);

    const unconf = setup({ env: { GOOGLE_RTDN_AUDIENCE: '' } });
    expect(await unconf.billing.googleRtdn({ authorization: good, body: push('tok-1') })).toEqual([503, { error: 'not_configured' }]);
  });

  it('is idempotent by messageId, records revocations, acknowledges a pending purchase', async () => {
    const { billing, db, g } = setup({ subs: { 'tok-1': subV2({ acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING' }) } });
    const auth = bearer({});
    expect((await billing.googleRtdn({ authorization: auth, body: push('tok-1', { type: 4, messageId: 'm1' }) }))[0]).toBe(200);
    expect(g.calls.filter((c) => c.url.endsWith(':acknowledge'))).toHaveLength(1);
    const fetches = g.calls.length;
    expect((await billing.googleRtdn({ authorization: auth, body: push('tok-1', { type: 4, messageId: 'm1' }) }))[0]).toBe(200);
    expect(g.calls.length).toBe(fetches);

    // revoked: Google now reports it expired at the revocation time
    g.state.subs['tok-1'] = subV2({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }, { expiryTime: new Date(NOW - 1000).toISOString() });
    expect((await billing.googleRtdn({ authorization: auth, body: push('tok-1', { type: 12, messageId: 'm2' }) }))[0]).toBe(200);
    expect(db.subs[0].status).toBe('revoked');
    expect(await billing.googleVerify({ purchaseToken: 'tok-1', productId: MONTHLY, installId: INSTALL })).toEqual([403, { error: 'revoked' }]);

    // other packages, unknown tokens and test messages are acknowledged and dropped
    expect((await billing.googleRtdn({ authorization: auth, body: push('tok-1', { packageName: 'com.other.app', messageId: 'm3' }) }))[0]).toBe(200);
    expect((await billing.googleRtdn({ authorization: auth, body: push('tok-unknown', { messageId: 'm4' }) }))[0]).toBe(200);
    const testMsg = { message: { messageId: 'm5', data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.mailvault.app', testNotification: { version: '1.0' } })).toString('base64') } };
    expect((await billing.googleRtdn({ authorization: auth, body: testMsg }))[0]).toBe(200);
    expect(db.subs).toHaveLength(1);

    // Google down: 5xx so Pub/Sub retries, message not marked
    g.state.subsStatus['tok-1'] = 503;
    expect(await billing.googleRtdn({ authorization: auth, body: push('tok-1', { messageId: 'm6' }) })).toEqual([502, { error: 'upstream_error' }]);
    expect(db.events.has('google:m6')).toBe(false);
    // storage down: 500, not marked
    delete g.state.subsStatus['tok-1'];
    db.fail((q) => q.startsWith('SELECT event_id'));
    expect(await billing.googleRtdn({ authorization: auth, body: push('tok-1', { messageId: 'm7' }) })).toEqual([500, { error: 'server_error' }]);
    expect(db.events.has('google:m6')).toBe(false);
  });
});

describe('mergeState', () => {
  const row = { expiresMs: 100, status: 'active', productId: MONTHLY, environment: 'Production', installId: INSTALL, latestToken: null };
  it('keeps the latest expiry and never lets an older receipt undo a refund', () => {
    expect(mergeState(row, { ...row, expiresMs: 50 }, 'receipt').expiresMs).toBe(100);
    expect(mergeState(row, { ...row, expiresMs: 200 }, 'receipt').expiresMs).toBe(200);
    const refunded = { ...row, status: 'refunded' };
    expect(mergeState(refunded, { ...row }, 'receipt').status).toBe('refunded');
    expect(mergeState(refunded, { ...row }, 'notice').status).toBe('refunded');
    expect(mergeState(refunded, { ...row }, 'reversal').status).toBe('active');
    expect(mergeState(refunded, { ...row, expiresMs: 200 }, 'receipt').status).toBe('active');
  });

  it('takes the current token\'s fetch as is, a lower expiry too, but keeps a refund', () => {
    expect(mergeState(row, { ...row, expiresMs: 50, status: 'expired' }, 'current')).toMatchObject({ expiresMs: 50, status: 'expired' });
    expect(mergeState(row, { ...row, expiresMs: 50, status: 'expired' }, 'fetch')).toMatchObject({ expiresMs: 100, status: 'active' });
    const refunded = { ...row, status: 'refunded' };
    expect(mergeState(refunded, { ...row, expiresMs: 100 }, 'current').status).toBe('refunded');
    expect(mergeState(refunded, { ...row, expiresMs: 50 }, 'current')).toMatchObject({ status: 'refunded', expiresMs: 100 });
  });
});

// server.js cannot boot under vitest: check the wiring in its source.
describe('server wiring', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'api', 'server.js'), 'utf8');
  const database = fs.readFileSync(path.join(__dirname, '..', 'api', 'database.js'), 'utf8');

  it('rate-limits verify per visitor and per install (429) and leaves the signed webhooks unlimited', () => {
    expect(server).toMatch(/app\.post\('\/api\/billing\/store\/apple\/verify', storeVerifyLimiter, storeInstallLimiter,/);
    expect(server).toMatch(/app\.post\('\/api\/billing\/store\/google\/verify', storeVerifyLimiter, storeInstallLimiter,/);
    expect(server).toMatch(/const storeVerifyLimiter = rateLimit\(\{[^}]*keyGenerator: visitorIP,/);
    expect(server).toMatch(/const storeInstallLimiter = rateLimit\(\{[^}]*keyGenerator: storeInstallKey,/);
    expect(server).toMatch(/skip: \(req\) => STORE_WEBHOOKS\.has\(req\.path\) \|\| STORE_VERIFY\.has\(req\.path\)/);
    expect(server).toMatch(/app\.post\('\/api\/billing\/store\/apple\/notifications',\n\s+storeRoute\(/);
    expect(server).toMatch(/app\.post\('\/api\/billing\/store\/google\/rtdn',\n\s+storeRoute\(/);
    expect(server).toMatch(/authorization: req\.headers\.authorization/);
  });

  it('creates both tables at startup', () => {
    expect(database).toMatch(/CREATE TABLE IF NOT EXISTS store_subscriptions/);
    expect(database).toMatch(/UNIQUE KEY unique_platform_original \(platform, original_id\)/);
    expect(database).toMatch(/CREATE TABLE IF NOT EXISTS processed_store_events/);
  });
});
