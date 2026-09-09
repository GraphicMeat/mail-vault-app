/**
 * E2E Test: the three thread modes, driven from the list header
 *
 * `threadMode` decides what a conversation looks like in the list: one row
 * (grouped), one row that unfolds its replies in place (expandable), or no
 * threading at all (flat). The list toolbar's selector offers them, so the whole feature
 * is reachable without opening Settings — and each mode has a different row
 * shape, which is what this spec asserts.
 *
 * Fixture: FRAGMENTED_SUBJECT. Its conversation is five messages, THREE of them
 * in INBOX (frag-0, frag-2, frag-4 from the partner) and two in Sent (our
 * replies). Expandable mode unfolds the whole conversation, the Sent replies
 * the INBOX list merges in included — the thread row's checkbox and menu still
 * act on the INBOX members only (threadRowMembers). Flat mode draws the folder
 * itself, so there the Sent copies are absent. SENT_THREAD_SUBJECT isn't in
 * INBOX at all.
 *
 * Both counts are read from the store rather than hardcoded: `getChatEmails()`
 * is the merged list expandable mode unfolds, `sortedEmails` the INBOX list
 * flat mode draws as separate rows.
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

/** The mode the toolbar selector reports, or null when it isn't there. */
const headerMode = () => browser.execute(() =>
  document.querySelector('[data-testid="thread-mode-toggle"]')?.getAttribute('data-thread-mode') ?? null);

/** Select a mode using the real toolbar control. */
async function selectMode(mode) {
  const clicked = await browser.execute(value => {
    const select = document.querySelector('[data-testid="thread-mode-toggle"]');
    if (!select || select.offsetHeight === 0) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value === value;
  }, mode);
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
 * The conversation's uids as the store holds them, sorted. `merged` is
 * `getChatEmails()` — INBOX with the Sent copies merged in for threading, the
 * set expandable mode unfolds. `sortedEmails` is the INBOX list alone, the
 * rows flat mode draws. Uids, not a count: a Sent copy can share its uid with
 * an INBOX message, so the unfolded rows are matched as a multiset.
 */
const conversationUids = (merged) => browser.execute((subj, fromChat) => {
  const norm = (s) => (s || '').replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '').trim().toLowerCase();
  const want = norm(subj);
  const state = window.__MAIL_STORE__?.getState?.();
  const list = (fromChat ? state?.getChatEmails?.() : state?.sortedEmails) || [];
  return list.filter(e => norm(e.subject) === want).map(e => String(e.uid)).sort();
}, FRAGMENTED_SUBJECT, merged);

describe('Thread modes from the list header', function () {
  this.timeout(240_000);

  /** INBOX rows of the fixture conversation — read once the list is warm. */
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

  it('expandable: the chevron unfolds the whole conversation without opening the thread', async function () {
    await selectMode('expandable');
    await browser.waitUntil(
      async () => (await headerMode()) === 'expandable' && (await disclosure()) === 'false',
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `expandable mode never gave the thread row a folded chevron `
          + `(mode ${await headerMode()}, chevron ${await disclosure()}); list: ${JSON.stringify(await visibleRows())}`,
      },
    );

    expected = (await conversationUids(false)).length;
    expect(expected).toBeGreaterThanOrEqual(2);
    // The Sent replies are merged in, so the unfolded set is larger than the
    // folder's own — once they have landed. `before` only waited for the INBOX
    // rows; loadSentHeaders waits for the real folder list before it fetches
    // Sent, so at this point the store can still hold the INBOX placeholder,
    // no Sent path and zero Sent headers (seen 4 runs out of 6 on the mini).
    // Assert after the merge, not before it.
    await browser.waitUntil(
      async () => (await conversationUids(true)).length > expected,
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `the Sent replies never merged into the conversation `
          + `(INBOX ${expected}, merged ${(await conversationUids(true)).length})`,
      },
    );
    const whole = await conversationUids(true);
    expect(whole.length).toBeGreaterThan(expected);

    await clickDisclosure();
    await browser.waitUntil(
      async () => (await memberRows()).length === whole.length,
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `expected ${whole.length} member rows, got ${JSON.stringify(await memberRows())}; `
          + `list: ${JSON.stringify(await visibleRows())}`,
      },
    );

    const members = await memberRows();
    // Every unfolded row belongs to this conversation, and is a real message.
    expect(members.every(m => m.matches)).toBe(true);
    expect(members.every(m => m.uid)).toBe(true);
    expect(members.map(m => m.uid).sort()).toEqual(whole);
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
    await selectMode('flat');
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

  it('switches back to grouped', async function () {
    await selectMode('grouped');
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
