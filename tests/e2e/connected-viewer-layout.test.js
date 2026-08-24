/**
 * E2E Test: a long-subject thread must not push the app off its own window
 *
 * Reported against a DMARC aggregate report — a two-message thread whose
 * subject is one ~1200px unbreakable line. Three symptoms, one cause:
 *
 *   1. the message did not fit the screen (its right-hand side was clipped),
 *   2. selecting text slid the whole app sideways with no way back,
 *   3. after that, no email in the list could be selected any more.
 *
 * Cause: the main content row was a flex item with `min-width: auto`, so it
 * refused to shrink below its min-content width. The thread header renders the
 * subject with `truncate` (white-space: nowrap), whose min-content is the whole
 * line — the row inflated to ~1670px inside a 900px window. Its parent clipped
 * that with `overflow: hidden`, which still leaves a *scroll container*: WebKit
 * scrolls one sideways to reveal a selection, and with no scrollbar the offset
 * is permanent, so the list ended up at x = -770 and became unclickable.
 *
 * The fix is `min-w-0` on the row (it fits again) plus `overflow: clip` on the
 * boxes that clip it (it can no longer be scrolled away even if it did not).
 * Both halves are asserted here: the row fits, AND scrolling it is impossible.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { LONG_SUBJECT, LONG_SUBJECT_COUNT } from './mockImap.js';

/** Rows carrying the long-subject conversation. */
async function longSubjectRows() {
  return browser.execute((subj) => [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj))
    .map(r => ({ count: Number(r.getAttribute('data-thread-count') || 1) })), LONG_SUBJECT);
}

/** What the list is showing, for a failure message worth reading. */
async function visibleRows() {
  return browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0)
    .slice(0, 10)
    .map(r => (r.textContent || '').trim().slice(0, 50)));
}

/**
 * Geometry of the app shell: does the row that holds sidebar + list + viewer
 * fit its own window, and are the email rows inside it?
 */
async function shellGeometry() {
  return browser.execute(() => {
    // The row is whatever contains the sidebar — no test-only attribute needed.
    const row = document.querySelector('[data-testid="sidebar"]')?.parentElement;
    const rects = [...document.querySelectorAll('[data-testid="email-row"]')]
      .filter(r => r.offsetHeight > 0)
      .map(r => r.getBoundingClientRect());
    return {
      hasRow: !!row,
      rowScrollWidth: row?.scrollWidth ?? -1,
      rowClientWidth: row?.clientWidth ?? -1,
      rowScrollLeft: row?.scrollLeft ?? -1,
      innerWidth: window.innerWidth,
      rowCount: rects.length,
      leftmost: rects.length ? Math.round(Math.min(...rects.map(r => r.left))) : null,
      rightmost: rects.length ? Math.round(Math.max(...rects.map(r => r.right))) : null,
    };
  });
}

describe('Viewer layout with a long subject', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();

    await browser.waitUntil(
      async () => (await longSubjectRows()).some(r => r.count === LONG_SUBJECT_COUNT),
      {
        timeout: 60_000,
        interval: 1000,
        timeoutMsg: `no ${LONG_SUBJECT_COUNT}-message row for the long subject; `
          + `list: ${JSON.stringify(await visibleRows())}`,
      },
    );

    const opened = await browser.execute((subj) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj));
      if (!row) return false;
      row.click();
      return true;
    }, LONG_SUBJECT);
    expect(opened).toBe(true);

    await browser.waitUntil(
      async () => browser.execute((n) => (document.body.textContent || '').includes(`${n} messages in thread`), LONG_SUBJECT_COUNT),
      {
        timeout: 45_000,
        interval: 500,
        timeoutMsg: `thread header never said "${LONG_SUBJECT_COUNT} messages in thread"`,
      },
    );
  });

  it('keeps the whole shell inside the window', async function () {
    const g = await shellGeometry();
    expect(g.hasRow).toBe(true);
    // The row must not be wider than the window it lives in. Before the fix it
    // was ~1670 against a ~900 client width.
    expect(g.rowScrollWidth).toBeLessThanOrEqual(g.rowClientWidth);
    // And the list is where a user can reach it.
    expect(g.rowCount).toBeGreaterThan(0);
    expect(g.leftmost).toBeGreaterThanOrEqual(0);
    expect(g.rightmost).toBeLessThanOrEqual(g.innerWidth);
  });

  it('renders the thread header subject inside the viewer, not past the window', async function () {
    const header = await browser.execute((subj) => {
      const h = [...document.querySelectorAll('h1')].find(el => (el.textContent || '').includes(subj.slice(0, 40)));
      if (!h) return null;
      const r = h.getBoundingClientRect();
      return { right: Math.round(r.right), innerWidth: window.innerWidth, overflows: h.scrollWidth > h.clientWidth };
    }, LONG_SUBJECT);
    expect(header).not.toBe(null);
    // Truncated inside its own box (that is what the ellipsis is for), but the
    // box itself ends inside the window.
    expect(header.right).toBeLessThanOrEqual(header.innerWidth);
  });

  it('cannot be scrolled sideways into a state the user cannot undo', async function () {
    // Drive the exact mechanism WebKit uses when a text selection reaches the
    // edge of a clipping box: scroll every ancestor, and the truncating subject
    // elements, as far right as they will go.
    const scrolled = await browser.execute(() => {
      const targets = [];
      const row = document.querySelector('[data-testid="email-row"]');
      for (let el = row; el && el !== document.documentElement; el = el.parentElement) targets.push(el);
      targets.push(...document.querySelectorAll('.truncate'));
      targets.push(document.documentElement, document.body);

      const moved = [];
      for (const el of targets) {
        el.scrollLeft = 99_999;
        if (el.scrollLeft > 0) {
          moved.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 60), scrollLeft: el.scrollLeft });
        }
      }
      return moved;
    });
    // Nothing between an email row and the document may hold a horizontal
    // scroll offset — there is no scrollbar anywhere to undo one.
    expect(scrolled).toEqual([]);

    const g = await shellGeometry();
    expect(g.rowScrollLeft).toBe(0);
    expect(g.leftmost).toBeGreaterThanOrEqual(0);
    expect(g.rightmost).toBeLessThanOrEqual(g.innerWidth);
  });

  it('still lets another email be selected afterwards', async function () {
    const target = await browser.execute((subj) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .filter(r => r.offsetHeight > 0)
        .find(r => !(r.textContent || '').includes(subj));
      if (!row) return null;
      const rect = row.getBoundingClientRect();
      // A row the user could actually hit: on screen, and where it appears.
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const reachable = !!hit && row.contains(hit);
      row.click();
      return { reachable, text: (row.textContent || '').trim().slice(0, 60) };
    }, LONG_SUBJECT);
    expect(target).not.toBe(null);
    expect(target.reachable).toBe(true);

    // The viewer moves off the long-subject thread.
    await browser.waitUntil(
      async () => browser.execute((subj) => ![...document.querySelectorAll('h1')]
        .some(h => (h.textContent || '').includes(subj.slice(0, 40))), LONG_SUBJECT),
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `viewer still showed the long-subject thread after clicking "${target.text}"`,
      },
    );
  });
});
