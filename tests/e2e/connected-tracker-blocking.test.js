/**
 * E2E: tracking pixels — seen by everyone, removed for subscribers.
 *
 * The feature makes two claims and only the real app can settle either one,
 * because both are about the document that actually reaches the renderer:
 *
 *   free    — the beacon is still in the frame, and the glyph says so.
 *   premium — the beacon is GONE from the frame, the real image is not, and
 *             the glyph changes to the blocked symbol.
 *
 * Asserting the store's `_trackerInfo` would pass in both directions: the
 * summary is written by detection, which runs for everyone. What separates the
 * two states is the srcDoc handed to the iframe, so that is what is read here.
 *
 * Fixture: `trackerMessage` in mockImap.js — a newsletter carrying one real
 * image (480×120) and one Mailchimp open beacon (1×1, display:none).
 */

import { waitForApp, waitForEmails, closeSettings } from './helpers.js';
import { setPremium, openTab, settingsText } from './mockBilling.js';
import {
  TRACKER_SUBJECT,
  TRACKER_BODY_MARKER,
  TRACKER_PIXEL_URL,
  TRACKER_VENDOR,
  TRACKER_REAL_IMAGE,
} from './mockImap.js';

/** The document the viewer hands its iframe, read off the srcdoc attribute. */
const frameSource = () => browser.execute(() => {
  const frame = document.querySelector('iframe[sandbox]');
  return frame ? (frame.getAttribute('srcdoc') || '') : '';
});

/** The tracker glyph as the row/viewer renders it, or null. */
const glyph = () => browser.execute(() => {
  const el = document.querySelector('[data-testid="tracker-alert-icon"]');
  if (!el) return null;
  return { blocked: el.getAttribute('data-blocked'), title: el.getAttribute('title') };
});

const clickRow = (subject) => browser.execute((needle) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
  if (!row) return false;
  row.click();
  return true;
}, subject);

/** Open the message and wait until its body is the one on screen. */
async function openTrackerMessage() {
  await browser.waitUntil(async () => clickRow(TRACKER_SUBJECT), {
    timeout: 60_000,
    interval: 1000,
    timeoutMsg: `row "${TRACKER_SUBJECT}" never appeared in the list`,
  });
  await browser.waitUntil(async () => (await frameSource()).includes(TRACKER_BODY_MARKER), {
    timeout: 30_000,
    interval: 400,
    timeoutMsg: 'the newsletter body never reached the iframe',
  });
}

/** Deselect, so the next open rebuilds the frame from scratch. */
const clearSelection = () => browser.execute(() => {
  window.__MAIL_STORE__?.setState?.({ selectedEmail: null, selectedEmailId: null });
});

describe('Tracker blocking', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await setPremium(false);
  });

  after(async function () {
    await closeSettings().catch(() => {});
    await setPremium(false);
  });

  it('leaves the beacon in the document for a free profile, and says so', async function () {
    await openTrackerMessage();

    const html = await frameSource();
    // Positive control first: the body really is the newsletter, so an
    // absent beacon below would mean removal, not an empty frame.
    expect(html).toContain(TRACKER_BODY_MARKER);
    expect(html).toContain(TRACKER_REAL_IMAGE);
    // Free: nothing was stripped. The pixel is still there to fire.
    expect(html).toContain('list-manage.com/track/open.php');
    expect(html).not.toContain('data-mv-tracker-blocked');

    await browser.waitUntil(async () => !!(await glyph()), {
      timeout: 20_000,
      interval: 400,
      timeoutMsg: 'no tracker glyph rendered for a message carrying a beacon',
    });
    const icon = await glyph();
    expect(icon.blocked).toBe('false');
    expect(icon.title).toContain('This email tracks you');
  });

  it('names the tracking vendor when the glyph is clicked', async function () {
    await browser.execute(() => document.querySelector('[data-testid="tracker-alert-icon"]').click());
    await browser.waitUntil(
      async () => browser.execute((v) => (document.body.innerText || '').includes(v), TRACKER_VENDOR),
      { timeout: 15_000, interval: 300, timeoutMsg: `dialog never named ${TRACKER_VENDOR}` },
    );

    const dialog = await browser.execute(() => document.body.innerText || '');
    // A free user is told what it is, what it costs them, and where to go.
    expect(dialog).toContain(TRACKER_VENDOR);
    expect(dialog).toContain('Tracker Blocking is a Premium feature');

    await browser.keys(['Escape']);
  });

  it('sells the feature on its own page, with the before/after and the code', async function () {
    await openTab('Tracker Blocking');
    const text = await settingsText();
    expect(text).toContain('Tracker Blocking is a Premium Feature');
    expect(text).toContain('Before — beacon fires on open');
    expect(text).toContain('After — beacon removed');
    // The upsell has to show the tracking code itself, not just describe it.
    expect(text).toContain('open.php');
    expect(text).toContain('data-mv-tracker-blocked');
    await closeSettings();
  });

  it('strips the beacon out of the rendered document once premium is on', async function () {
    await setPremium(true);
    await clearSelection();
    await openTrackerMessage();

    await browser.waitUntil(async () => (await frameSource()).includes('data-mv-tracker-blocked'), {
      timeout: 30_000,
      interval: 400,
      timeoutMsg: 'the beacon was never replaced by the blocked marker',
    });

    const html = await frameSource();
    expect(html).not.toContain('list-manage.com/track/open.php');
    expect(html).toContain(`data-mv-tracker-blocked="${TRACKER_VENDOR}"`);
    // Only the beacon goes: the message and its real image survive intact.
    expect(html).toContain(TRACKER_BODY_MARKER);
    expect(html).toContain(TRACKER_REAL_IMAGE);
  });

  it('switches the glyph to the blocked symbol', async function () {
    await browser.waitUntil(async () => (await glyph())?.blocked === 'true', {
      timeout: 20_000,
      interval: 400,
      timeoutMsg: `glyph never flipped to blocked: ${JSON.stringify(await glyph())}`,
    });
    expect((await glyph()).title).toContain('Tracking blocked');
  });

  it('gives a subscriber the switch instead of the upsell', async function () {
    await openTab('Tracker Blocking');
    const text = await settingsText();
    expect(text).not.toContain('Tracker Blocking is a Premium Feature');
    expect(text).toContain('Blocking is on');
    await closeSettings();
  });

  it('puts the beacon back when the subscriber turns blocking off', async function () {
    // The switch has to be a real switch — a feature that cannot be turned off
    // is not a setting, and the glyph must stop claiming protection.
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setTrackerBlockingEnabled(false));
    await clearSelection();
    await openTrackerMessage();

    await browser.waitUntil(async () => (await frameSource()).includes('list-manage.com/track/open.php'), {
      timeout: 30_000,
      interval: 400,
      timeoutMsg: 'turning blocking off did not restore the original body',
    });
    expect(await frameSource()).not.toContain('data-mv-tracker-blocked');
    expect((await glyph()).blocked).toBe('false');

    await browser.execute(() => window.__SETTINGS_STORE__.getState().setTrackerBlockingEnabled(true));
  });

  it('refuses to arm the switch for a free profile', async function () {
    await setPremium(false);
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setTrackerBlockingEnabled(true));
    await clearSelection();
    await openTrackerMessage();

    const html = await frameSource();
    expect(html).toContain('list-manage.com/track/open.php');
    expect(html).not.toContain('data-mv-tracker-blocked');
  });
});
