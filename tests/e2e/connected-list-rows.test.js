/**
 * E2E Test: what a list row shows and how it looks
 *
 * Three defects, one fixture (luke's INBOX, two same-sender same-subject
 * messages whose subject is partly RFC 2047 encoded — see mockImap.js):
 *
 *   1. IMAP quoted-string escapes leaked into the subject, so the list drew
 *      `\"Iliustruotoji istorija\"`.
 *   2. Sender-grouped topic rows were keyed by subject, and one sender's two
 *      same-subject threads collided on one key — the virtualizer's per-key
 *      size cache then stacked the rows on top of each other.
 *   3. Selection was a 2px left border and nothing else, invisible next to an
 *      unread row's own background.
 *
 * jsdom cannot answer any of these: (1) needs the real IMAP wire, (2) needs the
 * real @tanstack/react-virtual (the unit mock keys rows by index), and (3) is a
 * computed background colour.
 */

import { waitForApp, waitForEmails, visibleRowSubjects } from './helpers.js';
import { QUOTED_SUBJECT, QUOTED_SUBJECT_SENDER_NAME, QUOTED_SUBJECT_COUNT } from './mockImap.js';

const activate = (id) => browser.execute((accountId) => {
  window.__MAIL_STORE__.getState().activateAccount(accountId, 'INBOX');
}, id);

const activeAccountId = () => browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId);

/**
 * Scroll the list until a row whose text holds `needle` is rendered. The list
 * is virtualized and the fixture sits below the thread fixtures, so "not on
 * screen yet" is not "not there".
 */
async function scrollToRow(needle) {
  for (let i = 0; i < 20; i++) {
    const found = await browser.execute((s) => [...document.querySelectorAll('[data-testid="email-row"]')]
      .some((r) => (r.textContent || '').includes(s)), needle);
    if (found) return true;
    await browser.execute(() => {
      const rows = document.querySelectorAll('[data-testid="email-row"]');
      const scroller = rows[0]?.closest('[class*="overflow-y-auto"], [style*="overflow"]')
        || document.querySelector('[data-testid="email-list-scroll"]');
      if (scroller) scroller.scrollTop += 400;
    });
    await browser.pause(250);
  }
  return false;
}

const clickButtonByTitle = (title) => browser.execute((t) => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === t);
  if (!btn || btn.offsetHeight === 0) return false;
  btn.click();
  return true;
}, title);

describe('List rows: subject text, sender grouping, selection', function () {
  this.timeout(180_000);

  let luke;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // The accent tint below is one of TWO highlighting modes now, and every
    // spec file shares one HOME (wdio.conf.js) - a concurrent spec that puts
    // the app in the marking mode would leave this asserting the wrong ground.
    // Pin what this file depends on instead of inheriting the default.
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ emailRowHighlight: 'hover' }));
    luke = browser.mockAccounts[0];
    await activate(luke.id);
    await browser.waitUntil(async () => (await activeAccountId()) === luke.id, {
      timeout: 60_000, interval: 500, timeoutMsg: 'never landed on luke',
    });
    await browser.waitUntil(
      () => browser.execute((s) => (window.__MAIL_STORE__.getState().emails || [])
        .some((e) => (e.subject || '').includes(s)), 'Iliustruotoji'),
      { timeout: 60_000, interval: 500, timeoutMsg: "luke's INBOX never loaded the quoted-subject fixture" },
    );
  });

  // Leave the list the way the rest of the suite expects to find it.
  after(async function () {
    await clickButtonByTitle('Switch to chronological view');
    await browser.pause(500);
  });

  it('shows the subject without the IMAP quoted-string backslashes', async function () {
    expect(await scrollToRow('Iliustruotoji')).toBe(true);
    const rows = await visibleRowSubjects();
    const hit = rows.find((r) => r.includes('Iliustruotoji'));
    expect(hit).toBeDefined();
    // Exactly the decoded header, quotes and all.
    expect(hit).toContain(QUOTED_SUBJECT);
    // And no row anywhere is carrying an escape.
    expect(rows.some((r) => r.includes('\\"'))).toBe(false);
  });

  it('paints the open message with the accent tint', async function () {
    const before = await browser.execute(() => {
      const rows = [...document.querySelectorAll('[data-testid="email-row"]')];
      return rows.map((r) => getComputedStyle(r).backgroundColor);
    });
    expect(before.length).toBeGreaterThan(1);

    await browser.execute(() => document.querySelector('[data-testid="email-row"]').click());
    await browser.pause(600);

    const after = await browser.execute(() => {
      const rows = [...document.querySelectorAll('[data-testid="email-row"]')];
      // Resolve the token through a throwaway element so the comparison is
      // rgb-string vs rgb-string, whatever the theme.
      const probe = document.createElement('div');
      probe.style.backgroundColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--mail-accent-tint').trim();
      document.body.appendChild(probe);
      const tint = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        tint,
        selected: getComputedStyle(rows[0]).backgroundColor,
        sibling: getComputedStyle(rows[1]).backgroundColor,
      };
    });

    expect(after.selected).toBe(after.tint);
    expect(after.selected).not.toBe(after.sibling);
  });

  it('gives one sender two topic rows for two same-subject threads, at two offsets', async function () {
    expect(await clickButtonByTitle('Group by sender')).toBe(true);
    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll('[data-testid="sender-group-row"]').length > 0),
      { timeout: 30_000, interval: 300, timeoutMsg: 'the sender-grouped list never rendered' },
    );

    const opened = await browser.waitUntil(async () => browser.execute((s) => {
      const row = [...document.querySelectorAll('[data-testid="sender-group-row"]')]
        .find((r) => (r.textContent || '').includes(s));
      if (!row || row.offsetHeight === 0) return false;
      row.click();
      return true;
    }, QUOTED_SUBJECT_SENDER_NAME), {
      timeout: 30_000, interval: 500,
      timeoutMsg: `no sender group row for "${QUOTED_SUBJECT_SENDER_NAME}"`,
    });
    expect(opened).toBe(true);
    await browser.pause(600);

    const topics = await browser.execute((s) => [...document.querySelectorAll('[data-testid="sender-topic-row"]')]
      .filter((r) => (r.textContent || '').includes(s))
      .map((r) => Math.round(r.parentElement.getBoundingClientRect().top)), 'Iliustruotoji');

    // Two threads, two rows, two offsets.
    expect(topics.length).toBe(QUOTED_SUBJECT_COUNT);
    expect(new Set(topics).size).toBe(QUOTED_SUBJECT_COUNT);

    // The collision itself, made visible: `expandedTopics` is keyed by the same
    // string, so with one key for both threads, unfolding either one unfolds
    // BOTH and the list grows by two messages instead of one.
    expect(await browser.execute((s) => {
      const row = [...document.querySelectorAll('[data-testid="sender-topic-row"]')]
        .find((r) => (r.textContent || '').includes(s));
      if (!row) return false;
      row.click();
      return true;
    }, 'Iliustruotoji')).toBe(true);
    await browser.pause(600);

    const opened_rows = await browser.execute(() =>
      document.querySelectorAll('[data-testid="sender-email-row"]').length);
    expect(opened_rows).toBe(1);
  });
});
