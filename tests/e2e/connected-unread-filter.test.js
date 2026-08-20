/**
 * E2E Test: the unread-only filter in the message list header.
 *
 * The mock IMAP fixture makes odd UIDs unread and even UIDs read
 * (tests/e2e/mockImap.js `mailbox`), so a warm INBOX always renders both kinds
 * of row. `bg-mail-surface` on the row root is the unread marker — EmailRow
 * and ThreadRow both paint it, and both render under the same testid.
 *
 * What this exists to catch: a filter wired to the header button but not to
 * the virtualizer's row source (or vice versa) — the list would keep drawing
 * read mail with the button lit, which is the one failure mode that reads as
 * "the app is showing me messages I filtered out".
 */

import { waitForApp, waitForEmails } from './helpers.js';

describe('Unread-only filter', function () {
  this.timeout(120_000);

  const rowStates = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')]
      .map(row => row.classList.contains('bg-mail-surface')));

  const countRows = async () => {
    const states = await rowStates();
    return { total: states.length, unread: states.filter(Boolean).length };
  };

  const headerCount = () => browser.execute(() =>
    document.querySelector('[data-testid="email-list-count"]')?.textContent?.trim() || '');

  const toggle = () => browser.execute(() => {
    const btn = document.querySelector('[data-testid="unread-filter-toggle"]');
    if (!btn) return false;
    btn.click();
    return true;
  });

  const filterIsOn = () => browser.execute(() =>
    document.querySelector('[data-testid="unread-filter-toggle"]')?.getAttribute('aria-pressed') === 'true');

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('starts off, with read and unread mail both on screen', async function () {
    expect(await filterIsOn()).toBe(false);

    const { total, unread } = await countRows();
    expect(total).toBeGreaterThan(1);
    // Both kinds present — without this the next test could pass on a window
    // that never held a read row to begin with.
    expect(unread).toBeGreaterThan(0);
    expect(unread).toBeLessThan(total);
  });

  it('hides read mail when switched on', async function () {
    expect(await toggle()).toBe(true);

    await browser.waitUntil(async () => {
      const { total, unread } = await countRows();
      return total > 0 && unread === total;
    }, {
      timeout: 20_000,
      interval: 300,
      timeoutMsg: `Read rows still rendered with the filter on (last: ${JSON.stringify(await countRows())})`,
    });

    expect(await filterIsOn()).toBe(true);
  });

  it('says the list is counting unread, not the whole window', async function () {
    await browser.waitUntil(async () => /unread/.test(await headerCount()), {
      timeout: 20_000,
      interval: 300,
      timeoutMsg: `Header never mentioned unread (last: "${await headerCount()}")`,
    });

    const text = await headerCount();
    expect(text).toMatch(/^[\d,]+ unread( of [\d,]+ loaded)?$/);
    // The header counts the whole filtered list; the DOM holds one virtualized
    // window of it, so the header can only ever be the larger of the two.
    const shown = Number(text.split(' ')[0].replace(/,/g, ''));
    const rendered = (await countRows()).unread;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeGreaterThanOrEqual(rendered);
  });

  it('brings read mail back when switched off', async function () {
    expect(await toggle()).toBe(true);

    await browser.waitUntil(async () => {
      const { total, unread } = await countRows();
      return total > 0 && unread < total;
    }, {
      timeout: 20_000,
      interval: 300,
      timeoutMsg: `Read rows never came back (last: ${JSON.stringify(await countRows())})`,
    });

    expect(await filterIsOn()).toBe(false);
    expect(await headerCount()).toMatch(/emails$/);
  });
});
