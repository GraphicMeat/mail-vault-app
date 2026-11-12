/**
 * The three Contacts screens, driven through the real UI and photographed:
 * This email, All senders, Favorites. English only; run by
 * `SHOTS_SPEC=contacts npx wdio run wdio.screenshots.conf.js` (see
 * .harness/capture.sh).
 *
 * Every stop asserts its screen before `capture`, and a failed assertion fails
 * the run: a shot of the onboarding screen or of the wrong tab is worse than
 * none. The flow talks to testids only, never to store internals.
 */

import assert from 'node:assert/strict';
import { waitForApp, waitForEmails } from '../../tests/e2e/helpers.js';
import { clickReachable, dismissOnboardingNotice } from '../../tests/e2e/insightsHelpers.js';
import { capture } from './capture.js';
import { raiseWindow } from './window.js';
import { makeLabels } from './labels.js';

const L = makeLabels('en');
const THEO = 'theo@skewer.systems';
const PRESS_SLOT = 'Press slot Friday 06:00';

const tid = (id) => `[data-testid="${id}"]`;
const countOf = (selector) => browser.execute((sel) => document.querySelectorAll(sel).length, selector);

async function waitFor(condition, message, timeout = 20000) {
  await browser.waitUntil(condition, { timeout, interval: 150, timeoutMsg: message });
}

const waitShown = (selector, timeout) => waitFor(() => browser.execute((sel) => {
  const node = document.querySelector(sel);
  return !!node && node.getBoundingClientRect().height > 0;
}, selector), `Never displayed: ${selector}`, timeout);

/** React-controlled input: native setter plus an input event. */
async function fill(selector, value) {
  await waitShown(selector);
  await browser.execute((sel, next) => {
    const node = document.querySelector(sel);
    node.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, next);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, value);
}

const attrOf = (selector, name) => browser.execute((sel, attr) => document.querySelector(sel)?.getAttribute(attr) ?? null, selector, name);
const textOf = (selector) => browser.execute((sel) => document.querySelector(sel)?.textContent ?? '', selector);

async function openMessage(needle) {
  // The unified inbox fills account by account: the row may land a moment after the first ones.
  await waitFor(() => browser.execute((n) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => (r.innerText || '').includes(n));
    if (!row) return false;
    row.scrollIntoView({ behavior: 'instant', block: 'center' });
    row.click();
    return true;
  }, needle), `INBOX row "${needle}" was never listed`, 40000);
  await waitFor(() => browser.execute((placeholder) => !document.body.innerText.includes(placeholder), L('viewer.selectEmailRead')),
    'The reader never opened the message');
  // The list row carries headers only; This email counts the full message's To and Cc.
  await waitFor(() => browser.execute(() => !document.querySelector('[data-testid="email-viewer-loading"]')), 'The reader never finished loading the message');
  await browser.pause(1500);
}

/** Visible tab labels, for a failure message that says what was on screen. */
const tabsOnScreen = () => browser.execute(() => [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent).join(' | '));

describe('Contacts shots', function () {
  this.timeout(300000);

  before(async () => {
    assert.equal(await waitForApp(), 'ready', 'Contacts shots need the seeded accounts, not the onboarding screen');
    await waitForEmails();
    await raiseWindow(1440, 900);
    await dismissOnboardingNotice();
  });

  it('This email lists the sender and recipients of the open message', async () => {
    await openMessage(PRESS_SLOT);
    await clickReachable(tid('open-contacts'));
    await waitShown(tid('contacts-view'), 30000);
    await waitFor(async () => (await textOf(tid('contacts-tab-email'))).endsWith('(4)'), 'This email tab never counted 4 people').catch(async (error) => {
      throw new Error(`${error.message}; tabs: ${await tabsOnScreen()}`);
    });
    assert.equal(await attrOf(tid('contacts-tab-email'), 'aria-selected'), 'true');
    const headings = await browser.execute(() => [...document.querySelectorAll('[data-testid="email-people"] h3')].map((h) => h.textContent));
    assert.deepEqual(headings, [L('common.from'), L('common.to'), L('contacts.role.cc')]);
    await waitFor(async () => (await attrOf(tid(`email-person-${THEO}`), 'aria-current')) === 'true', 'Theo was not preselected');
    await waitShown(tid('sender-card'));
    await waitFor(async () => (await countOf('[data-testid^="mail-row-"]')) >= 1, 'Theo shows no emails');
    capture('contacts-this-email');
  });

  it('All senders finds senders of every account and opens one', async () => {
    await clickReachable(tid('contacts-tab-senders'));
    await waitShown(tid(`sender-row-${THEO}`));
    const finds = { ledger: 'statements@butchersledger.co', ida: 'ida.marsh@fastmail.example' };
    for (const [text, address] of Object.entries(finds)) {
      await fill(tid('senders-search'), text);
      await waitShown(tid(`sender-row-${address}`));
    }
    await fill(tid('senders-search'), '');
    await waitShown(tid(`sender-row-${THEO}`));
    await clickReachable(tid(`sender-row-${THEO}`));
    for (const id of ['sender-card', 'sender-favorite', 'sender-save', 'contact-email', 'contact-copy']) await waitShown(tid(id));
    await waitFor(async () => (await countOf('[data-testid^="mail-row-"]')) >= 2, 'Theo shows fewer than 2 emails').catch(async (error) => {
      const state = await browser.execute(() => ({
        rows: document.querySelectorAll('[data-testid^="mail-row-"]').length,
        received: document.querySelector('[data-testid="stat-received"]')?.textContent,
        card: document.querySelector('[data-testid="sender-card"]')?.innerText.replace(/\s+/g, ' ').slice(0, 300),
      }));
      throw new Error(`${error.message}: ${JSON.stringify(state)}`);
    });
    assert.equal(await countOf(`${tid(`sender-row-${THEO}`)} ${tid('row-saved')}`), 0, 'Theo is not a saved contact yet');
    capture('contacts-all-senders');
  });

  it('Favorite saves the sender and lists them under Favorites', async () => {
    await clickReachable(tid('sender-favorite'));
    await waitShown(tid('person-card'));
    await waitFor(async () => (await attrOf(tid('toggle-vip'), 'aria-pressed')) === 'true', 'The favorite toggle never turned on');
    await clickReachable(tid('contacts-tab-favorites'));
    await waitFor(() => browser.execute(() => [...document.querySelectorAll('[data-testid^="contact-row-"]')]
      .some((row) => row.textContent.includes('Theo Lomas') && row.querySelector('[data-testid="row-favorite"]'))),
    'Favorites never listed Theo Lomas with a star');
    await waitShown(tid('person-mail'));
    await waitShown(tid('contact-actions'));
    capture('contacts-favorites');
  });
});
