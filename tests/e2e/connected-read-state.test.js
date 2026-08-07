/**
 * E2E Test: read state round trip in the email viewer
 *
 * The regression this exists for: the viewer's toggle-read button read its
 * label off `selectedEmail`, and reopening an email served it from the
 * in-memory body cache — flags frozen at fetch time, and no mark-as-read on
 * that path. Mark an email unread, open it again, and the bar still offered
 * "Mark read" for a message the rest of the app already showed as read.
 *
 * Covers, in order: opening marks read (delay mode), marking unread closes the
 * viewer and repaints the row, and reopening the *cached* email marks it read
 * again so the bar offers the next action.
 *
 * Action-bar buttons are icon-only, so they are addressed by title.
 */

import { waitForApp, waitForEmails } from './helpers.js';

describe('Email read state', function () {
  this.timeout(120_000);

  const SUBJECT_RE = String.raw`(?:Luke|Vader|Mock|Archived|Sent) message \d+`;

  // Rows are virtualized and recycled — the subject is the only stable handle.
  // `bg-mail-surface` on the row root is the unread marker.
  const rows = () => browser.execute((re) => {
    const pattern = new RegExp(re);
    return [...document.querySelectorAll('[data-testid="email-row"]')].map(row => ({
      subject: ((row.innerText || '').match(pattern) || [null])[0],
      unread: row.classList.contains('bg-mail-surface'),
    })).filter(r => r.subject);
  }, SUBJECT_RE);

  const rowFor = async (subject) => (await rows()).find(r => r.subject === subject);

  const clickRow = (subject) => browser.execute((needle, re) => {
    const pattern = new RegExp(re);
    for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
      if (((row.innerText || '').match(pattern) || [null])[0] !== needle) continue;
      row.click();
      return true;
    }
    return false;
  }, subject, SUBJECT_RE);

  const clickButton = (title) => browser.execute((t) => {
    const btn = document.querySelector(`button[title="${t}"]`);
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  }, title);

  const hasButton = (title) => browser.execute((t) => {
    const btn = document.querySelector(`button[title="${t}"]`);
    return btn !== null && btn.offsetHeight > 0;
  }, title);

  const waitForButton = (title, msg) => browser.waitUntil(
    async () => hasButton(title),
    { timeout: 20_000, interval: 300, timeoutMsg: msg },
  );

  const waitForRow = (subject, predicate, msg) => browser.waitUntil(
    async () => {
      const row = await rowFor(subject);
      return row ? predicate(row) : false;
    },
    { timeout: 20_000, interval: 300, timeoutMsg: msg },
  );

  // A thread row opens ThreadView, which has no toggle-read button. Walk the
  // list until a row opens the single-email viewer.
  let subject;

  before(async function () {
    await waitForApp();
    await waitForEmails();

    for (const candidate of (await rows()).map(r => r.subject).slice(0, 8)) {
      await clickRow(candidate);
      await browser.pause(1500);
      if (await hasButton('Mark unread') || await hasButton('Mark read')) {
        subject = candidate;
        return;
      }
    }
    throw new Error('No row opened the single-email viewer');
  });

  it('marks an opened email read and offers "Mark unread" next', async function () {
    await clickRow(subject);

    // Default markAsReadMode is 'delay' (3s), so the flip is not immediate.
    await waitForButton('Mark unread', `Opened "${subject}" never flipped to read`);
    await waitForRow(subject, r => !r.unread, `Row "${subject}" kept its unread styling after being opened`);
  });

  it('closes the viewer when the email is marked unread', async function () {
    expect(await clickButton('Mark unread')).toBe(true);

    await browser.waitUntil(
      async () => browser.execute(() =>
        document.querySelector('button[title="Reply"]') === null
        && document.body.innerText.includes('Select an email to read')),
      { timeout: 15_000, interval: 300, timeoutMsg: 'Viewer stayed open after Mark unread' },
    );
    await waitForRow(subject, r => r.unread, `Row "${subject}" never returned to unread styling`);
  });

  it('reopens the cached email, marks it read again, and offers "Mark unread"', async function () {
    await clickRow(subject);

    // The body now comes from the in-memory cache. Its flags used to be the
    // ones it was cached with, and this path skipped mark-as-read entirely, so
    // the bar stayed on "Mark read" forever. (That the *intermediate* state
    // reads unread is asserted in the unit suite — racing a 3s timer here
    // would only buy a flake.)
    await waitForButton('Mark unread', `Reopened "${subject}" was never marked read again`);
    await waitForRow(subject, r => !r.unread, `Row "${subject}" stayed unread after being reopened`);
  });
});
