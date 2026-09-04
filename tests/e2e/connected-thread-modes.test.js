/**
 * E2E Test: the three thread modes, driven from the list header
 *
 * `threadMode` decides what a conversation looks like in the list: one row
 * (grouped), one row that unfolds its replies in place (expandable), or no
 * threading at all (flat). The header button cycles them, so the whole feature
 * is reachable without opening Settings — and each mode has a different row
 * shape, which is what this spec asserts.
 *
 * Fixture: FRAGMENTED_SUBJECT. Its conversation is five messages, THREE of them
 * in INBOX (frag-0, frag-2, frag-4 from the partner) and two in Sent (our
 * replies). Expandable mode unfolds a thread's own-folder members only — Sent
 * copies merged in for context are never members (threadRowMembers) — so the
 * fixture must have >= 2 messages in INBOX itself. CROSS_FOLDER_SUBJECT is
 * 1 INBOX + 1 Sent and would unfold to a single member; SENT_THREAD_SUBJECT
 * isn't in INBOX at all.
 *
 * The expected member count is read from the store rather than hardcoded:
 * `sortedEmails` is the INBOX list without the Sent merge, which is exactly the
 * set expandable mode unfolds and flat mode draws as separate rows.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { FRAGMENTED_SUBJECT } from './mockImap.js';

/** What the list is showing, for a failure message worth reading. */
async function visibleRows() {
  return browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0)
    .slice(0, 12)
    .map(r => `${r.getAttribute('data-thread-count') || '1'}× `
      + `${r.closest('[data-testid="thread-member-row"]') ? '(member) ' : ''}`
      + `${(r.textContent || '').trim().slice(0, 50)}`));
}

/** The mode the header button reports, or null when the button isn't there. */
const headerMode = () => browser.execute(() =>
  document.querySelector('[data-testid="thread-mode-toggle"]')?.getAttribute('data-thread-mode') ?? null);

/** Cycle the mode the way a user does. */
async function clickToggle() {
  const clicked = await browser.execute(() => {
    const btn = document.querySelector('[data-testid="thread-mode-toggle"]');
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  });
  expect(clicked).toBe(true);
}

/** Visible rows carrying the fixture's subject, thread rows and members alike. */
const subjectRows = () => browser.execute((subj) =>
  [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj))
    .map(r => ({
      count: Number(r.getAttribute('data-thread-count') || 1),
      member: r.closest('[data-testid="thread-member-row"]') !== null,
    })), FRAGMENTED_SUBJECT);

/** Member rows currently unfolded, and whether each one is the fixture's. */
const memberRows = () => browser.execute((subj) =>
  [...document.querySelectorAll('[data-testid="thread-member-row"]')]
    .filter(r => r.offsetHeight > 0)
    .map(r => ({
      matches: (r.textContent || '').includes(subj),
      uid: r.querySelector('[data-testid="email-row"]')?.getAttribute('data-uid') ?? null,
    })), FRAGMENTED_SUBJECT);

/** The fixture's chevron, with its current aria-expanded (null when absent). */
const disclosure = () => browser.execute((subj) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find(r => r.offsetHeight > 0
      && Number(r.getAttribute('data-thread-count') || 1) > 1
      && (r.textContent || '').includes(subj));
  return row?.querySelector('[data-testid="thread-expand"]')?.getAttribute('aria-expanded') ?? null;
}, FRAGMENTED_SUBJECT);

async function clickDisclosure() {
  const clicked = await browser.execute((subj) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find(r => r.offsetHeight > 0
        && Number(r.getAttribute('data-thread-count') || 1) > 1
        && (r.textContent || '').includes(subj));
    const btn = row?.querySelector('[data-testid="thread-expand"]');
    if (!btn) return false;
    btn.click();
    return true;
  }, FRAGMENTED_SUBJECT);
  expect(clicked).toBe(true);
}

/** Any chevron at all — grouped and flat rows must not grow one. */
const anyDisclosure = () => browser.execute(() =>
  document.querySelectorAll('[data-testid="thread-expand"]').length);

const selectedThread = () => browser.execute(() =>
  window.__MAIL_STORE__?.getState?.().selectedThread ?? null);

/**
 * How many of the conversation's messages live in the folder on screen.
 *
 * `sortedEmails` is the INBOX list before the Sent copies are merged in for
 * threading, so a subject-family count over it is the member count expandable
 * mode should unfold — and the row count flat mode should draw.
 */
const expectedMembers = () => browser.execute((subj) => {
  const norm = (s) => (s || '').replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '').trim().toLowerCase();
  const want = norm(subj);
  return (window.__MAIL_STORE__?.getState?.().sortedEmails || [])
    .filter(e => norm(e.subject) === want).length;
}, FRAGMENTED_SUBJECT);

describe('Thread modes from the list header', function () {
  this.timeout(240_000);

  /** INBOX members of the fixture conversation — read once the list is warm. */
  let expected = 0;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // A spec before this one may have left a thread open, and the chevron
    // assertion below is "selectedThread is still null".
    await browser.execute(() => {
      window.__MAIL_STORE__?.getState?.().closeEmail?.();
      window.__SETTINGS_STORE__?.getState?.().setEmailListGrouping?.('chronological');
      window.__SETTINGS_STORE__?.getState?.().setThreadMode?.('grouped');
    });

    // Threads are built after the list paints and after the Sent headers land,
    // so poll for the grouped row instead of assuming it is already there.
    await browser.waitUntil(
      async () => (await subjectRows()).some(r => r.count > 1),
      {
        timeout: 60_000,
        interval: 1000,
        timeoutMsg: `no thread row for "${FRAGMENTED_SUBJECT}"; list: ${JSON.stringify(await visibleRows())}`,
      },
    );
  });

  it('starts grouped: one row carries the whole conversation', async function () {
    expect(await headerMode()).toBe('grouped');

    const rows = await subjectRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBeGreaterThanOrEqual(2);
    // Nothing to unfold in grouped mode, anywhere in the list.
    expect(await anyDisclosure()).toBe(0);
  });

  it('expandable: the chevron unfolds the INBOX members without opening the thread', async function () {
    await clickToggle();
    await browser.waitUntil(
      async () => (await headerMode()) === 'expandable' && (await disclosure()) === 'false',
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `expandable mode never gave the thread row a folded chevron `
          + `(mode ${await headerMode()}, chevron ${await disclosure()}); list: ${JSON.stringify(await visibleRows())}`,
      },
    );

    expected = await expectedMembers();
    expect(expected).toBeGreaterThanOrEqual(2);

    await clickDisclosure();
    await browser.waitUntil(
      async () => (await memberRows()).length === expected,
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `expected ${expected} member rows, got ${JSON.stringify(await memberRows())}; `
          + `list: ${JSON.stringify(await visibleRows())}`,
      },
    );

    const members = await memberRows();
    // Every unfolded row belongs to this conversation, and is a real message.
    expect(members.every(m => m.matches)).toBe(true);
    expect(members.every(m => m.uid)).toBe(true);
    expect(new Set(members.map(m => m.uid)).size).toBe(expected);
    expect(await disclosure()).toBe('true');
    // Unfolding is not opening: the viewer stays where it was.
    expect(await selectedThread()).toBe(null);

    await clickDisclosure();
    await browser.waitUntil(
      async () => (await memberRows()).length === 0,
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `member rows survived the fold: ${JSON.stringify(await memberRows())}`,
      },
    );
    expect(await disclosure()).toBe('false');
  });

  it('flat: every message is its own row', async function () {
    await clickToggle();
    await browser.waitUntil(
      async () => {
        if ((await headerMode()) !== 'flat') return false;
        const rows = await subjectRows();
        return rows.length === expected && rows.every(r => r.count === 1);
      },
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `flat mode never drew ${expected} single-message rows for "${FRAGMENTED_SUBJECT}" `
          + `(mode ${await headerMode()}, rows ${JSON.stringify(await subjectRows())}); `
          + `list: ${JSON.stringify(await visibleRows())}`,
      },
    );

    // No thread anywhere in the list, so nothing to unfold either.
    const threaded = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="email-row"]')]
        .filter(r => r.offsetHeight > 0 && Number(r.getAttribute('data-thread-count') || 1) > 1).length);
    expect(threaded).toBe(0);
    expect(await anyDisclosure()).toBe(0);
  });

  it('cycles back to grouped', async function () {
    await clickToggle();
    await browser.waitUntil(
      async () => {
        if ((await headerMode()) !== 'grouped') return false;
        const rows = await subjectRows();
        return rows.length === 1 && rows[0].count >= 2;
      },
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `the cycle never came back to one grouped row `
          + `(mode ${await headerMode()}, rows ${JSON.stringify(await subjectRows())})`,
      },
    );
    expect(await anyDisclosure()).toBe(0);
  });

  after(async function () {
    // The setting persists across spec files in one runner session, and every
    // other thread spec assumes grouped.
    await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().setThreadMode?.('grouped'));
  });
});
