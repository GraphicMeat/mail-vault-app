/**
 * E2E: the in-app lifecycle messages.
 *
 * MailVault writes short notes about Premium into the inbox view on this
 * computer (trial ending, a checkout left, a plan ended). The daemon decides
 * what is due (`lifecycle.sync`, src-core/src/lifecycle_mail.rs) from the
 * billing facts the app hands it; the app pins the note above the inbox, opens
 * it in the reader and records what was read or dismissed. Nothing is sent.
 *
 * The trial-ending note is the one a spec can bring on at once: a trial that
 * ends in 30 hours is due the moment billing says so, with no clock to move.
 */

import { waitForApp, waitForEmails, closeSettings } from './helpers.js';

const TRIAL_ENDING_SUBJECT = /free trial ends soon/i;

// One trial end for the whole file: the note is delivered once per trial end,
// so a later seed with the same end must not bring it back.
const TRIAL_ENDS_AT = new Date(Date.now() + 30 * 3600e3).toISOString();

const seedTrial = () => browser.execute((endsAt) => {
  window.__SETTINGS_STORE__.setState({
    onboardingComplete: true,
    lifecycleMessages: true,
    billingProfile: { premiumAccess: true, hasSubscription: true, status: 'trialing', currentPeriodEnd: endsAt },
  });
}, TRIAL_ENDS_AT);

const pinnedRows = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="lifecycle-pinned-row"]')]
    .map((r) => ({ text: r.innerText, unread: r.dataset.unread })));

describe('Lifecycle messages', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await seedTrial();
  });

  it('pins the note above the inbox once billing says the trial is ending', async function () {
    await browser.waitUntil(async () => (await pinnedRows()).length === 1, {
      timeout: 30_000, timeoutMsg: 'the trial-ending note never appeared above the inbox',
    });
    const [row] = await pinnedRows();
    expect(row.text).toMatch(TRIAL_ENDING_SUBJECT);
    expect(row.text).toContain('MailVault');
    expect(row.unread).toBe('true');
  });

  it('opens in the reader as a note from MailVault, and Open Billing goes to Billing', async function () {
    await $('[data-testid="lifecycle-pinned-row"]').click();
    await $('[data-testid="lifecycle-message"]').waitForExist({ timeout: 10_000 });
    expect(await $('[data-testid="lifecycle-message-from"]').getText()).toBe('MailVault');
    expect(await $('[data-testid="lifecycle-message-footer"]').getText()).toMatch(/not sent to you by email/i);
    expect((await pinnedRows())[0].unread).toBe('false');

    await $('[data-testid="lifecycle-open-billing"]').click();
    await $('[data-testid="settings-page"]').waitForExist({ timeout: 10_000 });
    await closeSettings();
  });

  it('opening a real email replaces the note in the reader', async function () {
    await browser.execute(() => document.querySelector('[data-testid="email-row"]')?.click());
    await browser.waitUntil(async () => !(await $('[data-testid="lifecycle-message"]').isExisting()), {
      timeout: 10_000, timeoutMsg: 'the note stayed in the reader after an email was opened',
    });
    // The row is still pinned: closing the reader is not dismissing.
    expect((await pinnedRows()).length).toBe(1);
  });

  it('can be switched off in Billing, and switched back on', async function () {
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setLifecycleMessages(false));
    await browser.waitUntil(async () => (await pinnedRows()).length === 0, {
      timeout: 15_000, timeoutMsg: 'the note stayed after the messages were switched off',
    });
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setLifecycleMessages(true));
    await browser.waitUntil(async () => (await pinnedRows()).length === 1, {
      timeout: 30_000, timeoutMsg: 'the note did not come back when the messages were switched on',
    });
  });

  it('a dismissed note is gone and never delivered again for the same trial', async function () {
    await $('[data-testid="lifecycle-dismiss"]').click();
    await browser.waitUntil(async () => (await pinnedRows()).length === 0, { timeout: 10_000 });

    // Ask again, the way a billing refresh does: the same trial end, so the same occasion.
    await seedTrial();
    await browser.pause(3000);
    expect((await pinnedRows()).length).toBe(0);
  });
});
