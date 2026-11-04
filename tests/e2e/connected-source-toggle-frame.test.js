/**
 * E2E Test: the frame that comes back from View Source still guards its links
 *
 * View Source swaps the reader's frame for a <pre>; turning it off mounts a new
 * <iframe> with the same body. The handlers were attached on a dependency on
 * the body, so the new frame had none: a click on a flagged link went straight
 * through with no link safety warning, the frame stopped sizing to its mail and
 * the context menu was gone.
 *
 * Fixture: mockImap.js gives luke's Sent UID 41 a link whose text says bank.test
 * and whose href goes to evil.test, which the daemon's scan flags red.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { HTML_COLLISION_SUBJECT, PHISH_LINK_HREF } from './mockImap.js';

const LUKE = 'luke@mock.test';

/** The reader's frame as it stands, once its body has finished loading. */
const frameState = (href) => browser.execute((wanted) => {
  const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentDocument?.querySelector('#mv-collision-body'));
  if (!frame || frame.contentDocument.readyState !== 'complete') return null;
  return {
    flagged: !!frame.contentDocument.querySelector(`a[href="${wanted}"][data-link-alert]`),
    height: frame.style.height,
  };
}, href);

const waitForFrame = () => browser.waitUntil(async () => (await frameState(PHISH_LINK_HREF))?.flagged === true, {
  timeout: 30_000, interval: 200, timeoutMsg: 'the frame never showed the flagged link',
});

/** Click the flagged link inside the frame, as the mail's own document sees it. */
const clickFlaggedLink = (href) => browser.execute((wanted) => {
  const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentDocument?.querySelector('#mv-collision-body'));
  frame.contentDocument.querySelector(`a[href="${wanted}"]`).click();
}, href);

const contextMenuOnLink = (href) => browser.execute((wanted) => {
  const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentDocument?.querySelector('#mv-collision-body'));
  const doc = frame.contentDocument;
  doc.querySelector(`a[href="${wanted}"]`).dispatchEvent(new doc.defaultView.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const menu = doc.getElementById('mv-ctx-menu');
  menu?.remove();
  return !!menu;
}, href);

const safetyDialogShown = () => browser.execute(() => [...document.querySelectorAll('[role="alertdialog"]')].some((d) => d.offsetHeight > 0));

const closeSafetyDialog = async () => {
  await browser.execute(() => {
    const d = [...document.querySelectorAll('[role="alertdialog"]')].find((el) => el.offsetHeight > 0);
    [...(d?.querySelectorAll('button') || [])].find((b) => /cancel/i.test(`${b.textContent} ${b.getAttribute('aria-label')}`))?.click();
  });
  await browser.waitUntil(async () => !(await safetyDialogShown()), { timeout: 5_000, interval: 100, timeoutMsg: 'the link safety warning never closed' });
};

const clickHeaderButton = (label) => browser.execute((l) => {
  const header = document.querySelector('[data-testid="sender-header"]');
  const b = [...(header?.querySelectorAll('button') || [])].find((x) => x.offsetHeight > 0 && (x.textContent || '').trim() === l);
  if (!b) return false;
  b.click();
  return true;
}, label);

describe('View Source and the frame that comes back', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'Sent');
    await browser.waitUntil(() => browser.execute((subject) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => (r.innerText || '').includes(subject) && r.offsetHeight > 0);
      row?.click();
      return !!row;
    }, HTML_COLLISION_SUBJECT), { timeout: 30_000, interval: 300, timeoutMsg: 'the flagged message never listed' });
    await waitForFrame();
  });

  it('the frame the message opened in warns before a flagged link', async function () {
    await clickFlaggedLink(PHISH_LINK_HREF);
    await browser.waitUntil(safetyDialogShown, { timeout: 5_000, interval: 100, timeoutMsg: 'no link safety warning on first open' });
    await closeSafetyDialog();
  });

  it('after View Source on and off, the new frame still warns, sizes and offers its menu', async function () {
    await browser.execute(() => {
      const b = document.querySelector('[data-testid="sender-header"] [data-testid="header-toggle"]');
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
    });
    await browser.waitUntil(() => clickHeaderButton('More'), { timeout: 10_000, interval: 200, timeoutMsg: 'the header never offered More' });
    await browser.waitUntil(() => clickHeaderButton('View Source'), { timeout: 10_000, interval: 200, timeoutMsg: 'the header never offered View Source' });
    await browser.waitUntil(async () => (await frameState(PHISH_LINK_HREF)) === null, { timeout: 15_000, interval: 200, timeoutMsg: 'View Source never replaced the frame' });

    await browser.waitUntil(() => clickHeaderButton('Rendered'), { timeout: 10_000, interval: 200, timeoutMsg: 'the header never offered Rendered' });
    await waitForFrame();

    // All three together, so a red names every handler the frame is missing.
    const sized = /px$/.test((await frameState(PHISH_LINK_HREF)).height);
    const contextMenu = await contextMenuOnLink(PHISH_LINK_HREF);
    await clickFlaggedLink(PHISH_LINK_HREF);
    const linkSafety = await browser.waitUntil(safetyDialogShown, { timeout: 5_000, interval: 100 }).catch(() => false);
    expect({ sized, contextMenu, linkSafety }).toEqual({ sized: true, contextMenu: true, linkSafety: true });
    await closeSafetyDialog();
  });
});
