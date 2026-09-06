/**
 * E2E Test: the reading pane is the ONLY scroller
 *
 * The HTML body renders in an iframe that is auto-sized to its content, and
 * the reading pane scrolls it. Two ways that broke, both reported as "a
 * scrollbar inside a scrollbar":
 *
 * 1. The frame was sized from the BODY box, but `html` and `body` each carried
 *    16px of padding — so the root's 32px sat outside the measure and every
 *    HTML message's document overflowed its frame by 24px, for ever.
 *
 * 2. The auto-size only ran on `load` and at three fixed timers (100/200/1000
 *    ms). Anything that changed the document height later — a large image
 *    finishing decode, a remote image, a web font, Dark Reader's repaint, a
 *    late-resolved `cid:` — left the frame shorter than its document and the
 *    frame scrolled internally. The reported screenshot was a long newsletter
 *    with two big photos.
 *
 * The fix observes the frame's body with a ResizeObserver for the lifetime of
 * the frame (see attachEmailIframeAutoSize in utils/emailIframeTemplate.js).
 *
 * The fixture is `BIG_BODY_SUBJECT` — 9000 paragraphs, far taller than the
 * pane, so "the frame fits its content" is never vacuously true.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { BIG_BODY_SUBJECT, HTML_QUOTED_SUBJECT } from './mockImap.js';

/** How far the frame's own document can overflow before it scrolls. */
const TOLERANCE = 4;

/** Frame geometry plus every scrolling ancestor up to the app root. */
function readFrame() {
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
    // Ancestors that actually have somewhere to scroll to.
    const scrollers = [];
    for (let el = iframe.parentElement; el && el !== document.body; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      const range = el.scrollHeight - el.clientHeight;
      if ((overflowY === 'auto' || overflowY === 'scroll') && range > 0) {
        scrollers.push({ className: String(el.className || ''), range });
      }
    }
    return {
      frameHeight: iframe.clientHeight,
      // documentElement, not body: the root's own padding counts against the
      // frame viewport, and that is the box the frame actually scrolls.
      contentHeight: doc.documentElement.scrollHeight,
      bodyHeight: doc.body.scrollHeight,
      // What the frame itself scrolls: > 0 is the reported scrollbar inside
      // the reading pane's scrollbar.
      internalScroll: doc.documentElement.scrollHeight - doc.documentElement.clientHeight,
      scrollers,
    };
  });
}

/** The pane the frame sits in: where it is scrolled to, and how far it can go. */
function readPaneScroll() {
  return browser.execute(() => {
    const iframe = document.querySelector('iframe[sandbox]');
    for (let el = iframe?.parentElement; el; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      const range = el.scrollHeight - el.clientHeight;
      if ((overflowY === 'auto' || overflowY === 'scroll') && range > 0) {
        return { top: Math.round(el.scrollTop), range };
      }
    }
    return null;
  });
}

/** Wait until two consecutive reads report the same frame height. */
async function waitForSettled(timeoutMsg) {
  let last = -1;
  await browser.waitUntil(async () => {
    const frame = await readFrame();
    if (!frame || !frame.frameHeight) return false;
    const steady = frame.frameHeight === last;
    last = frame.frameHeight;
    return steady;
  }, { timeout: 45_000, interval: 750, timeoutMsg });
}

describe('Email iframe auto-size', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();

    const clicked = await browser.waitUntil(async () => browser.execute((subject) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((r) => r.offsetHeight > 0 && (r.textContent || '').includes(subject));
      if (!row) return false;
      row.click();
      return true;
    }, BIG_BODY_SUBJECT), {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `no row for "${BIG_BODY_SUBJECT}"`,
    });
    expect(clicked).toBe(true);

    await waitForSettled('the email iframe never settled on a height');
  });

  it('sizes the frame to its whole document, so the frame never scrolls', async function () {
    const frame = await readFrame();
    expect(frame).not.toBe(null);

    // Positive control: a body that fits the pane would pass every assertion
    // below without proving anything.
    expect(frame.frameHeight).toBeGreaterThan(2000);

    expect(frame.contentHeight).toBeLessThanOrEqual(frame.frameHeight + TOLERANCE);
  });

  it('leaves the reading pane as the only scrolling ancestor', async function () {
    const frame = await readFrame();
    expect(frame.scrollers.length).toBe(1);
    expect(frame.scrollers[0].className).toContain('overflow-y-auto');
    expect(frame.scrollers[0].range).toBeGreaterThan(0);
  });

  it('follows the document when it grows after the frame has settled', async function () {
    const before = await readFrame();

    // Stand-in for the late growth the reported message had: two large photos
    // finishing decode long after the last fixed timer would have fired.
    // Inserted from the host so the test does not depend on network images.
    const grew = await browser.execute((extra) => {
      const doc = document.querySelector('iframe[sandbox]')?.contentDocument;
      if (!doc || !doc.body) return false;
      const filler = doc.createElement('div');
      filler.id = 'late-growth-probe';
      filler.style.height = extra + 'px';
      doc.body.appendChild(filler);
      return true;
    }, 800);
    expect(grew).toBe(true);

    await browser.waitUntil(async () => {
      const frame = await readFrame();
      return !!frame && frame.frameHeight > before.frameHeight;
    }, {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: 'the frame never grew with its document — it is scrolling inside the pane',
    });

    await waitForSettled('the frame never settled after the late growth');
    const after = await readFrame();
    expect(after.frameHeight).toBeGreaterThanOrEqual(before.frameHeight + 800 - TOLERANCE);
    expect(after.contentHeight).toBeLessThanOrEqual(after.frameHeight + TOLERANCE);
  });

  it('holds the reader in place while a late resize re-measures the frame', async function () {
    // Measuring collapses the frame, which collapses the pane under the
    // reader, and a pane with nowhere left to scroll clamps its own scrollTop
    // — restoring the height does not bring it back. Every late image would
    // otherwise throw the reader to the top of a long message.
    const parked = 4000;
    const before = await readFrame();
    const pane = await readPaneScroll();
    expect(pane).not.toBe(null);
    expect(pane.range).toBeGreaterThan(parked);

    await browser.execute((top) => {
      const iframe = document.querySelector('iframe[sandbox]');
      for (let el = iframe?.parentElement; el; el = el.parentElement) {
        const overflowY = getComputedStyle(el).overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight - el.clientHeight > 0) {
          el.scrollTop = top;
          return;
        }
      }
    }, parked);
    expect((await readPaneScroll()).top).toBe(parked);

    // Grow the probe the previous test left behind: one more late resize.
    const grew = await browser.execute(() => {
      const probe = document.querySelector('iframe[sandbox]')
        ?.contentDocument?.getElementById('late-growth-probe');
      if (!probe) return false;
      probe.style.height = '1600px';
      return true;
    });
    expect(grew).toBe(true);

    await browser.waitUntil(async () => {
      const frame = await readFrame();
      return !!frame && frame.frameHeight >= before.frameHeight + 800 - TOLERANCE;
    }, { timeout: 20_000, interval: 250, timeoutMsg: 'the frame never followed the second growth' });

    expect((await readPaneScroll()).top).toBe(parked);
  });
});

/** Open the message with this subject and wait for its frame to settle. */
async function openMessage(subject) {
  const clicked = await browser.waitUntil(async () => browser.execute((wanted) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => r.offsetHeight > 0 && (r.textContent || '').includes(wanted));
    if (!row) return false;
    row.click();
    return true;
  }, subject), { timeout: 30_000, interval: 500, timeoutMsg: `no row for "${subject}"` });
  expect(clicked).toBe(true);
  await waitForSettled(`the frame for "${subject}" never settled on a height`);
}

/**
 * Give the open message's own document a stylesheet and a first child, the way
 * a mail carries them.
 *
 * A mail's `<head>` is dropped (getEmailBodyContent), so its CSS reaches the
 * frame as a `<style>` inside the body — which is what this appends.
 */
function styleFrame(css, prependHtml) {
  return browser.execute((cssText, html) => {
    const doc = document.querySelector('iframe[sandbox]')?.contentDocument;
    if (!doc || !doc.body) return false;
    const style = doc.createElement('style');
    style.dataset.mvProbe = '1';
    style.textContent = cssText;
    doc.body.appendChild(style);
    if (html) doc.body.insertAdjacentHTML('afterbegin', html);
    return true;
  }, css, prependHtml || '');
}

/**
 * Take every probe back out.
 *
 * Re-clicking the row that is already open does not rebuild the frame, so a
 * previous test's stylesheet would still be in force in the next one.
 */
function clearFrameProbes() {
  return browser.execute(() => {
    const doc = document.querySelector('iframe[sandbox]')?.contentDocument;
    if (!doc || !doc.body) return false;
    doc.querySelectorAll('[data-mv-probe], #mv-vh-filler, #mv-escape-probe')
      .forEach((el) => el.remove());
    return true;
  });
}

describe('Email iframe auto-size, bodies the frame cannot be measured against', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // A short HTML message, so the assertions below are about this document
    // and not about the 640 KB one the first suite opens.
    await openMessage(HTML_QUOTED_SUBJECT);
  });

  it('does not grow a body that is sized against the frame', async function () {
    // `html, body { height: 100% }` is standard email boilerplate. Measured at
    // the frame's current height, the body reports the number the auto-size
    // just wrote, so every observer tick added the padding again: 617, 625,
    // 633, … climbing for as long as the message stayed open. The filler makes
    // the true content height clear the 300px floor, so a frame that sits at
    // the floor cannot pass this vacuously.
    expect(await styleFrame(
      'html, body { height: 100%; }',
      '<div id="mv-vh-filler" style="height:1200px"></div>',
    )).toBe(true);

    await waitForSettled('the frame never settled with a viewport-sized body');
    const settled = await readFrame();
    expect(settled.frameHeight).toBeGreaterThan(1200);

    // Long enough for many observer ticks: the ratchet moved every ~200ms.
    await browser.pause(1200);
    const later = await readFrame();
    expect(later.frameHeight).toBe(settled.frameHeight);
    expect(later.internalScroll).toBeLessThanOrEqual(TOLERANCE);
  });

  it('sizes a body with its own margin/padding reset to the whole document', async function () {
    // With `body { margin: 0; padding: 0 }` the first child's top margin
    // collapses straight through the body and out of its box, and half the
    // template's page inset sits on `html`. A body-box measure misses both and
    // leaves the frame short by exactly that much — the reported scrollbar.
    expect(await clearFrameProbes()).toBe(true);
    expect(await styleFrame(
      'body { margin: 0; padding: 0; }',
      '<div id="mv-escape-probe" style="height:900px;margin-top:60px"></div>',
    )).toBe(true);

    await waitForSettled('the frame never settled with a reset body');
    const frame = await readFrame();
    expect(frame.frameHeight).toBeGreaterThan(900);
    expect(frame.internalScroll).toBeLessThanOrEqual(TOLERANCE);
    expect(frame.contentHeight).toBeLessThanOrEqual(frame.frameHeight + TOLERANCE);
  });
});
