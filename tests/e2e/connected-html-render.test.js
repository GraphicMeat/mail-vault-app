/**
 * E2E Test: HTML email rendering (iframe background + frame sizing)
 *
 * Covers two regressions that only appear on the iframe path, which plain-text
 * mock mail never reaches:
 *
 * 1. Dark Reader ran with `contrast: 90`, which pulled its configured
 *    background (#0a0a0f, the app's --mail-bg) toward mid-grey. Every HTML
 *    message then sat in a visibly lighter box while plain-text mail in the
 *    same thread did not.
 * 2. The frame auto-size measured `documentElement.scrollHeight`, which is
 *    never smaller than the frame's own viewport — so each of the four
 *    re-measures read back the current height and added the padding again,
 *    leaving dead space under a folded quote. Expanding a quote in the
 *    single-email viewer also did nothing, because only thread view listened
 *    for the frame's resize message.
 *
 * The fixture is the newest message in account 1's INBOX (see
 * `htmlQuotedMessage` in mockImap.js).
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { HTML_QUOTED_SUBJECT } from './mockImap.js';

/** Everything the assertions need, read from inside the email iframe. */
async function readFrame() {
  return browser.execute(() => {
    const iframe = document.querySelector('iframe[sandbox]');
    if (!iframe) return null;
    let doc;
    try {
      doc = iframe.contentDocument;
    } catch {
      return null;
    }
    if (!doc || !doc.body) return null;
    const quotes = [...doc.querySelectorAll('[data-quote-folded]')];
    const hex = getComputedStyle(document.documentElement)
      .getPropertyValue('--mail-bg').trim().replace('#', '');
    const rgb = hex.length === 6
      ? `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`
      : '';
    return {
      frameHeight: Math.round(iframe.getBoundingClientRect().height),
      contentHeight: doc.body.scrollHeight,
      bodyBg: getComputedStyle(doc.body).backgroundColor,
      appBg: rgb,
      quotes: quotes.length,
      quotesHidden: quotes.length > 0 && quotes.every((q) => q.style.display === 'none'),
      hasToggle: quotes.length > 0 && !!quotes[0].previousElementSibling,
    };
  });
}

/** Click the fold toggle sitting in front of the first quote. */
async function clickQuoteToggle() {
  const clicked = await browser.execute(() => {
    const iframe = document.querySelector('iframe[sandbox]');
    const quote = iframe?.contentDocument?.querySelector('[data-quote-folded]');
    const toggle = quote?.previousElementSibling;
    if (!toggle) return false;
    toggle.click();
    return true;
  });
  // The toggle posts its new height to the host, which resizes the frame.
  await browser.pause(400);
  return clicked;
}

describe('HTML email rendering', function () {
  this.timeout(90_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();

    // Open the one HTML message. It is the newest in account 1's INBOX, but
    // match on the subject rather than trusting row order.
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

    // Wait for the iframe to exist, be laid out, and have Dark Reader applied
    // (its inline script runs during load, so a white body means not yet).
    await browser.waitUntil(async () => {
      const f = await readFrame();
      return !!f && f.frameHeight > 0 && f.bodyBg !== 'rgb(255, 255, 255)';
    }, {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: 'Email iframe never rendered a themed body',
    });

    // The last auto-size pass fires 1s after load; let it land before measuring.
    await browser.pause(2000);
  });

  it('renders the HTML body in an iframe with the quote folded away', async function () {
    // Positive control: without a folded quote every height assertion below
    // would pass vacuously.
    const frame = await readFrame();
    expect(frame).not.toBe(null);
    expect(frame.quotes).toBeGreaterThan(0);
    expect(frame.quotesHidden).toBe(true);
    expect(frame.hasToggle).toBe(true);
  });

  it('renders on the app background, not a lighter box', async function () {
    const frame = await readFrame();
    expect(frame.appBg).toMatch(/^rgb\(/);
    expect(frame.bodyBg).toBe(frame.appBg);
  });

  it('sizes the frame to its content instead of ratcheting taller', async function () {
    const frame = await readFrame();
    // 300 is the viewer's minimum height; above that the frame must track the
    // content. The pre-fix ratchet added 32px per measurement pass.
    expect(frame.frameHeight).toBeLessThanOrEqual(Math.max(frame.contentHeight + 40, 300));
  });

  it('resizes when the quote is expanded and collapsed', async function () {
    const before = await readFrame();

    expect(await clickQuoteToggle()).toBe(true);
    const expanded = await readFrame();
    expect(expanded.quotesHidden).toBe(false);
    // The fixture's quote is 24 paragraphs — far more than any measuring slack.
    expect(expanded.frameHeight).toBeGreaterThan(before.frameHeight + 200);
    expect(expanded.frameHeight).toBeLessThanOrEqual(expanded.contentHeight + 40);

    expect(await clickQuoteToggle()).toBe(true);
    const collapsed = await readFrame();
    expect(collapsed.quotesHidden).toBe(true);
    expect(Math.abs(collapsed.frameHeight - before.frameHeight)).toBeLessThanOrEqual(12);
  });
});
