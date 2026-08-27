/**
 * E2E: premium that stops applying to this device has to SAY so.
 *
 * Reported 2026-08-27, alongside the backup alarm: "my app is logout from
 * premium". The subscription really had ended server-side — but the app never
 * said a word. `refreshSignedIn` wrote the new profile and returned, so the
 * Billing tab re-rendered as "Free" with the signed-in email still stored, the
 * premium features simply stopped, and the only way to learn any of it was to
 * notice something missing.
 *
 * Billing is the one thing MailVault asks a hosted server about, and the answer
 * this spec needs — "that subscription is gone" — cannot be had from the real
 * server without cancelling a real subscription, nor should a test run reach
 * the network at all. So the seam is stubbed at `window.fetch`, the exact place
 * the app leaves the machine: everything above it is the shipped code path
 * (BillingSettings → refreshSignedIn → billingApi → fetch), and no product code
 * carries a test hook.
 *
 * Three accounts are seeded and the drop is asserted with all of them present:
 * the Billing tab picks its email out of the account list, and a single-account
 * run would not exercise that choice.
 */

import { waitForApp, closeSettings } from './helpers.js';
import {
  CUSTOMERS, installMockBilling, setBillingMode, setBillingEmail,
  billingState, settingsText, seedSignedIn, openBillingAs,
} from './mockBilling.js';

const PREMIUM_CUSTOMER = CUSTOMERS.premium;
const LAPSED_CUSTOMER = CUSTOMERS.lapsed;

describe('Billing — premium that stops applying to this device', function () {
  this.timeout(180_000);

  let signedInEmail = null;

  /** Seed, open Settings → Billing, and let the mount refresh run. */
  const openBillingSignedInOn = (customerId) => openBillingAs(customerId, signedInEmail);

  before(async function () {
    await waitForApp();
    // The account list the Billing tab reads from — three seeded accounts, not one.
    expect(browser.mockAccounts.length).toBeGreaterThan(1);
    signedInEmail = browser.mockAccounts[0].email;
    await installMockBilling();
    await setBillingEmail(signedInEmail);
  });

  after(async function () {
    await closeSettings().catch(() => {});
    await browser.execute(() => window.__SETTINGS_STORE__.getState().clearBillingProfile());
  });

  it('says premium ended, instead of quietly rendering "Free"', async function () {
    await setBillingMode('lapsed');
    await openBillingSignedInOn(LAPSED_CUSTOMER);

    await browser.waitUntil(async () => /Premium access ended on this device/i.test(await settingsText()), {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `Billing never explained the drop. Panel reads:\n${await settingsText()}`,
    });

    // And the specific reason, not just the headline.
    expect(await settingsText()).toMatch(/No active subscription|No subscription found|ended|payment|could not be activated/i);
  });

  it('drops the stored identity so the tab is signed out, not half signed in', async function () {
    await setBillingMode('lapsed');
    await openBillingSignedInOn(LAPSED_CUSTOMER);

    await browser.waitUntil(async () => (await billingState()).billingEmail === '', {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `billingEmail survived a subscription that is gone: ${JSON.stringify(await billingState())}`,
    });
    expect((await billingState()).hasSubscription).toBe(false);
  });

  it('says nothing when the refresh confirms the subscription is alive', async function () {
    await setBillingMode('premium');
    await openBillingSignedInOn(PREMIUM_CUSTOMER);

    // The refresh has to actually RUN for this control to mean anything — the
    // seeded state alone would satisfy every assertion below.
    await browser.waitUntil(async () => (await billingState()).lastChecked > 1, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `billing never refreshed, so this control proves nothing: ${JSON.stringify(await billingState())}`,
    });

    expect(await settingsText()).not.toMatch(/Premium access ended/i);
    const state = await billingState();
    expect(state.billingEmail).toBe(signedInEmail);
    expect(state.hasSubscription).toBe(true);
    expect(state.customerId).toBe(PREMIUM_CUSTOMER);
  });

  it('stops automatic backups when premium lapses, and keeps the schedule for the day it comes back', async function () {
    const accountId = browser.mockAccounts[0].id;
    // `_queueRunning` parks the queue so a due check cannot start a real backup
    // against the mock server — the queue contents are what is being asserted.
    const dueCheck = (id) => {
      const s = window.__BACKUP_SCHEDULER__;
      s._queue = [];
      s._queueRunning = true;
      s.checkAndQueueDue();
      const queued = [...s._queue];
      s._queue = [];
      s._queueRunning = false;
      return {
        queued,
        paused: s._isPaused(),
        scheduleEnabled: !!window.__SETTINGS_STORE__.getState().backupSchedules?.[id]?.enabled,
      };
    };

    await browser.execute((id) => {
      window.__SETTINGS_STORE__.getState().setBackupSchedule(id, { enabled: true, interval: 'hourly', hourlyInterval: 1 });
    }, accountId);

    // Control: with the live subscription still signed in, this account is due
    // and does get queued. Without this the assertion below passes vacuously.
    await setBillingMode('premium');
    await openBillingSignedInOn(PREMIUM_CUSTOMER);
    const live = await browser.execute(dueCheck, accountId);
    expect(live.paused).toBe(false);   // a paused scheduler queues nothing either
    expect(live.queued).toContain(accountId);

    await setBillingMode('lapsed');
    await openBillingSignedInOn(LAPSED_CUSTOMER);
    await browser.waitUntil(async () => (await billingState()).billingEmail === '', {
      timeout: 30_000, interval: 500, timeoutMsg: 'the drop never landed, so this asserts nothing',
    });

    const lapsed = await browser.execute(dueCheck, accountId);
    expect(lapsed.queued).toEqual([]);
    // The schedule is kept, not deleted: resubscribing restores it untouched.
    expect(lapsed.scheduleEnabled).toBe(true);
  });
});
