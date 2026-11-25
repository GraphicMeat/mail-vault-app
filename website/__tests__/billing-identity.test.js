import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  findCustomer, findCustomerByLegacyEmail, legacyEmailSignInOpen, legacyView, LAST_EMAIL_SIGNIN_VERSION,
  adminAuthorized, CUSTOMER_ID_REQUIRED,
} = require('../api/billing-identity.js');

function fakeDb(byId, byEmail = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, p) {
      calls.push(sql);
      if (sql === 'SELECT * FROM billing_customers WHERE stripe_customer_id = ?') return [byId[p[0]] ? [byId[p[0]]] : []];
      if (sql === 'SELECT * FROM billing_customers WHERE email = ?') return [byEmail[p[0]] ? [byEmail[p[0]]] : []];
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
}

// Server deployed code sign-in (11-24) before any app release had the code screen: 2.25.0
// signs in by address alone and has nothing to update to, so a new payer could never turn
// Premium on. Address sign-in stays open for those apps only until a newer release is
// published, then closes by itself.
describe('legacy address sign-in, until the code sign-in app is released', () => {
  const open = (appVersion, latestVersion, register = '1') => legacyEmailSignInOpen({ appVersion, latestVersion, register });

  it('names 2.25.0 as the last app that signs in by address', () => {
    expect(LAST_EMAIL_SIGNIN_VERSION).toBe('2.25.0');
  });

  it('opens for 2.25.0 and older while no newer release is published', () => {
    expect(open('2.25.0', '2.25.0')).toBe(true);
    expect(open('2.24.3', '2.25.0')).toBe(true);
    expect(open('1.9.0', '2.25.0')).toBe(true);
  });

  it('closes by itself once a newer release is published (patch or minor)', () => {
    expect(open('2.25.0', '2.25.1')).toBe(false);
    expect(open('2.25.0', '2.26.0')).toBe(false);
    expect(open('2.25.0', '3.0.0')).toBe(false);
  });

  it('stays closed for an app that has code sign-in', () => {
    expect(open('2.25.1', '2.25.0')).toBe(false);
    expect(open('2.26.0', '2.25.0')).toBe(false);
  });

  it('stays closed when either version is unknown or malformed', () => {
    for (const [a, l] of [[undefined, '2.25.0'], ['', '2.25.0'], ['x', '2.25.0'], [['2.25.0'], '2.25.0'],
      ['2.25.0', null], ['2.25.0', undefined], ['2.25.0', 'v-next']]) {
      expect(open(a, l), `${a} / ${l}`).toBe(false);
    }
  });

  it('only for the sign-in call that registers this device (what 2.25.0 sends)', () => {
    expect(legacyEmailSignInOpen({ appVersion: '2.25.0', latestVersion: '2.25.0' })).toBe(false);
    expect(open('2.25.0', '2.25.0', '0')).toBe(false);
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
    // The gate reads the latest PUBLISHED release, so publishing closes it with no deploy.
    expect(body).toMatch(/latestPublishedVersion\(/);
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

  it('no other billing route takes an address', () => {
    const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
    for (const route of ['/api/billing/register-client', '/api/billing/unregister-client', '/api/billing/portal-session']) {
      const start = src.indexOf(`'${route}'`);
      const body = src.slice(start, src.indexOf('\napp.', start + 1));
      expect(body, route).not.toMatch(/findCustomerByLegacyEmail|legacyEmailSignInOpen/);
    }
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
