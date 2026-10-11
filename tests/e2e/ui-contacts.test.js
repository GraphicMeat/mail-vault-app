/**
 * E2E Test: Contacts (people), through the UI only.
 *
 * Opens the full-pane Contacts view from the sidebar and drives it with the
 * visible controls: create, edit, merge, undo through the Activity tab,
 * vCard import and the review queue. No store seam: every assertion reads the
 * DOM. Names and addresses carry a per-run tag so the list search isolates
 * this run's rows from anything else in the profile.
 */

import assert from 'node:assert/strict';
import { waitForApp } from './helpers.js';
import { clickReachable, setControl, dismissOnboardingNotice } from './insightsHelpers.js';

const TAG = Date.now().toString(36);
const ADA = { name: `E2E Ada ${TAG}`, email: `ada.${TAG}@e2e-contacts.test` };
const BOB = { name: `E2E Bob ${TAG}`, email: `bob.${TAG}@e2e-contacts.test` };
const IMPORTED = { name: `E2E Imported ${TAG}`, email: `imported.${TAG}@e2e-contacts.test` };
const NOTES = `Met at the conference ${TAG}`;

const tid = (id) => `[data-testid="${id}"]`;

/** React-controlled text input or textarea: native setter plus input event. */
async function fill(selector, value) {
  await browser.waitUntil(() => browser.execute((sel) => {
    const node = document.querySelector(sel);
    return !!node && !node.disabled && node.offsetHeight > 0;
  }, selector), { timeout: 10000, interval: 100, timeoutMsg: `Input never appeared: ${selector}` });
  const ok = await browser.execute((sel, next) => {
    const node = document.querySelector(sel);
    if (!node) return false;
    node.focus();
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, next);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, selector, String(value));
  assert.equal(ok, true, `Fillable input: ${selector}`);
}

const valueOf = (selector) => browser.execute((sel) => document.querySelector(sel)?.value ?? null, selector);
const present = (selector) => browser.execute((sel) => !!document.querySelector(sel), selector);

/** Exists, has a box and is not hidden. Selector is resolved inside the page. */
const shown = (selector) => browser.execute((sel) => {
  const node = document.querySelector(sel);
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}, selector);

async function waitShown(selector, timeout = 15000) {
  await browser.waitUntil(() => shown(selector), { timeout, interval: 150, timeoutMsg: `Never displayed: ${selector}` });
}

async function waitFor(condition, message, timeout = 15000) {
  await browser.waitUntil(condition, { timeout, interval: 150, timeoutMsg: message });
}

/** Failure-only probe: what sits on top of `selector`'s center, as JSON. */
const coverReport = (selector) => browser.execute((sel) => {
  const node = document.querySelector(sel);
  if (!node) return { missing: sel };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const label = (el) => ({ tag: el.tagName, testid: el.getAttribute('data-testid'), cls: String(el.className?.baseVal ?? el.className).slice(0, 120) });
  const rect = node.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (!hit || hit === node || node.contains(hit)) return { reachable: true, button: box(node) };
  const chain = [];
  for (let el = hit.parentElement; el && chain.length < 6; el = el.parentElement) chain.push(label(el));
  const overlays = [...document.querySelectorAll('body *')].filter((el) => {
    const position = getComputedStyle(el).position;
    if (position !== 'fixed' && position !== 'absolute') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > rect.left && r.left < rect.right && r.bottom > rect.top && r.top < rect.bottom;
  }).map((el) => ({ ...label(el), position: getComputedStyle(el).position, text: (el.textContent || '').trim().slice(0, 60) }));
  return { hitHtml: hit.outerHTML.slice(0, 300), hit: label(hit), hitRect: box(hit), chain, button: box(node), viewport: { w: innerWidth, h: innerHeight }, overlays };
}, selector);

/** clickReachable, naming the covering element when the control never frees up. */
async function clickReachableOrExplain(selector) {
  try {
    await clickReachable(selector);
  } catch (error) {
    throw new Error(`${error.message}\nCover probe: ${JSON.stringify(await coverReport(selector))}`);
  }
}

/** data-testid of every list row whose text contains `text`. */
const rowIds = (text) => browser.execute((needle) => [...document.querySelectorAll('[data-testid^="contact-row-"]')]
  .filter((row) => row.textContent.includes(needle)).map((row) => row.dataset.testid), text);

async function waitForRows(text, count) {
  await waitFor(async () => (await rowIds(text)).length === count, `Expected ${count} contact row(s) containing "${text}"`);
}

async function rowFor(text) {
  await waitForRows(text, 1);
  return (await rowIds(text))[0];
}

/** Narrow the list to this run's rows. */
async function searchList(text) {
  await fill(tid('contacts-search'), text);
}

/** Tabs of the person card are a radio group: details, mail, activity. */
async function openPersonTab(index) {
  const clicked = await browser.execute((i) => {
    const radio = document.querySelectorAll('[data-testid="person-card"] [role="radio"]')[i];
    if (!radio) return false;
    radio.click();
    return true;
  }, index);
  assert.equal(clicked, true, `Person card tab ${index} exists`);
}

async function openContacts() {
  await waitForApp();
  await dismissOnboardingNotice();
  await clickReachable(tid('open-contacts'));
  await waitShown(tid('contacts-view'), 30000);
}

async function createContact({ name, email }) {
  await clickReachable(tid('contacts-new'));
  await fill(tid('person-name'), name);
  await clickReachable(tid('person-add-email'));
  await fill(tid('person-email-0'), email);
  await waitFor(() => browser.execute(() => !document.querySelector('[data-testid="person-save"]')?.disabled), 'Save never enabled for the new contact');
  await clickReachable(tid('person-save'));
  await waitForRows(name, 1);
}

describe('Contacts', function () {
  this.timeout(240000);

  before(async () => {
    const state = await waitForApp();
    assert.equal(state, 'ready', 'Contacts needs the seeded accounts, not the welcome screen');
  });

  it('opens from the sidebar and shows the list controls', async () => {
    await openContacts();
    assert.ok(await shown(tid('contacts-new')));
    assert.ok(await shown(tid('contacts-search')));
    assert.ok(await shown(tid('contacts-import')));
    assert.equal(await browser.execute(() => document.querySelector('[data-testid="open-contacts"]')?.getAttribute('aria-current')), 'page');
  });

  it('creates a contact with a name and an email and lists it', async () => {
    await createContact(ADA);
    await searchList(TAG);
    const id = await rowFor(ADA.name);
    const text = await browser.execute((sel) => document.querySelector(sel).textContent, tid(id));
    assert.ok(text.includes(ADA.email), `Row shows the address: ${text}`);
    assert.equal(await valueOf(tid('person-name')), ADA.name);
    assert.equal(await valueOf(tid('person-email-0')), ADA.email);
  });

  it('edits the notes, saves, and finds them again after closing and reopening', async () => {
    await searchList(TAG);
    await clickReachable(tid(await rowFor(ADA.name)));
    await waitFor(async () => (await valueOf(tid('person-name'))) === ADA.name, 'Ada card never opened');
    await fill(tid('person-notes'), NOTES);
    await waitFor(() => browser.execute(() => !document.querySelector('[data-testid="person-save"]')?.disabled), 'Save never enabled after editing the notes');
    await clickReachable(tid('person-save'));
    await waitFor(() => browser.execute(() => document.querySelector('[data-testid="person-save"]')?.disabled === true), 'Save never settled after the edit');

    await clickReachable(tid('contacts-back'));
    await waitFor(async () => !(await present(tid('contacts-view'))), 'Contacts did not close');
    await openContacts();
    await searchList(TAG);
    await clickReachable(tid(await rowFor(ADA.name)));
    await waitFor(async () => (await valueOf(tid('person-notes'))) === NOTES, 'Saved notes did not come back after reopening');
  });

  it('creates a second contact', async () => {
    await createContact(BOB);
    await searchList(TAG);
    await waitForRows(TAG, 2);
    assert.equal((await rowIds(BOB.name)).length, 1);
  });

  it('merges the two contacts through the dialog into one row', async () => {
    await searchList(TAG);
    await clickReachable(tid(await rowFor(ADA.name)));
    await waitFor(async () => (await valueOf(tid('person-name'))) === ADA.name, 'Ada card never opened');
    await clickReachable(tid('person-merge'));
    await waitShown(tid('merge-search'), 10000);
    await fill(tid('merge-search'), BOB.name);
    await waitFor(() => browser.execute((label) => [...document.querySelectorAll('[data-testid="merge-other"] option')].some((o) => o.textContent === label), BOB.name),
      'Bob never appeared in the merge picker');
    const bobId = await browser.execute((label) => [...document.querySelectorAll('[data-testid="merge-other"] option')].find((o) => o.textContent === label).value, BOB.name);
    await setControl(tid('merge-other'), bobId);
    await waitShown(tid('merge-preview'), 10000);
    const previewed = await browser.execute(() => [...document.querySelectorAll('[data-testid="merge-preview-email"]')].map((n) => n.textContent));
    assert.deepEqual(previewed.sort(), [ADA.email, BOB.email].sort(), 'Preview combines both addresses');
    await clickReachable(tid('merge-confirm'));
    await waitFor(async () => !(await present(tid('merge-confirm'))), 'Merge dialog did not close');

    await waitForRows(TAG, 1);
    assert.equal((await rowIds(ADA.name)).length, 1, 'The kept contact stays');
    assert.equal((await rowIds(BOB.name)).length, 0, 'The merged contact is gone');
    await waitFor(async () => (await valueOf(tid('person-email-1'))) !== null, 'The merged card never showed the second address');
    const emails = [await valueOf(tid('person-email-0')), await valueOf(tid('person-email-1'))];
    assert.deepEqual(emails.sort(), [ADA.email, BOB.email].sort());
  });

  it('undoes the merge from the Activity tab and shows two rows again', async () => {
    await openPersonTab(2);
    await waitShown(tid('person-activity'), 10000);
    await waitFor(() => browser.execute(() => document.querySelector('[data-testid="activity-undo"]')?.disabled === false), 'Undo was never offered');
    await clickReachable(tid('activity-undo'));
    await searchList(TAG);
    await waitForRows(TAG, 2);
    assert.equal((await rowIds(ADA.name)).length, 1);
    assert.equal((await rowIds(BOB.name)).length, 1);
    await waitFor(() => browser.execute(() => !!document.querySelector('[data-testid^="activity-undone-"]')), 'The merge row never showed as undone');
  });

  it('imports a small vCard through the hidden file input', async () => {
    const vcf = [
      'BEGIN:VCARD', 'VERSION:3.0', `FN:${IMPORTED.name}`, `EMAIL:${IMPORTED.email}`, 'END:VCARD', '',
    ].join('\r\n');
    // A native file chooser cannot be driven through WebDriver: set the files
    // on the hidden input the way a chooser would and fire its change event.
    const ok = await browser.execute((text) => {
      const input = document.querySelector('[data-testid="contacts-import-input"]');
      if (!input) return false;
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'e2e-contacts.vcf', { type: 'text/vcard' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, vcf);
    assert.equal(ok, true, 'The import input exists');
    await waitShown(tid('contacts-import-result'), 20000);
    await searchList(TAG);
    const id = await rowFor(IMPORTED.name);
    const text = await browser.execute((sel) => document.querySelector(sel).textContent, tid(id));
    assert.ok(text.includes(IMPORTED.email), `Imported row shows its address: ${text}`);
  });

  it('opens the review queue and leaves its contents alone', async () => {
    await clickReachableOrExplain(tid('contacts-review-tab'));
    await waitShown(tid('review-queue'), 15000);
    const rows = await browser.execute(() => document.querySelectorAll('[data-testid^="review-row-"]').length);
    if (rows === 0) {
      assert.equal(await present(tid('review-add-all')), false, 'An empty queue offers no bulk add');
    } else {
      assert.ok(await present(tid('review-add-all')), 'A non-empty queue offers a bulk add');
    }
    await clickReachable(tid('contacts-review-tab'));
    await waitShown(tid('contacts-new'), 10000);
    assert.equal(await present(tid('review-queue')), false, 'The tab toggles back to the people list');
  });

  it('returns to mail with the back button', async () => {
    await clickReachable(tid('contacts-back'));
    await waitFor(async () => !(await present(tid('contacts-view'))), 'Contacts did not close');
    assert.ok(await shown(tid('sidebar')));
    assert.notEqual(await browser.execute(() => document.querySelector('[data-testid="open-contacts"]')?.getAttribute('aria-current')), 'page');
  });
});
