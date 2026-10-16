/**
 * E2E Test: the reading pane has ONE vertical scroll view
 *
 * Reported (again) as two scrollbars side by side in the message: the pane's
 * own and a second one inside the email. The frame is sized to its document, so
 * the document should never scroll by itself. A mail sized to the window
 * (`min-height: 100vh`, a very common newsletter wrapper) breaks that: it is
 * measured against the frame's floor height, the frame grows to that, and the
 * mail grows again to fill the taller frame. It lands a few px taller than the
 * frame it was sized to, and the frame document scrolls inside the pane.
 *
 * jsdom cannot lay anything out (the unit suite proves the helper's logic with
 * a fake frame), so this proves it against the real webview:
 *
 *   - POSITIVE CONTROL: the viewport-bound mail really overflows its frame, so
 *     the assertions below cannot pass vacuously
 *   - the frame document is not a user scroller (overflow hidden, not
 *     auto / scroll / visible-that-overflows)
 *   - exactly one element between the frame and the window scrolls: the pane
 *
 * Harness facts: the one HTML message of account 1 is opened, then its body is
 * swapped through `window.__MAIL_STORE__` (VITE_E2E build) so the real
 * EmailViewer lays out a mail this suite's mock IMAP server does not carry.
 * `expect(value, 'message')` throws in this runner: explanations are comments.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { HTML_QUOTED_SUBJECT } from './mockImap.js';

const VH_MARKER = 'mv-vh-wrapper';
const VH_BODY = `<div id="${VH_MARKER}" style="min-height:100vh">`
  + '<p>Gerbiamas kliente,</p><p>Sio laisko priede siunciame mokejimo pranesima.</p>'
  + '<p>Pagarbiai</p></div>';

/** Open the HTML message, then wait for its frame to be laid out. */
async function openHtmlMessage() {
  const clicked = await browser.execute((subject) => {
    for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
      if ((row.textContent || '').includes(subject) && row.offsetHeight > 0) {
        row.click();
        return true;
      }
    }
    return false;
  }, HTML_QUOTED_SUBJECT);
  expect(clicked).toBe(true);
  await waitForFrame((f) => f.frameHeight > 0 && f.hasBody);
}

/** Replace the open message's HTML, the way a different mail would arrive. */
async function showBody(html) {
  await browser.execute((body) => {
    const store = window.__MAIL_STORE__;
    store.setState({ selectedEmail: { ...store.getState().selectedEmail, html: body } });
  }, html);
}

/** What the frame looks like right now, or null before it exists. */
function readFrame() {
  return browser.execute((marker) => {
    const iframe = document.querySelector('iframe[sandbox]');
    if (!iframe) return null;
    let doc;
    try { doc = iframe.contentDocument; } catch { return null; }
    if (!doc || !doc.documentElement) return null;
    const root = doc.documentElement;
    const scrolls = (el) => {
      const cs = getComputedStyle(el);
      return ['auto', 'scroll'].includes(cs.overflowY);
    };
    // Everything between the frame and the window that a user can scroll
    // vertically. The frame's own root counts when it is auto|scroll, or
    // visible (which the viewport treats as auto) and really overflowing.
    const rootCs = doc.defaultView.getComputedStyle(root);
    const rootScrolls = ['auto', 'scroll'].includes(rootCs.overflowY)
      || (rootCs.overflowY === 'visible' && root.scrollHeight > root.clientHeight + 1);
    const ancestors = [];
    for (let el = iframe.parentElement; el; el = el.parentElement) {
      if (scrolls(el)) ancestors.push(el.className);
    }
    return {
      hasBody: !!doc.body,
      hasMarker: !!doc.getElementById(marker),
      frameHeight: Math.round(iframe.getBoundingClientRect().height),
      rootOverflowY: rootCs.overflowY,
      docOverflowsFrame: root.scrollHeight > root.clientHeight + 1,
      scrollViews: (rootScrolls ? 1 : 0) + ancestors.length,
    };
  }, VH_MARKER);
}

async function waitForFrame(ready, timeoutMsg = 'email frame never settled') {
  await browser.waitUntil(async () => {
    const f = await readFrame();
    return !!f && ready(f);
  }, { timeout: 30_000, interval: 250, timeoutMsg });
  // The sizer is observer-driven; give the last pass a beat to land.
  await browser.pause(800);
}

describe('Connected viewer single scroll view', function () {
  this.timeout(90_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await openHtmlMessage();
  });

  it('has one scroll view for an ordinary HTML message', async function () {
    const f = await readFrame();
    expect(f).not.toBe(null);
    expect(f.docOverflowsFrame).toBe(false);
    // The pane, and nothing inside it.
    expect(f.scrollViews).toBe(1);
  });

  it('has one scroll view for a mail sized to the window height', async function () {
    await showBody(VH_BODY);
    await waitForFrame((f) => f.hasMarker, 'viewport-bound mail never rendered');

    const f = await readFrame();
    // Positive control: this mail really is taller than the frame it was sized
    // to. If it were not, the assertions below would pass for any build.
    expect(f.docOverflowsFrame).toBe(true);
    // The frame document must not be scrollable by the user, however much it
    // overflows: the pane is the one scroller.
    expect(f.rootOverflowY).toBe('hidden');
    expect(f.scrollViews).toBe(1);
  });

  it('keeps the lock after the next message swaps the document in', async function () {
    await showBody(VH_BODY.replace('Pagarbiai', 'Su pagarba'));
    await waitForFrame((f) => f.hasMarker, 'second viewport-bound mail never rendered');
    const f = await readFrame();
    expect(f.rootOverflowY).toBe('hidden');
    expect(f.scrollViews).toBe(1);
  });
});
