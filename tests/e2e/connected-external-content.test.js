/**
 * E2E: "Ask before loading external content".
 *
 * Only the real engine can settle this: the claim is that a frame refuses what
 * its mail would fetch, and that Dark Reader still works under the same policy.
 * The srcdoc says what was asked for; a probe image dropped into the live frame
 * says what the webview actually does with it.
 *
 * Fixture: `trackerMessage` in mockImap.js, a newsletter carrying one real
 * remote image and one beacon.
 */

import { waitForApp, waitForEmails, closeSettings, reloadApp } from './helpers.js';
import { openTab } from './mockBilling.js';
import { TRACKER_SUBJECT, TRACKER_BODY_MARKER, TRACKER_REAL_IMAGE } from './mockImap.js';

const HELD_CSP = 'img-src data: blob: cid:';

const frameSource = () => browser.execute(() => document.querySelector('iframe[sandbox]')?.getAttribute('srcdoc') || '');
const barShown = () => browser.execute(() => !!document.querySelector('[data-testid="external-content-bar"]'));
const clearSelection = () => browser.execute(() => {
  window.__MAIL_STORE__?.setState?.({ selectedEmail: null, selectedEmailId: null });
});
const setHold = (on) => browser.execute((v) => window.__SETTINGS_STORE__.setState({ holdExternalContent: v }), on);

async function openMessage() {
  await browser.waitUntil(() => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
    if (!row) return false;
    row.click();
    return true;
  }, TRACKER_SUBJECT), { timeout: 60_000, interval: 1000, timeoutMsg: `row "${TRACKER_SUBJECT}" never appeared in the list` });
  await browser.waitUntil(async () => (await frameSource()).includes(TRACKER_BODY_MARKER), {
    timeout: 30_000, interval: 400, timeoutMsg: 'the newsletter body never reached the iframe',
  });
}

/** Drop an image into the live frame: the directive the webview refused it under, or null. */
async function probeFrame() {
  await browser.execute(() => {
    const frame = document.querySelector('iframe[sandbox]');
    const doc = frame.contentDocument;
    window.__mvProbe = { refused: null };
    doc.addEventListener('securitypolicyviolation', (e) => { window.__mvProbe.refused = e.violatedDirective; }, { once: true });
    const img = doc.createElement('img');
    img.src = `https://cdn.mock.test/probe-${Date.now()}.png`;
    doc.body.appendChild(img);
  });
  await browser.pause(1500);
  return browser.execute(() => window.__mvProbe.refused);
}

describe('Ask before loading external content', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  after(async function () {
    await closeSettings().catch(() => {});
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ holdExternalContent: false, emailViewerTheme: 'system' }));
  });

  it('is off by default: the message opens as it always did', async function () {
    await setHold(false);
    await openMessage();
    expect(await frameSource()).not.toContain(HELD_CSP);
    expect(await barShown()).toBe(false);
    expect(await probeFrame()).toBe(null);
  });

  it('turned on in Settings, an opened message holds back and offers the load', async function () {
    await openTab('Privacy & security', 'Security');
    await browser.execute(() => document.querySelector('[data-testid="ask-before-external-content"]').click());
    await browser.waitUntil(() => browser.execute(() => window.__SETTINGS_STORE__.getState().holdExternalContent === true), {
      timeout: 5000, timeoutMsg: 'the switch did not reach the setting',
    });
    await closeSettings();
    await clearSelection();
    await openMessage();

    await browser.waitUntil(barShown, { timeout: 15_000, interval: 300, timeoutMsg: 'no offer on a message with a remote image' });
    const html = await frameSource();
    expect(html).toContain(HELD_CSP);
    // Not stripped: the body is the same, the frame refuses it.
    expect(html).toContain(TRACKER_REAL_IMAGE);
    expect(await probeFrame()).toBe('img-src');
  });

  it('Dark Reader still themes a message held back', async function () {
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ emailViewerTheme: 'dark' }));
    await browser.waitUntil(async () => (await frameSource()).includes('data-mv-theme="dark"'), {
      timeout: 15_000, interval: 300, timeoutMsg: 'the frame never turned dark',
    });
    await browser.waitUntil(() => browser.execute(() => {
      const doc = document.querySelector('iframe[sandbox]')?.contentDocument;
      return !!doc?.querySelector('style.darkreader');
    }), { timeout: 15_000, interval: 300, timeoutMsg: 'Dark Reader did not run under the policy' });
    expect(await frameSource()).toContain(HELD_CSP);
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ emailViewerTheme: 'light' }));
    // WKWebView drops a second srcdoc change while the first is still loading,
    // so the next step waits for this one to land, as a person's next click does.
    await browser.waitUntil(() => browser.execute(() => (
      document.querySelector('iframe[sandbox]')?.contentDocument?.documentElement?.getAttribute('data-mv-theme') === 'light'
    )), { timeout: 15_000, interval: 200, timeoutMsg: 'the frame never turned back to light' });
  });

  it('Load external content lets this message through', async function () {
    await browser.execute(() => document.querySelector('[data-testid="load-external-content"]').click());
    await browser.waitUntil(async () => !(await frameSource()).includes(HELD_CSP), {
      timeout: 15_000, interval: 300, timeoutMsg: 'the frame kept refusing after the load',
    });
    // The attribute changes first: until the new document has loaded, the frame
    // still holds the old one and the old one's policy.
    await browser.waitUntil(() => browser.execute(() => {
      const doc = document.querySelector('iframe[sandbox]')?.contentDocument;
      return !!doc?.body && !doc.querySelector('meta[content*="media-src"]');
    }), { timeout: 15_000, interval: 200, timeoutMsg: 'the new document never replaced the held one' });
    expect(await frameSource()).toContain(TRACKER_REAL_IMAGE);
    expect(await barShown()).toBe(false);
    expect(await probeFrame()).toBe(null);
  });

  it('stays loaded for this message when it is opened again this session', async function () {
    await clearSelection();
    await openMessage();
    expect(await frameSource()).not.toContain(HELD_CSP);
    expect(await barShown()).toBe(false);
  });

  it('after a relaunch the switch is still on, and the message asks again', async function () {
    await reloadApp();
    await waitForEmails();
    expect(await browser.execute(() => window.__SETTINGS_STORE__.getState().holdExternalContent)).toBe(true);
    await openMessage();
    await browser.waitUntil(barShown, { timeout: 15_000, interval: 300, timeoutMsg: 'no offer after the relaunch' });
    expect(await frameSource()).toContain(HELD_CSP);
  });
});
