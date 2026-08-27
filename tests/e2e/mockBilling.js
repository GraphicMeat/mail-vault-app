/**
 * The mock subscription server.
 *
 * It is deliberately NOT a server process, the way `mockImap.js` is. A Tauri
 * e2e cannot talk to a loopback HTTP stub: WKWebView treats the `tauri://`
 * origin as secure and blocks plaintext http as mixed content, and
 * `tauri.conf.json` only allows `connect-src http://localhost:*` — every
 * request from a real stub server died as `TypeError: Load failed`. So the
 * seam is `window.fetch` inside the page, which is also the exact place the app
 * leaves the machine: everything above it (BillingSettings → billingRequest →
 * billingApi → fetch) is the shipped code path, and no product file carries a
 * test hook.
 *
 * The shim answers `/api/billing/*` from a mode the spec sets per test, and
 * echoes the request's own `customerId` / `email` back — a stub that invents
 * its own identifiers makes the app adopt them, which reads as a product bug.
 *
 * Usage:
 *   await installMockBilling();
 *   await setBillingMode('premium');       // what the server says
 *   await setBillingFault('rate_limited'); // or how it fails
 *   await openBillingAs(CUSTOMERS.premium, email);
 */

import { openSettings, closeSettings, clickSettingsNav } from './helpers.js';

export const CUSTOMERS = {
  premium: 'cus_premium_mock',
  lapsed: 'cus_lapsed_mock',
  seat: 'cus_seat_denied_mock',
};

/**
 * Every mode the server can be in. Names match what `signInFailureNotice`
 * distinguishes, so a spec asserting copy can name the cause it is testing.
 *
 *   premium      — active subscription, this device holds a seat
 *   trialing     — in trial, premium granted
 *   past_due     — payment failed, server still grants access
 *   canceled     — subscription ended
 *   seat_denied  — subscription is live but this device gets no seat
 *   incomplete   — checkout was never finished
 *   lapsed       — a known customer with nothing active
 *   unknown      — an email the billing server has never seen (no customerId)
 */
export const BILLING_MODES = [
  'premium', 'trialing', 'past_due', 'canceled', 'seat_denied', 'incomplete', 'lapsed', 'unknown',
];

/** Modes in which the app should end up with premium access. */
export const GRANTING_MODES = ['premium', 'trialing', 'past_due'];

/**
 * Install the shim. Idempotent — a second call is a no-op, so a spec can call
 * it from `before` without caring whether another one already did.
 */
export async function installMockBilling() {
  await browser.execute(() => {
    if (window.__MV_BILLING_STUB_INSTALLED__) return;
    const realFetch = window.fetch.bind(window);
    const json = (body, init = {}) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' }, ...init,
    });

    window.__MV_BILLING_MODE__ = 'lapsed';
    window.__MV_BILLING_FAULT__ = null;
    window.__MV_BILLING_RETRY_AFTER__ = 2;
    window.__MV_BILLING_EMAIL__ = '';
    // Every subscription-status request the app made, so a spec can assert on
    // what was ASKED as well as what came back.
    window.__MV_BILLING_CALLS__ = [];

    const buildStatus = (q) => {
      const mode = window.__MV_BILLING_MODE__;
      const customerId = q.get('customerId') || (mode === 'unknown' ? null : 'cus_stub');
      const base = {
        customerId,
        customerEmail: q.get('email') || window.__MV_BILLING_EMAIL__ || 'billing@mock.test',
        currentClientId: q.get('clientId') || null,
        cancelAtPeriodEnd: false,
        clientLimit: 5,
        activeClients: [],
        priceId: null, interval: null, currentPeriodEnd: null,
      };
      switch (mode) {
        case 'premium':
          return { ...base, hasSubscription: true, status: 'active', priceId: 'price_stub_yearly',
            interval: 'year', currentPeriodEnd: '2027-01-01T00:00:00.000Z',
            premiumAccess: true, clientAccessGranted: true, activeClientCount: 1 };
        case 'trialing':
          return { ...base, hasSubscription: true, status: 'trialing', interval: 'month',
            currentPeriodEnd: '2027-01-01T00:00:00.000Z',
            premiumAccess: true, clientAccessGranted: true, activeClientCount: 1 };
        case 'past_due':
          return { ...base, hasSubscription: true, status: 'past_due', interval: 'month',
            premiumAccess: true, clientAccessGranted: true, activeClientCount: 1 };
        case 'canceled':
          return { ...base, hasSubscription: true, status: 'canceled',
            currentPeriodEnd: '2020-01-01T00:00:00.000Z',
            premiumAccess: false, clientAccessGranted: false, activeClientCount: 0 };
        case 'seat_denied':
          // The subscription is fine. This machine is the sixth device.
          return { ...base, hasSubscription: true, status: 'active', interval: 'year',
            currentPeriodEnd: '2027-01-01T00:00:00.000Z',
            premiumAccess: true, clientAccessGranted: false, activeClientCount: 5 };
        case 'incomplete':
          return { ...base, hasSubscription: true, status: 'incomplete',
            premiumAccess: false, clientAccessGranted: false, activeClientCount: 0 };
        case 'unknown':
          // The server answers 200 for an email it has never seen — that is why
          // signInFailureNotice exists at all.
          return { ...base, customerId: null, hasSubscription: false, status: null,
            premiumAccess: false, activeClientCount: 0 };
        case 'lapsed':
        default:
          return { ...base, hasSubscription: false, status: null,
            premiumAccess: false, clientAccessGranted: false, activeClientCount: 0 };
      }
    };

    window.fetch = (input, init) => {
      const url = String((input && input.url) || input || '');
      if (!url.includes('/api/billing/')) return realFetch(input, init);

      const fault = window.__MV_BILLING_FAULT__;
      if (fault === 'offline') return Promise.reject(new TypeError('Load failed'));
      if (fault === 'rate_limited') {
        // Two seconds, not two minutes: the client blocks EVERY billing
        // endpoint for the whole window, in module state a spec cannot reach.
        // A realistic Retry-After would silently neuter every later case in the
        // file. The minute/second wording is unit-tested instead.
        return Promise.resolve(new Response('{}', {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(window.__MV_BILLING_RETRY_AFTER__ || 2) },
        }));
      }
      if (fault === 'server_error') {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Billing is having a bad day.' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        }));
      }

      if (url.includes('/api/billing/subscription-status')) {
        const q = new URL(url, 'https://stub.invalid').searchParams;
        window.__MV_BILLING_CALLS__.push({
          customerId: q.get('customerId'), email: q.get('email'),
          clientId: q.get('clientId'), register: q.get('register') === '1',
        });
        return Promise.resolve(json(buildStatus(q)));
      }
      if (url.includes('/api/billing/pricing')) {
        return Promise.resolve(json({ currency: 'eur', currencySource: 'stub', plans: [] }));
      }
      if (url.includes('/api/billing/unregister-client')) {
        return Promise.resolve(json({ ok: true }));
      }
      return Promise.resolve(json({}));
    };
    window.__MV_BILLING_STUB_INSTALLED__ = true;
  });
}

export const setBillingMode = (mode) =>
  browser.execute((m) => { window.__MV_BILLING_MODE__ = m; }, mode);

export const setBillingFault = (fault) =>
  browser.execute((f) => { window.__MV_BILLING_FAULT__ = f; }, fault ?? null);

/** The canonical email the mock echoes back when the request carries none. */
export const setBillingEmail = (email) =>
  browser.execute((m) => { window.__MV_BILLING_EMAIL__ = m; }, email);

export const billingCalls = () => browser.execute(() => window.__MV_BILLING_CALLS__ || []);

export const clearBillingCalls = () =>
  browser.execute(() => { window.__MV_BILLING_CALLS__ = []; });

/** What the app believes about billing right now. */
export const billingState = () => browser.execute(() => {
  const s = window.__SETTINGS_STORE__.getState();
  return {
    billingEmail: s.billingEmail,
    hasSubscription: !!s.billingProfile?.hasSubscription,
    status: s.billingProfile?.status || null,
    customerId: s.billingProfile?.customerId || null,
    lastChecked: s.billingLastChecked || 0,
  };
});

export const settingsText = () => browser.execute(() =>
  document.querySelector('[data-testid="settings-page"]')?.innerText || '');

/**
 * Put the app in a signed-in state on `customerId`, last checked long enough
 * ago that the Billing tab refreshes on mount.
 */
export const seedSignedIn = (customerId, email) => browser.execute((cid, mail) => {
  window.__SETTINGS_STORE__.setState({
    billingEmail: mail,
    billingProfile: {
      customerId: cid, customerEmail: mail, hasSubscription: true, status: 'active',
      interval: 'year', premiumAccess: true, clientAccessGranted: true,
    },
    billingLastChecked: 1,
    shareGrant: null,
  });
}, customerId, email);

/** Signed out, no grant, no cached profile. */
export const seedSignedOut = () => browser.execute(() => {
  window.__SETTINGS_STORE__.setState({
    billingEmail: '', billingProfile: null, billingLastChecked: 0, shareGrant: null,
  });
});

/**
 * Set premium directly in the store, bypassing the server entirely.
 * For specs about what premium UNLOCKS rather than about how it is obtained —
 * they should not pay for a round trip through the Billing tab.
 */
export const setPremium = (on) => browser.execute((granted) => {
  window.__SETTINGS_STORE__.setState({
    billingEmail: granted ? 'premium@mock.test' : '',
    billingProfile: granted
      ? { customerId: 'cus_direct_mock', customerEmail: 'premium@mock.test', hasSubscription: true,
          status: 'active', interval: 'year', premiumAccess: true, clientAccessGranted: true }
      : { hasSubscription: false },
    shareGrant: null,
  });
}, on);

/** Grant (or expire) a share-to-unlock reward — premium with no subscription. */
export const setShareGrant = (msFromNow) => browser.execute((ms) => {
  window.__SETTINGS_STORE__.setState({
    shareGrant: ms === null ? null : { expiresAt: Date.now() + ms, github: true },
  });
}, msFromNow);

/**
 * Reopen Settings on the Billing tab. Reopening matters: the manual-refresh
 * cooldown lives in a ref on the component, so a fresh mount is what lets a
 * spec make two sign-in attempts in a row.
 */
export async function openBillingAs(customerId, email) {
  await closeSettings().catch(() => {});
  if (customerId) await seedSignedIn(customerId, email);
  await openSettings();
  const ok = await clickSettingsNav('Billing');
  if (!ok) throw new Error('Billing tab not found in Settings nav');
}

/**
 * Open a Settings tab, optionally its sub-tab.
 *
 * The sub-tab is not a nicety: Backup & Restore opens on "Backup Settings"
 * (export/import), and the premium-gated schedule lives one click further in.
 * A spec that stops at the tab asserts against a screen that has no gate on it
 * — which passes the "no lock is showing" half for free.
 */
export async function openTab(label, subTab) {
  await closeSettings().catch(() => {});
  await openSettings();
  const ok = await clickSettingsNav(label);
  if (!ok) throw new Error(`Settings tab "${label}" not found`);
  if (subTab) {
    const sub = await clickSettingsNav(subTab);
    if (!sub) throw new Error(`Sub-tab "${subTab}" not found under "${label}"`);
  }
}
