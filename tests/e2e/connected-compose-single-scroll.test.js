/**
 * E2E: the compose window has ONE scroll view.
 *
 * A long message with an attachment used to show two scrollbars, one inside the
 * other: the window's (address rows, attachments, body) and the editor's own.
 * jsdom cannot lay anything out, so the unit suite (composeSingleScroll.test.jsx)
 * proves the structure; this spec proves it against real layout:
 *
 *   - exactly one element in the compose column has overflow auto|scroll
 *   - after a message far taller than the window, that one element is the only
 *     one actually overflowing, and it is the one that grows scrollable
 *   - the Send footer is still on screen (it must never scroll away)
 *
 * Harness facts: see composeHelpers.js. `expect(value, 'message')` throws in
 * this runner, so every explanation is a comment above its assertion.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  MODAL,
  openComposeFresh,
  closeComposeHard,
  typeInBody,
  attachViaInput,
  pdfFile,
} from './composeHelpers.js';

/** In-page: every overflow auto|scroll element in the compose column, and whether it really overflows. */
const scrollViews = () => browser.execute((modalSel) => {
  const main = document.querySelector(`${modalSel} [data-testid="compose-main"]`);
  if (!main) return null;
  return [main, ...main.querySelectorAll('*')]
    .filter((el) => {
      const cs = getComputedStyle(el);
      return ['auto', 'scroll'].includes(cs.overflowY) || ['auto', 'scroll'].includes(cs.overflow);
    })
    .map((el) => ({
      cls: el.className,
      overflowing: el.scrollHeight > el.clientHeight + 1,
    }));
}, MODAL);

describe('Connected Compose single scroll view', function () {
  this.timeout(60000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  beforeEach(async function () {
    await openComposeFresh();
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  it('has one scroll view on an empty message', async function () {
    const views = await scrollViews();
    // Two scrollers (window + editor) is the defect this spec guards.
    expect(views.length).toBe(1);
  });

  it('keeps one scroll view for a very long message with an attachment', async function () {
    expect(await attachViaInput([pdfFile('offer.pdf')])).toBe(true);
    await typeInBody(Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a long message`).join('\n'));

    const views = await scrollViews();
    expect(views.length).toBe(1);
    // The one scroller carries the overflow: nothing nested scrolls beside it.
    expect(views.filter((v) => v.overflowing).length).toBe(1);
  });

  it('keeps the Send footer on screen while the message scrolls', async function () {
    await typeInBody(Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`).join('\n'));

    const footer = await browser.execute((modalSel) => {
      const modal = document.querySelector(modalSel);
      const f = modal.querySelector('.compose-footer');
      if (!f) return null;
      const fr = f.getBoundingClientRect();
      const mr = modal.getBoundingClientRect();
      return { inside: fr.top >= mr.top && fr.bottom <= mr.bottom + 1 };
    }, MODAL);
    expect(footer).not.toBe(null);
    expect(footer.inside).toBe(true);
  });
});
