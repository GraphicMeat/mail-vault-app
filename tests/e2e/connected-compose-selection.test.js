/**
 * E2E: selecting text in a compose window must never dismiss it.
 *
 * The report: "selecting text in compose view hides the view to a bubble a few
 * times, and after one of the times the compose just disappears."
 *
 * Two defects compound into that:
 *
 *  1. `click` is dispatched on the nearest common ancestor of the mousedown and
 *     the mouseup target. A selection that starts in the editor and releases
 *     past the window edge therefore fires `click` ON THE BACKDROP — the
 *     modal's own stopPropagation is never in the path — and the backdrop
 *     handler minimizes the draft. That is the "hides to a bubble" half.
 *
 *  2. Restoring a bubble remounts the modal with the saved draft as
 *     `initialData`, and the dirty baseline used to be recorded FROM that
 *     restored content. A restored draft therefore read as pristine, so the
 *     next dismissal took the "empty compose" branch — `onClose()`, no discard
 *     confirmation, window and draft gone. That is the "just disappears" half.
 *
 * Harness facts these lean on (see composeHelpers.js):
 *   - framer-motion exits never finish under the occluded E2E window, so a
 *     minimized modal can linger in the DOM. The bubble count is the positive
 *     evidence that a minimize happened; the modal's presence is not.
 *   - `expect(value, 'message')` throws in this runner — one argument only.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  openComposeFresh,
  closeComposeHard,
  setField,
  fieldValue,
  modalOpen,
  modalCount,
  testidPresent,
  testidText,
  clickButtonTitle,
  dragSelectOntoBackdrop,
  clickBackdrop,
  bubbles,
  clickBubble,
} from './composeHelpers.js';

describe('Connected Compose — text selection must not dismiss the window', function () {
  this.timeout(120_000);

  async function freshCompose() {
    await browser.execute(() => document.activeElement?.blur());
    await openComposeFresh();
  }

  const fillDraft = async (subject) => {
    await setField('compose-to', 'someone@example.com');
    await setField('compose-subject', subject);
  };

  const waitForBubbles = (count, why) => browser.waitUntil(async () => (await bubbles()).length === count, {
    timeout: 15_000,
    interval: 200,
    timeoutMsg: why,
  });

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  it('stays open when a text selection is released on the backdrop', async function () {
    await freshCompose();
    await fillDraft('Selection must not minimize');

    await dragSelectOntoBackdrop();

    // The gesture began inside the modal, so it is a selection, not a click
    // away. Nothing may be dismissed by it.
    expect((await bubbles()).length).toBe(0);
    expect(await modalOpen()).toBe(true);
    expect(await fieldValue('compose-subject')).toBe('Selection must not minimize');
  });

  it('survives a real mouse drag out of the window, not just a synthetic one', async function () {
    await freshCompose();
    await fillDraft('Native drag must not minimize');

    // The case above builds the event sequence by hand. This one hands the
    // gesture to the driver — press inside the subject field, drag out over the
    // backdrop, release — so the browser decides for itself which element the
    // click lands on. If WebKit ever changed that rule, this is the case that
    // would notice.
    const points = await browser.execute(() => {
      const modal = document.querySelector('[data-testid="compose-modal"]');
      const field = document.querySelector('[data-testid="compose-subject"]');
      if (!modal || !field) return null;
      const f = field.getBoundingClientRect();
      const m = modal.getBoundingClientRect();
      return {
        from: { x: Math.round(f.left + 20), y: Math.round(f.top + f.height / 2) },
        to: { x: Math.round(Math.max(4, m.left / 2)), y: Math.round(m.top + m.height / 2) },
      };
    });
    expect(points).not.toBe(null);

    await browser.performActions([{
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', duration: 0, x: points.from.x, y: points.from.y },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', duration: 120, x: points.to.x, y: points.to.y },
        { type: 'pointerUp', button: 0 },
      ],
    }]);
    await browser.releaseActions();
    await browser.pause(500);

    expect((await bubbles()).length).toBe(0);
    expect(await modalOpen()).toBe(true);
  });

  it('still minimizes when the click really starts on the backdrop', async function () {
    await freshCompose();
    await fillDraft('Backdrop still minimizes');

    await clickBackdrop();

    // The guard above must not cost the real click-away — press and release
    // both outside is still a dismissal.
    await waitForBubbles(1, 'A press-and-release on the backdrop no longer minimizes the draft');
    expect(await testidPresent('compose-discard-dialog')).toBe(false);
  });

  it('minimizes a restored draft again instead of throwing it away', async function () {
    await freshCompose();
    await fillDraft('Restored draft survives');

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await waitForBubbles(1, 'Minimize did not produce a draft bubble');
    expect(await clickBubble(0)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'Clicking the draft bubble did not restore the compose window',
    });

    await clickBackdrop();

    // A restored draft is the same draft, still dirty. Dismissing it must
    // minimize it back to a bubble — closing it here destroys real content
    // with no confirmation.
    await waitForBubbles(1, 'A backdrop click on a RESTORED draft closed it instead of minimizing — the draft was destroyed');
    expect(await clickBubble(0)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'The re-minimized draft would not restore',
    });
    expect(await fieldValue('compose-subject')).toBe('Restored draft survives');
  });

  it('asks before discarding a restored draft', async function () {
    await freshCompose();
    await fillDraft('Restored draft asks first');

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await waitForBubbles(1, 'Minimize did not produce a draft bubble');
    expect(await clickBubble(0)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'Clicking the draft bubble did not restore the compose window',
    });

    expect(await clickButtonTitle('Close')).toBe(true);
    await browser.waitUntil(() => testidPresent('compose-discard-dialog'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'Close on a restored draft did not confirm — it went straight through and discarded the content',
    });
    expect(await testidText('compose-discard-dialog')).toContain('Discard message?');
    expect(await modalCount()).toBe(1);
  });
});
