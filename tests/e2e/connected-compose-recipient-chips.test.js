/**
 * E2E: Connected Compose Recipient Chips — To / Cc / Bcc as chips in the real
 * app: Enter commits, a pasted mailto: link loses its scheme and sends its
 * cc= / bcc= to those fields, a chip edits in place and drags to another
 * field, and Send names an entry that is not an address.
 *
 * Harness facts this leans on:
 *   - `expect(value, 'message')` throws in this runner (one argument only).
 *   - `browser.keys` never types under tauri-wd, so text goes in with
 *     `setField` and Enter with `keyInField` (keydown only, which is all the
 *     chip input listens to).
 *   - A paste is a synthetic ClipboardEvent carrying a DataTransfer; the chip
 *     input reads `clipboardData`, never the system clipboard.
 *   - The drag is dispatched in-page with the chips' real rectangles:
 *     `elementFromPoint` then resolves the field under the pointer exactly as
 *     it does for a user.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  openComposeFresh,
  closeComposeHard,
  setField,
  fieldValue,
  keyInField,
  clickSend,
  modalOpen,
  testidText,
} from './composeHelpers.js';

const chipsOf = (field) => browser.execute((f) =>
  [...document.querySelectorAll(`[data-recipient-field="${f}"] [data-testid="recipient-chip"]`)]
    .map((c) => c.textContent), field);

const invalidChips = (field) => browser.execute((f) =>
  [...document.querySelectorAll(`[data-recipient-field="${f}"] [data-testid="recipient-chip"][data-invalid]`)]
    .map((c) => c.textContent), field);

const paste = (testid, text) => browser.execute((id, t) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  el.focus();
  const data = new DataTransfer();
  data.setData('text/plain', t);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, testid, text);

const clickIn = (selector, index = 0) => browser.execute((sel, i) => {
  const el = document.querySelectorAll(sel)[i];
  if (!el) return false;
  el.click();
  return true;
}, selector, index);

const commit = async (testid, text) => {
  await setField(testid, text);
  await keyInField(testid, 'Enter');
};

describe('Connected Compose Recipient Chips', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  beforeEach(async function () {
    await browser.execute(() => document.activeElement?.blur());
    await openComposeFresh();
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  it('turns a typed address into a chip on Enter', async function () {
    await commit('compose-to', 'ann@example.test');
    expect(await chipsOf('to')).toEqual(['ann@example.test']);
    // The field's string keeps the comma the rest of compose reads.
    expect(await fieldValue('compose-to')).toBe('ann@example.test, ');
  });

  it('drops mailto: from a pasted link', async function () {
    await paste('compose-to', 'mailto:impressum@amazon.de');
    expect(await chipsOf('to')).toEqual(['impressum@amazon.de']);
    expect(await fieldValue('compose-to')).toBe('impressum@amazon.de, ');
  });

  it('separates a pasted list and skips repeats', async function () {
    await paste('compose-to', 'a@example.test; "Doe, John" <j@example.test>\nb@example.test A@EXAMPLE.test');
    expect(await chipsOf('to')).toEqual(['a@example.test', 'Doe, John', 'b@example.test']);
  });

  it('sends a pasted mailto: link\'s cc= and bcc= to their fields', async function () {
    await paste('compose-to', 'mailto:to@example.test?cc=cc@example.test&bcc=bcc@example.test&subject=Hi');
    expect(await chipsOf('to')).toEqual(['to@example.test']);
    expect(await chipsOf('cc')).toEqual(['cc@example.test']);
    expect(await chipsOf('bcc')).toEqual(['bcc@example.test']);
  });

  it('removes a chip with its x', async function () {
    await paste('compose-to', 'a@example.test, b@example.test');
    expect(await clickIn('[data-recipient-field="to"] [data-testid="recipient-chip-remove"]', 0)).toBe(true);
    expect(await chipsOf('to')).toEqual(['b@example.test']);
  });

  it('edits a chip in place', async function () {
    await paste('compose-to', 'a@example.test, b@example.test');
    expect(await clickIn('[data-recipient-field="to"] [data-testid="recipient-chip-text"]', 0)).toBe(true);
    await setField('recipient-chip-edit', 'changed@example.test');
    await keyInField('recipient-chip-edit', 'Enter');
    expect(await chipsOf('to')).toEqual(['changed@example.test', 'b@example.test']);
  });

  it('drags a chip from To to Cc', async function () {
    await paste('compose-to', 'a@example.test, b@example.test');
    await browser.execute(() => {
      const center = (el) => {
        const r = el.getBoundingClientRect();
        return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      };
      const chip = document.querySelector('[data-recipient-field="to"] [data-testid="recipient-chip-text"]');
      const cc = document.querySelector('[data-recipient-field="cc"] [data-testid="compose-cc"]');
      const from = center(chip);
      const to = center(cc);
      const mouse = (type, target, at) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...at }));
      mouse('mousedown', chip, from);
      mouse('mousemove', document, { clientX: from.clientX + 20, clientY: from.clientY + 20 });
      mouse('mousemove', document, to);
      mouse('mouseup', document, to);
    });
    expect(await chipsOf('to')).toEqual(['b@example.test']);
    expect(await chipsOf('cc')).toEqual(['a@example.test']);
  });

  it('outlines a chip that is not an address, and Send names it', async function () {
    await paste('compose-to', 'ok@example.test');
    await commit('compose-cc', 'John Doe');
    expect(await invalidChips('cc')).toEqual(['John Doe']);
    expect(await clickSend()).toBe(true);
    await browser.waitUntil(async () => (await testidText('compose-error'))?.includes('John Doe'), {
      timeout: 10_000, interval: 200, timeoutMsg: 'Send did not name the entry that is not an address',
    });
    // Nothing was sent: the compose window is still there.
    expect(await modalOpen()).toBe(true);
  });
});
