/**
 * E2E: the green SPF/DKIM shield on an opened message.
 *
 * The shield reads `authenticationResults` off the message the viewer holds.
 * Only the header sync row carries that header; the body the viewer opens (a
 * light fetch, a vault read, or the in-memory cache) never did, so the shield
 * silently vanished until selectEmail carried it over from the row. Unit tests
 * mock every one of those sources, so only the real app proves the header
 * survives the trip: mock IMAP -> header sync -> row -> opened message -> badge.
 *
 * Fixtures (mockImap.js, luke's INBOX): `SENDER_AUTH_SUBJECT` carries
 * `spf=pass dkim=pass`; `BIG_BODY_SUBJECT` carries no Authentication-Results,
 * which is the control: a badge that drew for every message would pass the
 * positive case for the wrong reason.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { SENDER_AUTH_SUBJECT, BIG_BODY_SUBJECT } from './mockImap.js';

// The From display names of the two fixtures, as the header prints them.
const VERIFIED_SENDER = 'Verified Sender';
const UNVERIFIED_SENDER = 'Reports';

const clickRow = (subject) => browser.execute((needle) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
  if (!row) return false;
  row.click();
  return true;
}, subject);

/** The open message's header and its shield, once it names `sender`. */
const viewerState = (sender) => browser.execute((name) => {
  const header = document.querySelector('[data-testid="sender-header"]');
  if (!header || !(header.innerText || '').includes(name)) return null;
  const badge = header.querySelector('[data-testid="sender-verification"]');
  // What var(--mail-success) resolves to in this theme, to compare the
  // badge's painted color against.
  const probe = document.createElement('span');
  probe.style.color = 'var(--mail-success)';
  document.body.appendChild(probe);
  const success = getComputedStyle(probe).color;
  probe.remove();
  return {
    header: header.innerText || '',
    status: badge ? badge.getAttribute('data-status') : null,
    title: badge ? badge.getAttribute('title') : null,
    color: badge ? getComputedStyle(badge).color : null,
    success,
  };
}, sender);

async function open(subject, sender) {
  await browser.waitUntil(async () => clickRow(subject), {
    timeout: 60_000, interval: 1000, timeoutMsg: `row "${subject}" never appeared in the list`,
  });
  let state = null;
  await browser.waitUntil(async () => !!(state = await viewerState(sender)),
    { timeout: 30_000, interval: 400, timeoutMsg: `"${subject}" never opened in the viewer` });
  return state;
}

/** The badge settles after the body publishes; give it a moment to draw. */
async function openVerified() {
  await open(SENDER_AUTH_SUBJECT, VERIFIED_SENDER);
  let state = null;
  await browser.waitUntil(async () => {
    state = await viewerState(VERIFIED_SENDER);
    return state?.status === 'verified';
  }, {
    timeout: 15_000, interval: 400,
    timeoutMsg: 'no verified shield on a message that passed SPF and DKIM',
  }).catch(() => {});
  return state;
}

describe('Sender verification shield', function () {
  this.timeout(180_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('shows the green shield on a message that passed SPF and DKIM', async function () {
    const state = await openVerified();
    expect(state?.status).toBe('verified');
    expect(state.title).toContain('SPF');
    expect(state.color).toBe(state.success);
  });

  it('shows no shield on a message with no authentication results', async function () {
    const state = await open(BIG_BODY_SUBJECT, UNVERIFIED_SENDER);
    expect(state.status).toBe(null);
  });

  it('keeps the shield when the message reopens from the cache', async function () {
    // The previous case moved the selection away, so this open is the
    // in-memory cache hit, a different publish path from the first open.
    const state = await openVerified();
    expect(state?.status).toBe('verified');
    expect(state.color).toBe(state.success);
  });
});
