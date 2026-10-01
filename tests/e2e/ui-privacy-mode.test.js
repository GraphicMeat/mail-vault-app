/**
 * E2E Test: Privacy mode masks people in the list and inside the message frame
 *
 * DOM only, like every ui-* spec: CI builds this suite without VITE_E2E, so the
 * window store seams do not exist there. Premium comes from a real sign-in on
 * the Billing tab against the window.fetch billing shim (mockBilling.js), not
 * from writing the settings store. That is also why switchToFolder is not
 * used: it waits on the mail store's active pair.
 *
 * The frame needle is an address, not the sender name: no mock body carries
 * its sender's name, so "the name is gone from the frame" holds trivially. The
 * HTML message's flat quote does carry ben@fea.st, which the detector catches
 * with any dictionary, so present → masked → present is a real round trip.
 */

import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav, clickSidebarItem } from './helpers.js';
import { installMockBilling, setBillingMode, setBillingEmail, settingsText } from './mockBilling.js';
import { HTML_QUOTED_SUBJECT } from './mockImap.js';

const LUKE = 'luke@mock.test';
const FRAME_NEEDLE = 'ben@fea.st';
// Plain body text with no person in it: proves the frame holds the message,
// so an empty frame mid-reload never reads as "masked".
const FRAME_ANCHOR = 'Short answer above the quote';
const MASKED = /^[x .@-]+$/;

/** The sender text of the HTML message's row, or null when it is not rendered. */
const rowSender = () => browser.execute((subject) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(subject));
  return row ? (row.querySelector('[data-testid="row-sender"]')?.textContent || '').trim() : null;
}, HTML_QUOTED_SUBJECT);

/** The reader frame's body text, or null before it has one. */
const frameText = () => browser.execute(() => {
  const iframe = document.querySelector('iframe[sandbox]');
  let doc = null;
  try { doc = iframe?.contentDocument || null; } catch { doc = null; }
  return doc?.body ? (doc.body.textContent || '') : null;
});

/** The visible privacy toggle (the sidebar renders a collapsed and an expanded copy). */
const privacyPressed = () => browser.execute(() => {
  const btn = [...document.querySelectorAll('[data-testid="privacy-button"]')].find((b) => b.offsetHeight > 0);
  return btn ? btn.getAttribute('aria-pressed') : null;
});
const clickPrivacy = () => browser.execute(() => {
  const btn = [...document.querySelectorAll('[data-testid="privacy-button"]')].find((b) => b.offsetHeight > 0);
  if (!btn) return false;
  btn.click();
  return true;
});

describe('Privacy mode', function () {
  this.timeout(180_000);
  let appState;
  let senderName;

  before(async function () {
    appState = await waitForApp();
    if (appState !== 'ready') this.skip();
    // A build with no seeded mock accounts has nothing to mask: that is a
    // missing fixture, not a pass. Anything after this point fails loudly.
    const hasLuke = await browser.execute((email) =>
      (document.querySelector('[data-testid="sidebar"]')?.innerText || '').includes(email), LUKE);
    if (!hasLuke) {
      await browser.pause(5000);
      const late = await browser.execute((email) =>
        (document.querySelector('[data-testid="sidebar"]')?.innerText || '').includes(email), LUKE);
      if (!late) this.skip();
    }

    // Premium through the shipped sign-in path; the fetch shim is the server.
    await installMockBilling();
    await setBillingMode('premium');
    await setBillingEmail(LUKE);
    await openSettings();
    if (!(await clickSettingsNav('Billing'))) throw new Error('Billing tab not found in Settings nav');
    await browser.waitUntil(() => browser.execute(() => {
      for (const b of document.querySelectorAll('button')) {
        if (b.offsetHeight > 0 && !b.disabled && b.textContent.includes('Sign In to Premium')) { b.click(); return true; }
      }
      return false;
    }), { timeout: 15_000, interval: 400, timeoutMsg: 'no enabled "Sign In to Premium" button on the Billing tab' });
    await browser.waitUntil(async () => /Premium Yearly/.test(await settingsText()), {
      timeout: 30_000, interval: 400,
      timeoutMsg: `sign-in never granted Premium; panel reads:\n${await settingsText()}`,
    });
    await closeSettings();

    // Luke's INBOX holds the one HTML message: its body renders in the frame.
    await waitForEmails();
    await clickSidebarItem(LUKE);
    await browser.waitUntil(() => browser.execute(() =>
      (document.querySelector('[data-testid="sidebar"]')?.innerText || '').includes('INBOX')), {
      timeout: 15_000, interval: 300, timeoutMsg: `${LUKE} never listed an INBOX`,
    });
    await clickSidebarItem('INBOX');
    await browser.waitUntil(async () => !!(await rowSender()), {
      timeout: 60_000, interval: 500, timeoutMsg: `no "${HTML_QUOTED_SUBJECT}" row in ${LUKE}'s INBOX`,
    });

    await browser.execute((subject) => {
      [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(subject))?.click();
    }, HTML_QUOTED_SUBJECT);
    await browser.waitUntil(async () => (await frameText() || '').includes(FRAME_NEEDLE), {
      timeout: 30_000, interval: 300, timeoutMsg: `the reader frame never showed ${FRAME_NEEDLE}`,
    });
  });

  after(async function () {
    // Leave privacy off for whatever runs next in this app session.
    if ((await privacyPressed()) === 'true') await clickPrivacy();
  });

  it('shows the sender before privacy is on', async function () {
    senderName = await rowSender();
    expect(senderName).toBeTruthy();
    expect(senderName).not.toMatch(MASKED);
  });

  it('masks the row sender and the frame when turned on', async function () {
    expect(await clickPrivacy()).toBe(true);
    await browser.waitUntil(async () => (await privacyPressed()) === 'true', {
      timeout: 5_000, interval: 200, timeoutMsg: 'privacy button never pressed (Premium not granted?)',
    });
    expect(await browser.execute(() => !!document.querySelector('[data-testid="privacy-upsell"]'))).toBe(false);

    await browser.waitUntil(async () => MASKED.test(await rowSender() || ''), {
      timeout: 10_000, interval: 200, timeoutMsg: `row sender still reads "${await rowSender()}"`,
    });
    await browser.waitUntil(async () => {
      const text = await frameText();
      return !!text && text.includes(FRAME_ANCHOR) && !text.includes(FRAME_NEEDLE);
    }, { timeout: 15_000, interval: 300, timeoutMsg: `the frame still shows ${FRAME_NEEDLE}` });
    expect(await frameText()).not.toContain(senderName);
  });

  it('puts the names back when turned off', async function () {
    expect(await clickPrivacy()).toBe(true);
    await browser.waitUntil(async () => (await privacyPressed()) === 'false', {
      timeout: 5_000, interval: 200, timeoutMsg: 'privacy button never released',
    });
    await browser.waitUntil(async () => (await rowSender()) === senderName, {
      timeout: 10_000, interval: 200, timeoutMsg: `row sender reads "${await rowSender()}", expected "${senderName}"`,
    });
    await browser.waitUntil(async () => (await frameText() || '').includes(FRAME_NEEDLE), {
      timeout: 15_000, interval: 300, timeoutMsg: `the frame never showed ${FRAME_NEEDLE} again`,
    });
  });
});
