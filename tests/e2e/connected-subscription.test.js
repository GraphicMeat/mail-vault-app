/**
 * E2E: signing in to a subscription, and every way that can fail.
 *
 * Billing is the one thing MailVault asks a hosted server about. The server is
 * mocked at `window.fetch` — see `mockBilling.js` for why it cannot be a real
 * process — so everything above the network seam here is the shipped path:
 * BillingSettings → billingRequest → billingApi → fetch.
 *
 * The failure cases matter more than the happy one. The server answers **200**
 * for an email it has never seen, so without `signInFailureNotice` a wrong email
 * looks exactly like a bug: the button spins, nothing happens, no premium. Each
 * case below asserts the specific sentence, not just "something went wrong" —
 * the whole value is telling those causes apart.
 *
 * Three seeded accounts: the sign-in control is a dropdown built from the
 * account list, and with one account it would not be a choice.
 */

import { waitForApp, closeSettings } from './helpers.js';
import {
  CUSTOMERS, installMockBilling, setBillingMode, setBillingFault, setBillingEmail,
  billingState, billingCalls, clearBillingCalls, settingsText,
  seedSignedIn, seedSignedOut, openBillingAs,
} from './mockBilling.js';

describe('Subscription — signing in, and being told why it did not work', function () {
  this.timeout(180_000);

  let firstEmail = null;

  /** Open Billing signed out and press the sign-in button. */
  async function signIn() {
    await seedSignedOut();
    await openBillingAs(null);
    const clicked = await browser.execute(() => {
      for (const b of document.querySelectorAll('button')) {
        if (b.offsetHeight > 0 && !b.disabled && b.textContent.includes('Sign In to Premium')) {
          b.click();
          return true;
        }
      }
      return false;
    });
    expect(clicked).toBe(true);
    return clicked;
  }

  /** Wait for the panel to say something specific, and show what it said if not. */
  async function waitForText(re, what) {
    await browser.waitUntil(async () => re.test(await settingsText()), {
      timeout: 30_000, interval: 400,
      timeoutMsg: `${what}\nPanel reads:\n${await settingsText()}`,
    });
  }

  before(async function () {
    await waitForApp();
    expect(browser.mockAccounts.length).toBeGreaterThan(1);
    firstEmail = browser.mockAccounts[0].email;
    await installMockBilling();
    await setBillingEmail(firstEmail);
  });

  beforeEach(async function () {
    await setBillingFault(null);
    await clearBillingCalls();
  });

  after(async function () {
    await closeSettings().catch(() => {});
    await setBillingFault(null);
    await seedSignedOut();
  });

  describe('a sign-in that works', function () {
    it('grants premium and remembers who signed in', async function () {
      await setBillingMode('premium');
      await signIn();

      await browser.waitUntil(async () => (await billingState()).hasSubscription, {
        timeout: 30_000, interval: 400,
        timeoutMsg: `sign-in never took: ${JSON.stringify(await billingState())}`,
      });
      const state = await billingState();
      expect(state.billingEmail).toBe(firstEmail);
      expect(state.status).toBe('active');
      expect(await settingsText()).toContain('Premium Yearly');
    });

    it('registers this device in the same request', async function () {
      await setBillingMode('premium');
      await signIn();
      await browser.waitUntil(async () => (await billingCalls()).length > 0, {
        timeout: 30_000, interval: 400, timeoutMsg: 'the app never called the billing server',
      });
      const [call] = await billingCalls();
      // Status + registration are one round trip, and the seat is keyed on a
      // stable per-machine id — without it the server cannot count devices.
      expect(call.register).toBe(true);
      expect(call.clientId).toBeTruthy();
      // Sign-in looks up by email ONLY: sending a stale customerId is how a
      // previous identity gets reused for a different person.
      expect(call.email).toBe(firstEmail);
      expect(call.customerId).toBeFalsy();
    });

    it('a trial counts as premium', async function () {
      await setBillingMode('trialing');
      await signIn();
      await browser.waitUntil(async () => (await billingState()).status === 'trialing', {
        timeout: 30_000, interval: 400, timeoutMsg: 'trial never granted access',
      });
      expect(await settingsText()).toContain('Premium (Trial)');
    });
  });

  describe('a sign-in that grants nothing says why', function () {
    /** Each mode, and the sentence it must produce. */
    const CASES = [
      ['unknown', /No subscription found for this email/i, 'an email the server has never seen'],
      ['lapsed', /No active subscription on this email/i, 'a known customer with nothing active'],
      ['canceled', /This subscription has ended/i, 'a subscription that ended'],
      ['incomplete', /Checkout was never completed/i, 'a checkout that was abandoned'],
      ['seat_denied', /this device could not be activated/i, 'a live subscription with no free seat'],
    ];

    for (const [mode, sentence, label] of CASES) {
      it(`names ${label}`, async function () {
        await setBillingMode(mode);
        await signIn();
        await waitForText(sentence, `never explained ${label}`);

        // And it stays signed OUT: a stored identity with no access is the
        // half-signed-in state that started all of this.
        const state = await billingState();
        expect(state.billingEmail).toBe('');
      });
    }

    it('past_due still grants access rather than locking the user out', async function () {
      // Payment failed, but Stripe keeps the subscription usable during the
      // retry window — the app must not treat that as an expiry.
      await setBillingMode('past_due');
      await signIn();
      await browser.waitUntil(async () => (await billingState()).status === 'past_due', {
        timeout: 30_000, interval: 400, timeoutMsg: 'past_due never resolved',
      });
      expect((await billingState()).billingEmail).toBe(firstEmail);
    });
  });

  describe('when the billing server itself is the problem', function () {
    it('shows the wait instead of a failure when rate limited', async function () {
      await setBillingFault('rate_limited');
      await setBillingMode('premium');
      await signIn();

      await waitForText(/Billing checked too often|Try again in/i, 'a 429 was not explained');
      expect((await billingState()).hasSubscription).toBe(false);

      // The client now refuses every billing endpoint until the window passes,
      // and that state lives inside billingApi where no spec can clear it.
      // Wait it out rather than leaving the rest of the file talking to a
      // client that answers nothing.
      await setBillingFault(null);
      await browser.pause(2600);
    });

    it('keeps a subscription that is already known when the server errors', async function () {
      // The cached profile is what stands between a bad deploy on the billing
      // box and every paying customer losing premium at once.
      await setBillingMode('premium');
      await seedSignedIn(CUSTOMERS.premium, firstEmail);
      await setBillingFault('server_error');
      await openBillingAs(CUSTOMERS.premium, firstEmail);

      await waitForText(/bad day|Billing service error|Could not reach/i, 'a 500 was not surfaced');
      // Access survives the outage.
      expect((await billingState()).hasSubscription).toBe(true);
    });

    it('survives an outright network failure the same way', async function () {
      await setBillingMode('premium');
      await seedSignedIn(CUSTOMERS.premium, firstEmail);
      await setBillingFault('offline');
      await openBillingAs(CUSTOMERS.premium, firstEmail);

      await waitForText(/Could not reach billing service|internet connection/i, 'an offline failure was not surfaced');
      expect((await billingState()).hasSubscription).toBe(true);
    });
  });
});
