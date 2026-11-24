import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { findCustomer, adminAuthorized, CUSTOMER_ID_REQUIRED } = require('../api/billing-identity.js');

function fakeDb(byId) {
  const calls = [];
  return {
    calls,
    async execute(sql, p) {
      calls.push(sql);
      if (sql === 'SELECT * FROM billing_customers WHERE stripe_customer_id = ?') return [byId[p[0]] ? [byId[p[0]]] : []];
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
}

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
