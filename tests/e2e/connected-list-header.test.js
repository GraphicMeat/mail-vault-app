/**
 * E2E Test: Message list header count
 *
 * The header used to render the server-reported mailbox total unconditionally,
 * so a list that was still filling looked identical to a finished one — which is
 * how "15,067 emails" sat above a few hundred rows. It now reads
 * "N of M emails" until the window covers the mailbox.
 *
 * Account 1 (40 messages) is always fully loaded, so it covers the "no of"
 * case; account 2 has a 700-message INBOX (wdio.conf.js), larger than both load
 * windows — the 500 painted from cache and the 200 paged off the server — so it
 * is genuinely partial until something scrolls the list.
 */

import { waitForApp, waitForEmails } from './helpers.js';

const FULL = /^([\d,]+) emails$/;
const PARTIAL = /^([\d,]+) of ([\d,]+) emails$/;

const num = (s) => parseInt(s.replace(/,/g, ''), 10);

async function readCount() {
  return browser.execute(() => {
    const el = document.querySelector('[data-testid="email-list-count"]');
    return el ? el.textContent.trim() : null;
  });
}

async function clickAccountByEmail(email) {
  return browser.execute((target) => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    if (!sidebar) return false;
    for (const el of sidebar.querySelectorAll('div, span, button')) {
      if ((el.textContent || '').trim() !== target) continue;
      const row = el.closest('[class*="cursor-pointer"]') || el.closest('button');
      if (row && row.offsetHeight > 0) { row.click(); return true; }
    }
    return false;
  }, email);
}

/** Drive the virtualized list to its end — this is what triggers the cache drain. */
async function scrollToEnd() {
  await browser.execute(() => {
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });
}

describe('Message List Header Count', function () {
  this.timeout(180_000);

  let bigInbox;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    bigInbox = browser.mockInboxSizes?.[1] || 700;
  });

  it('shows a bare total once the whole mailbox is loaded', async function () {
    // Account 1 holds 40 messages — one page, so the window always covers it.
    await browser.waitUntil(async () => FULL.test((await readCount()) || ''), {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: `Header never settled to a bare total (last: ${await readCount()})`,
    });

    const text = await readCount();
    expect(text).toMatch(FULL);
    expect(num(text.match(FULL)[1])).toBeGreaterThan(0);
    // The whole point: a fully loaded list must not say "40 of 40".
    expect(text).not.toContain(' of ');
  });

  it('shows "N of M" while a large mailbox is still loading', async function () {
    const clicked = await clickAccountByEmail(browser.testEnv.TEST_EMAIL2);
    expect(clicked).toBe(true);

    // Sample the header through the load. One partial reading is the assertion;
    // the sample count is the positive control — a spec that never sampled must
    // fail rather than pass vacuously.
    const samples = [];
    let partial = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const text = await readCount();
      if (text) {
        samples.push(text);
        const m = text.match(PARTIAL);
        if (m && num(m[2]) === bigInbox) { partial = m; break; }
      }
      await browser.pause(100);
    }

    expect(samples.length).toBeGreaterThan(5);
    // expect() takes exactly one argument — the sample trail goes in the log.
    if (!partial) console.log('[list-header] samples:', samples.slice(-10).join(' | '));
    expect(partial).not.toBe(null);
    expect(num(partial[1])).toBeLessThan(bigInbox);
    expect(num(partial[2])).toBe(bigInbox);
  });

  it('drops the "of" once scrolling has pulled the whole mailbox in', async function () {
    await browser.waitUntil(async () => {
      await scrollToEnd();
      const text = (await readCount()) || '';
      const m = text.match(FULL);
      return !!m && num(m[1]) === bigInbox;
    }, {
      timeout: 120_000,
      interval: 1000,
      timeoutMsg: `Header never reached "${bigInbox} emails" (last: ${await readCount()})`,
    });

    const text = await readCount();
    expect(text).not.toContain(' of ');
    expect(num(text.match(FULL)[1])).toBe(bigInbox);
  });
});
