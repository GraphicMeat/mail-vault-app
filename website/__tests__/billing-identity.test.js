import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  findCustomer, findCustomerByLegacyEmail, findSeatHolder, seatRefreshOpen, legacyEmailSignInOpen, legacyEmailSignInExpired, legacyView, LAST_EMAIL_SIGNIN_VERSION, LEGACY_EMAIL_SIGNIN_UNTIL,
  APP_UPDATE_REQUIRED,
  adminAuthorized, CUSTOMER_ID_REQUIRED,
} = require('../api/billing-identity.js');

const SEAT_SQL = 'SELECT c.* FROM billing_customers c JOIN billing_clients k ON k.billing_customer_id = c.id '
  + 'WHERE c.email = ? AND k.client_id = ? AND k.revoked_at IS NULL LIMIT 1';

function fakeDb(byId, byEmail = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, p) {
      calls.push(sql);
      if (sql === 'SELECT * FROM billing_customers WHERE stripe_customer_id = ?') return [byId[p[0]] ? [byId[p[0]]] : []];
      if (sql === 'SELECT * FROM billing_customers WHERE email = ?') return [byEmail[p[0]] ? [byEmail[p[0]]] : []];
      if (sql === SEAT_SQL) {
        const row = byEmail[p[0]];
        return [row && (row.seats || []).includes(p[1]) ? [row] : []];
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
}

// Server deployed code sign-in (11-24) before any app release had the code screen: 2.25.0
// signs in by address alone. Address sign-in stays open for 2.25.0 and older until the end
// of spring 2027 (through 31 May, UTC); from 2.25.1 the app must sign in with the code.
describe('legacy address sign-in for 2.25.0 and older, until the end of spring 2027', () => {
  const SPRING = Date.UTC(2027, 4, 31, 23, 59, 59);
  const open = (appVersion, now = Date.UTC(2026, 10, 25)) => legacyEmailSignInOpen({ appVersion, register: '1', now });

  it('names 2.25.0 as the last app that signs in by address, and 1 June 2027 as the end', () => {
    expect(LAST_EMAIL_SIGNIN_VERSION).toBe('2.25.0');
    expect(LEGACY_EMAIL_SIGNIN_UNTIL).toBe(Date.UTC(2027, 5, 1));
  });

  it('opens for 2.25.0 and older through 31 May 2027', () => {
    expect(open('2.25.0')).toBe(true);
    expect(open('2.24.3')).toBe(true);
    expect(open('1.9.0')).toBe(true);
    expect(open('2.25.0', SPRING)).toBe(true);
  });

  it('closes from 1 June 2027', () => {
    expect(open('2.25.0', Date.UTC(2027, 5, 1))).toBe(false);
    expect(open('2.25.0', Date.UTC(2028, 0, 1))).toBe(false);
  });

  // From 1 June 2027 the path is shut by the clock alone, and an old app is told what to do
  // instead of being asked for a code it has no screen for.
  it('from 1 June 2027 tells 2.25.0 and older to update instead', () => {
    const expired = (appVersion, now) => legacyEmailSignInExpired({ appVersion, now });
    expect(expired('2.25.0', Date.UTC(2027, 5, 1))).toBe(true);
    expect(expired('1.9.0', Date.UTC(2028, 0, 1))).toBe(true);
    expect(expired('2.25.0', SPRING)).toBe(false);
    expect(expired('2.26.0', Date.UTC(2027, 5, 1))).toBe(false);
    for (const a of [undefined, '', 'x']) expect(expired(a, Date.UTC(2027, 5, 1)), String(a)).toBe(false);
  });

  it('the update error names the version to move past', () => {
    expect(APP_UPDATE_REQUIRED.error).toBe('app_update_required');
    expect(APP_UPDATE_REQUIRED.message).toMatch(/Update MailVault to a version newer than 2\.25\.0/);
    expect(APP_UPDATE_REQUIRED.message).toMatch(/code we email you/);
  });

  it('the status route answers an expired old app with the update error', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    const start = src.indexOf("'/api/billing/subscription-status'");
    const body = src.slice(start, src.indexOf('\napp.', start + 1));
    const expiredAt = body.indexOf('if (legacyEmailSignInExpired({ appVersion, now })) return res.status(426).json(APP_UPDATE_REQUIRED);');
    expect(expiredAt).toBeGreaterThan(0);
    expect(body.indexOf('legacyEmailSignInOpen(')).toBeGreaterThan(expiredAt);
  });

  // The reminder. Goes red in the nightly CI run from 1 June 2027 on purpose.
  it('REMINDER: address sign-in for 2.25.0 ends 31 May 2027, then delete it', () => {
    expect(Date.now(), '31 May 2027 has passed. Delete legacyEmailSignInOpen, findCustomerByLegacyEmail, '
      + 'legacyView, the legacy branch of /api/billing/subscription-status and their tests. Keep '
      + 'legacyEmailSignInExpired and APP_UPDATE_REQUIRED so old apps are still told to update.')
      .toBeLessThan(LEGACY_EMAIL_SIGNIN_UNTIL);
  });

  it('stays closed for 2.25.1, 2.26.0 and later, which have code sign-in', () => {
    expect(open('2.25.1')).toBe(false);
    expect(open('2.26.0')).toBe(false);
    expect(open('3.0.0')).toBe(false);
  });

  it('stays closed when the app version is unknown or malformed', () => {
    for (const a of [undefined, '', 'x', ['2.25.0'], 'v2.25.0']) expect(open(a), String(a)).toBe(false);
  });

  it('only for the sign-in call that registers this device (what 2.25.0 sends)', () => {
    expect(legacyEmailSignInOpen({ appVersion: '2.25.0', now: Date.UTC(2026, 10, 25) })).toBe(false);
    expect(legacyEmailSignInOpen({ appVersion: '2.25.0', register: '0', now: Date.UTC(2026, 10, 25) })).toBe(false);
  });

  it('finds the customer by lower-cased address, and nobody for a non-address', async () => {
    const row = { id: 7, stripe_customer_id: 'cus_7', email: 'payer@b.test' };
    const db = fakeDb({}, { 'payer@b.test': row });
    expect(await findCustomerByLegacyEmail(db, ' Payer@B.test ')).toBe(row);
    expect(await findCustomerByLegacyEmail(db, 'other@b.test')).toBeUndefined();
    const quiet = fakeDb({});
    for (const e of [undefined, null, '', 42, ['payer@b.test']]) expect(await findCustomerByLegacyEmail(quiet, e)).toBeUndefined();
    expect(quiet.calls).toEqual([]);
  });

  it('the status route reaches the address only through the gate', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    const start = src.indexOf("'/api/billing/subscription-status'");
    const body = src.slice(start, src.indexOf('\napp.', start + 1));
    const gate = body.indexOf('legacyEmailSignInOpen(');
    const lookup = body.indexOf('findCustomerByLegacyEmail(');
    expect(gate).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(gate);
    expect(body).toMatch(/const now = Date\.now\(\);[\s\S]*legacyEmailSignInOpen\(\{ appVersion, register, now \}\)/);
  });

  // The Stripe id is the key to the billing portal (cancel, invoices, card) and to removing
  // devices: an address must never be traded for it. 2.25.0 hides Manage and the device list
  // without it and keeps Premium on clientAccessGranted.
  it('answers an address sign-in without the customer id or anyone\'s devices', () => {
    const full = {
      customerId: 'cus_7', customerEmail: 'payer@b.test', hasSubscription: true, status: 'active',
      premiumAccess: true, clientAccessGranted: true, activeClientCount: 2,
      activeClients: [{ clientId: 'c1', clientName: 'Payer MacBook' }],
      replacedClient: { clientId: 'c0', clientName: 'Old Mac' },
    };
    const view = legacyView(full);
    expect(view.customerId).toBeNull();
    expect(view.activeClients).toEqual([]);
    expect(view).not.toHaveProperty('replacedClient');
    expect(view).toMatchObject({ hasSubscription: true, status: 'active', premiumAccess: true, clientAccessGranted: true });
    expect(full.customerId).toBe('cus_7'); // the input is left alone
    expect(JSON.stringify(view)).not.toContain('cus_7');
  });

  it('the status route answers the address path through legacyView and never caches it', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    const start = src.indexOf("'/api/billing/subscription-status'");
    const body = src.slice(start, src.indexOf('\napp.', start + 1));
    // One cache write in the route, and the address path has already answered before it.
    expect(body.match(/setCachedBilling\(/g)).toHaveLength(1);
    expect(body).toMatch(/if \(legacy\) return res\.json\(legacyView\(body\)\);\s*setCachedBilling\(cacheKey, body\);/);
    expect(body.match(/res\.json\(/g).length).toBeLessThanOrEqual(4); // 400, legacy, reply, 500
  });

  // At the device limit a code sign-in replaces the oldest device. An address alone must
  // never do that: anyone could keep signing the owner's Macs out of Premium.
  it('an address sign-in never revokes a device; at the limit it gets no seat', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    const start = src.indexOf("'/api/billing/subscription-status'");
    const body = src.slice(start, src.indexOf('\napp.', start + 1));
    const guard = body.indexOf('if (full && legacy)');
    const revoke = body.indexOf('SET revoked_at = NOW()');
    const insert = body.indexOf('INSERT INTO billing_clients');
    expect(guard).toBeGreaterThan(0);
    expect(revoke).toBeGreaterThan(guard);
    expect(insert).toBeGreaterThan(guard);
    expect(body.match(/SET revoked_at = NOW\(\)/g)).toHaveLength(1);
  });

  it('no other billing route takes an address', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    for (const route of ['/api/billing/register-client', '/api/billing/unregister-client', '/api/billing/portal-session']) {
      const start = src.indexOf(`'${route}'`);
      const body = src.slice(start, src.indexOf('\napp.', start + 1));
      expect(body, route).not.toMatch(/findCustomerByLegacyEmail|legacyEmailSignInOpen/);
    }
  });
});

// A computer signed in by address on 2.25.0 holds a device seat but no Stripe id. After the
// update (2.25.1+) it must stay signed in without a code: the seat it already holds is the
// proof. It is answered like an address sign-in (no Stripe id, no device list) and it can
// never take a new seat, so it gives nobody more than the 2.25.0 address path already did.
describe('seat refresh: a device signed in by address stays signed in after the update', () => {
  const NOW = Date.UTC(2026, 10, 26);
  const open = (appVersion, now = NOW) => seatRefreshOpen({ appVersion, register: '1', now });

  it('opens for apps newer than 2.25.0 until the address path closes', () => {
    expect(open('2.25.1')).toBe(true);
    expect(open('2.25.1-nightly.202611260900.gabc')).toBe(true);
    expect(open('2.26.0')).toBe(true);
    expect(open('2.25.1', Date.UTC(2027, 5, 1) - 1)).toBe(true);
    expect(open('2.25.1', Date.UTC(2027, 5, 1))).toBe(false);
  });

  // Without register the route would read the status cache, keyed by the Stripe id, and
  // answer the full body (Stripe id, device list) to anyone holding the address + device id.
  it('only for the call that registers this device', () => {
    expect(seatRefreshOpen({ appVersion: '2.25.1', now: NOW })).toBe(false);
    expect(seatRefreshOpen({ appVersion: '2.25.1', register: '0', now: NOW })).toBe(false);
  });

  it('the status cache is never read for an address or seat answer', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    const start = src.indexOf("'/api/billing/subscription-status'");
    const body = src.slice(start, src.indexOf('\napp.', start + 1));
    expect(body).toMatch(/if \(!register && !legacy\) \{\s*const cached = getCachedBilling\(cacheKey\);/);
  });

  it('is not for 2.25.0 and older (they keep the address path) or a malformed version', () => {
    expect(open('2.25.0')).toBe(false);
    expect(open('2.24.9')).toBe(false);
    for (const a of [undefined, '', 'x', ['2.25.1']]) expect(open(a), String(a)).toBe(false);
  });

  it('finds the customer only when this device already holds a live seat', async () => {
    const row = { id: 7, stripe_customer_id: 'cus_7', email: 'payer@b.test', seats: ['client-held'] };
    const db = fakeDb({}, { 'payer@b.test': row });
    expect(await findSeatHolder(db, ' Payer@B.test ', 'client-held')).toBe(row);
    expect(await findSeatHolder(db, 'payer@b.test', 'client-other')).toBeUndefined();
    const quiet = fakeDb({});
    for (const [e, c] of [['payer@b.test', ''], ['payer@b.test', undefined], ['', 'client-held'], [42, 'x'], ['a@b.test', ['x']]]) {
      expect(await findSeatHolder(quiet, e, c)).toBeUndefined();
    }
    expect(quiet.calls).toEqual([]);
  });

  it('the status route gates it, answers through legacyView, and never adds a seat for it', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    const start = src.indexOf("'/api/billing/subscription-status'");
    const body = src.slice(start, src.indexOf('\napp.', start + 1));
    const gate = body.indexOf('seatRefreshOpen({ appVersion, register, now })');
    const lookup = body.indexOf('findSeatHolder(db, req.query.email, clientId)');
    expect(gate).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(gate);
    expect(body.slice(gate, gate + 400)).toMatch(/legacy = true;/);
    expect(body).toMatch(/if \(seatOnly\) \{[^}]*\} else if \(full && legacy\)/);
  });
});

describe('billing identity', () => {
  it('finds a customer by Stripe customer id only', async () => {
    const db = fakeDb({ cus_1: { id: 1, stripe_customer_id: 'cus_1', email: 'a@b.test' } });
    expect((await findCustomer(db, 'cus_1')).id).toBe(1);
    expect(await findCustomer(db, 'cus_2')).toBeUndefined();
  });

  it('never queries without a customer id (an email alone names nobody)', async () => {
    const db = fakeDb({});
    for (const id of [undefined, null, '', 42, ['cus_1']]) expect(await findCustomer(db, id)).toBeUndefined();
    expect(db.calls).toEqual([]);
  });

  it('tells an old app what to do', () => {
    expect(CUSTOMER_ID_REQUIRED.error).toBe('customer_id_required');
  });

  // Every billing route that names a customer (status, device register and unregister, the
  // Stripe portal) goes through findCustomer: none may fall back to the address.
  it('no device or portal route looks a customer up by email', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    for (const route of ['/api/billing/subscription-status', '/api/billing/register-client',
      '/api/billing/unregister-client', '/api/billing/portal-session']) {
      const start = src.indexOf(`'${route}'`);
      expect(start, route).toBeGreaterThan(0);
      const body = src.slice(start, src.indexOf('\napp.', start + 1));
      expect(body, route).not.toMatch(/WHERE email/);
      expect(body, route).toMatch(/findCustomer\(/);
    }
  });

  // Checkout finds an existing customer by the typed address; handing that id back would undo
  // all of the above (the id unlocks status, a device seat and the Stripe portal).
  it('checkout never answers with a customer id', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    const start = src.indexOf("'/api/billing/checkout-session'");
    const body = src.slice(start, src.indexOf('\napp.', start + 1));
    expect(body).toMatch(/res\.json\(\{ url: session\.url/);
    expect(body).not.toMatch(/res\.json\([^)]*customerId/);
  });
});

describe('admin key', () => {
  const KEY = 'k'.repeat(32);
  it('lets the right key in', () => expect(adminAuthorized(KEY, KEY)).toBe(true));
  it('keeps a wrong or missing key out', () => {
    expect(adminAuthorized('x'.repeat(32), KEY)).toBe(false);
    expect(adminAuthorized(undefined, KEY)).toBe(false);
    expect(adminAuthorized(['k'], KEY)).toBe(false);
  });
  it('stays closed while ADMIN_KEY is unset or weak, even with no header', () => {
    expect(adminAuthorized(undefined, undefined)).toBe(false);
    expect(adminAuthorized('', '')).toBe(false);
    expect(adminAuthorized('short', 'short')).toBe(false);
  });
  it('both admin routes use it', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    expect(src.match(/adminAuthorized\(req\.headers\['x-admin-key'\], process\.env\.ADMIN_KEY\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/!== process\.env\.ADMIN_KEY/);
  });
});
