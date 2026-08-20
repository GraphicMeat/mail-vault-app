/**
 * E2E Test: link alerts stay in the mailbox that earned them
 *
 * A red link warning is per MESSAGE, and a message is identified by a UID that
 * is unique inside one mailbox only. Both halves of the warning — the level,
 * persisted in settings, and the tooltip's link list, cached in memory — were
 * filed under the bare UID, so opening the spoofed-link message in luke's Sent
 * folder lit a red "Dangerous links detected" warning on the unrelated INBOX
 * message sharing UID 41 (and on any other account's UID 41). The store-level
 * cross-account case is covered by unit tests; what needs the real app is the
 * persisted round trip: raise it in one folder, leave, come back.
 *
 * Fixture: mockImap.js gives luke's Sent UID 41 a link whose text says
 * bank.test and whose href goes to evil.test. luke's INBOX UID 41 is the HTML
 * render-check message, whose only link is honest.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import {
  HTML_COLLISION_SUBJECT,
  HTML_QUOTED_SUBJECT,
  PHISH_LINK_TEXT,
  PHISH_LINK_HREF,
} from './mockImap.js';

const LUKE = 'luke@mock.test';
const SHARED_UID = 41;
const ALERT_BUTTON = 'button[title="Dangerous links detected"]';

/** Every rendered row that carries a red link warning, by subject. */
const flaggedRowSubjects = (selector) => browser.execute((sel) => {
  return [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter((row) => row.offsetHeight > 0 && row.querySelector(sel))
    .map((row) => (row.innerText || '').trim());
}, selector);

/** The store's view of one message in the current list. */
const rowAlert = (uid) => browser.execute((wantUid) => {
  const s = window.__MAIL_STORE__?.getState?.();
  if (!s) return { missing: 'store' };
  const row = (s.sortedEmails || []).find((e) => e.uid === wantUid);
  if (!row) return { missing: 'row', uids: (s.sortedEmails || []).slice(0, 5).map((e) => e.uid) };
  return { subject: row.subject, linkAlert: row._linkAlert ?? null };
}, uid);

const clickRow = (subject) => browser.execute((needle) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find((r) => (r.innerText || '').includes(needle) && r.offsetHeight > 0);
  if (!row) return false;
  row.click();
  return true;
}, subject);

describe('Link alerts are scoped to one mailbox', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('raises a red warning on the message carrying the spoofed link', async function () {
    await switchToFolder(LUKE, 'Sent');

    expect(await clickRow(HTML_COLLISION_SUBJECT)).toBe(true);

    await browser.waitUntil(async () => (await rowAlert(SHARED_UID)).linkAlert === 'red', {
      timeout: 30_000,
      interval: 400,
      timeoutMsg: `Sent UID ${SHARED_UID} never turned red: ${JSON.stringify(await rowAlert(SHARED_UID))}`,
    });

    // The icon is the whole point — assert it reached the row, not just the store.
    const flagged = await flaggedRowSubjects(ALERT_BUTTON);
    expect(flagged.some((text) => text.includes(HTML_COLLISION_SUBJECT))).toBe(true);
  });

  it('names the message the warning belongs to, and only that one', async function () {
    const lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    expect(lukeId).toBeTruthy();

    const alerts = await browser.execute(() => {
      const s = window.__SETTINGS_STORE__?.getState?.();
      return s ? s.linkAlerts : null;
    });

    expect(alerts).not.toBe(null);
    // The stored key has to carry the account and the folder. A bare UID would
    // be read by every account's list and by every folder of this one.
    expect(alerts[`${lukeId}-Sent-${SHARED_UID}`]).toBe('red');
    expect(alerts[String(SHARED_UID)]).toBeUndefined();
  });

  it('leaves the INBOX message on the same UID unflagged', async function () {
    await switchToFolder(LUKE, 'INBOX');

    const inboxRow = await rowAlert(SHARED_UID);
    expect(inboxRow.subject).toContain(HTML_QUOTED_SUBJECT);
    expect(inboxRow.linkAlert).toBe(null);

    const flagged = await flaggedRowSubjects(ALERT_BUTTON);
    expect(flagged).toEqual([]);
  });

  it('shows the warning again when the folder comes back', async function () {
    // Nothing is re-opened here: the row is painted from the persisted map, the
    // path that used to read it by bare UID.
    await switchToFolder(LUKE, 'Sent');

    await browser.waitUntil(async () => (await rowAlert(SHARED_UID)).linkAlert === 'red', {
      timeout: 30_000,
      interval: 400,
      timeoutMsg: `Sent UID ${SHARED_UID} came back unflagged: ${JSON.stringify(await rowAlert(SHARED_UID))}`,
    });
  });

  it('lists the spoofed link, not another message\'s links', async function () {
    expect(await clickRow(HTML_COLLISION_SUBJECT)).toBe(true);

    await browser.waitUntil(async () => browser.execute((sel) => {
      const btn = document.querySelector(sel);
      return !!btn && btn.offsetHeight > 0;
    }, ALERT_BUTTON), {
      timeout: 30_000, interval: 400, timeoutMsg: 'Viewer never showed the link warning button',
    });

    await browser.execute((sel) => document.querySelector(sel)?.click(), ALERT_BUTTON);
    await browser.pause(500);

    const modalText = await browser.execute(() => {
      const heading = [...document.querySelectorAll('h3')]
        .find((h) => (h.textContent || '').includes('Dangerous links detected'));
      return heading ? (heading.closest('div.relative')?.innerText || '') : null;
    });

    expect(modalText).not.toBe(null);
    expect(modalText).toContain(PHISH_LINK_TEXT);
    expect(modalText).toContain(PHISH_LINK_HREF);

    // Close it so the next spec file doesn't inherit an open modal.
    await browser.execute(() => {
      const heading = [...document.querySelectorAll('h3')]
        .find((h) => (h.textContent || '').includes('Dangerous links detected'));
      heading?.closest('div.relative')?.querySelector('button')?.click();
    });
    await browser.pause(300);
  });
});
