/**
 * E2E: the three ways into a reply — the open message's header, a message
 * inside a thread, and the row's 3-dot menu.
 *
 * The header row used to fold the details; the chevron beside it was
 * decoration. Now a click on the row replies to THAT message and the chevron
 * is the only fold control, in the single viewer and on every message in a
 * thread. The row menu gained the same reach without the list ever holding a
 * compose prop: Reply (body resolved first, so the quote is the message) and
 * "New message to <sender>".
 *
 * Harness facts these lean on:
 *  - framer-motion exits never finish under the occluded runner window, so
 *    every case asserts the state it moved to, never an animation's end.
 *  - Only plain data crosses into `browser.execute` — the app's CSP has no
 *    `unsafe-eval`, so a rebuilt callback is refused.
 *  - `expect(value, 'message')` throws in this runner: one argument only.
 *  - Each spec file starts on a wiped data dir (wdio.conf.js beforeSession),
 *    so account 0's INBOX is what is on screen when `before` returns.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { CROSS_FOLDER_SUBJECT, CROSS_FOLDER_INBOX_BODY } from './mockImap.js';
import {
  closeComposeHard,
  fieldValue,
  modalOpen,
  modalCount,
  testidPresent,
  testidText,
} from './composeHelpers.js';

// The single message this spec replies to — account 0's INBOX, no thread.
const SUBJECT = 'Luke message 40';
const SENDER = 'sender40@example.com';
const SENDER_NAME = 'Sender 40';
const BODY = 'Body of luke message 40';

// ── what the page can be asked (plain data out, plain data in) ───────────────

/** What the list is showing — for failure messages worth reading. */
const visibleRows = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0)
    .slice(0, 12)
    .map(r => `${r.getAttribute('data-thread-count') || '1'}× ${(r.textContent || '').trim().slice(0, 60)}`));

/** The subject the viewer currently holds — the honest "is it open" answer. */
const selectedSubject = () => browser.execute(() =>
  window.__MAIL_STORE__?.getState?.().selectedEmail?.subject ?? null);

/** The single viewer's sender row and the state its chevron advertises. */
const senderHeader = () => browser.execute(() => {
  const row = document.querySelector('[data-testid="sender-header"]');
  if (!row) return null;
  const btn = row.querySelector('[data-testid="header-toggle"]');
  return {
    visible: row.offsetHeight > 0,
    text: (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    expanded: btn ? btn.getAttribute('aria-expanded') : null,
    label: btn ? btn.getAttribute('aria-label') : null,
  };
});

/**
 * Every message in the open thread: whether it is still folded (no body, no
 * iframe, no spinner under its header) and what its header line reads —
 * which, folded, is the snippet of its own loaded body.
 */
const threadHeaders = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="thread-email-header"]')].map(h => ({
    folded: !h.parentElement.querySelector('.email-content, iframe, .animate-spin'),
    text: (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
  })));

/** The rendered body of the thread message at `index`, or null while folded. */
const threadBodyAt = (index) => browser.execute((i) => {
  const h = document.querySelectorAll('[data-testid="thread-email-header"]')[i];
  const body = h?.parentElement.querySelector('.email-content');
  return body ? (body.textContent || '').replace(/\s+/g, ' ').trim() : null;
}, index);

/** Click an element by data-testid — the chevron and the quoted toggle are plain buttons. */
async function clickTestid(testid, scopeIndex = null) {
  const ok = await browser.execute((id, i) => {
    const el = i === null
      ? document.querySelector(`[data-testid="${id}"]`)
      : document.querySelectorAll('[data-testid="thread-email-header"]')[i]?.querySelector(`[data-testid="${id}"]`);
    if (!el || el.offsetHeight === 0) return false;
    el.click();
    return true;
  }, testid, scopeIndex);
  await browser.pause(250);
  return ok;
}

const menuIsOpen = () => browser.execute(() => !!document.querySelector('[role="menu"]'));

const menuLabels = () => browser.execute(() =>
  [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(el => (el.textContent || '').trim()));

const clickMenuItem = (label) => browser.execute((needle) => {
  for (const el of document.querySelectorAll('[role="menu"] [role="menuitem"]')) {
    if ((el.textContent || '').trim() === needle) { el.click(); return true; }
  }
  return false;
}, label);

/**
 * `browser.waitUntil` whose failure names what never happened AND what the
 * page said on the LAST poll. A message built before the wait starts prints
 * an empty page and teaches the next reader nothing.
 */
async function waitFor(probe, ok, what, timeout = 30_000, interval = 500) {
  let last = null;
  try {
    await browser.waitUntil(
      async () => { last = await probe(); return ok(last); },
      { timeout, interval, timeoutMsg: what },
    );
  } catch (err) {
    throw new Error(`${what} — last seen: ${JSON.stringify(last)} (${err.message})`);
  }
  return last;
}

/** Open the plain (non-thread) row carrying `subject` in the reading pane. */
async function openSingleRow(subject) {
  await waitFor(
    async () => {
      const clicked = await browser.execute((subj) => {
        const rows = [...document.querySelectorAll('[data-testid="email-row"]')].filter(r => r.offsetHeight > 0);
        const row = rows.find(r => Number(r.getAttribute('data-thread-count') || 1) === 1
          && (r.textContent || '').includes(subj));
        if (row) { row.click(); return true; }
        // Not in the rendered window — page the virtual list and retry.
        const list = [...document.querySelectorAll('div')]
          .find(d => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
        if (list) list.scrollTop = list.scrollTop > 0 ? 0 : list.scrollTop + list.clientHeight;
        return false;
      }, subject);
      return { clicked, open: await selectedSubject(), rows: await visibleRows() };
    },
    (s) => s.open === subject,
    `the viewer never opened "${subject}" from a single (non-thread) row`,
    45_000,
    800,
  );
}

/**
 * Open the multi-message thread carrying `subject`.
 *
 * Threads are built after the list paints (and, for the INBOX view, after the
 * Sent headers arrive), so this polls instead of clicking once. Copied from
 * connected-thread-bodies.test.js, which owns the same fixture.
 */
async function openThread(subject) {
  await waitFor(
    async () => {
      const clicked = await browser.execute((subj) => {
        const rows = [...document.querySelectorAll('[data-testid="email-row"]')];
        const row = rows.find(r => r.offsetHeight > 0
          && Number(r.getAttribute('data-thread-count') || 1) > 1
          && (r.textContent || '').includes(subj));
        if (row) { row.click(); return true; }
        const list = [...document.querySelectorAll('div')]
          .find(d => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
        if (list) list.scrollTop = list.scrollTop > 0 ? 0 : list.scrollTop + list.clientHeight;
        return false;
      }, subject);
      const isThread = clicked
        && await browser.execute(() => (document.body.textContent || '').includes('messages in thread'));
      return { clicked, isThread, rows: await visibleRows() };
    },
    (s) => s.isThread,
    `no thread row for "${subject}" opened the thread view`,
    45_000,
    1000,
  );
}

/** Open the 3-dot menu of the first rendered row carrying `subject`. */
async function openRowMenu(subject) {
  await waitFor(
    async () => {
      if (await menuIsOpen()) return { open: true, rows: [] };
      await browser.execute((subj) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .filter(r => r.offsetHeight > 0)
          .find(r => (r.textContent || '').includes(subj));
        row?.querySelector('button[aria-label="Row actions"]')?.click();
      }, subject);
      await browser.pause(250);
      return { open: await menuIsOpen(), rows: await visibleRows() };
    },
    (s) => s.open,
    `the row menu never opened on the row carrying "${subject}"`,
    20_000,
    300,
  );
}

/** The index of the folded thread message whose snippet already reads `snippet`. */
const foldedWith = (headers, snippet) =>
  headers.findIndex(h => h.folded && h.text.includes(snippet));

/**
 * The compose window once it is not merely mounted but PREFILLED.
 *
 * ComposeModal fills its fields from an effect, so the modal is on screen with
 * every field empty for a frame. A wait that stops at "a modal exists" catches
 * that frame whenever compose is opened off a promise (a resolved body, the
 * row menu's resolver) and reports an empty To as the product's answer.
 */
const prefilledCompose = (what) => waitFor(
  async () => ({
    open: await modalOpen(),
    count: await modalCount(),
    to: await fieldValue('compose-to'),
    subject: await fieldValue('compose-subject'),
  }),
  (s) => s.open && !!s.to,
  what,
  25_000,
  300,
);

describe('Reply entry points — header, thread message, row menu', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  // ── 1 + 2: the single viewer ──────────────────────────────────────────────

  it('the open message\'s header replies to it', async function () {
    await openSingleRow(SUBJECT);

    await waitFor(
      senderHeader,
      (h) => !!h && h.visible,
      'the viewer showed no [data-testid="sender-header"] after the row was opened',
      15_000,
      300,
    );

    expect(await clickTestid('sender-header')).toBe(true);
    const compose = await prefilledCompose(
      'clicking the sender header opened no compose window addressed to the sender',
    );

    expect(compose.to).toBe(SENDER);
    expect(compose.subject).toBe(`Re: ${SUBJECT}`);
  });

  it('two quick clicks on the header open one compose', async function () {
    // The whole header row is a compose trigger, so a double-click — or a drag
    // over the address that ends in a click — calls the reply handler twice.
    // Both clicks go in ONE execute: back to back, with no runner pause in
    // between, which is what a real double-click looks like to the page.
    await openSingleRow(SUBJECT);
    await waitFor(
      senderHeader,
      (h) => !!h && h.visible,
      'the viewer showed no [data-testid="sender-header"] before the double click',
      15_000,
      300,
    );

    const clicked = await browser.execute(() => {
      const row = document.querySelector('[data-testid="sender-header"]');
      if (!row || row.offsetHeight === 0) return false;
      row.click();
      row.click();
      return true;
    });
    expect(clicked).toBe(true);

    await prefilledCompose(
      'two clicks on the sender header opened no compose window addressed to the sender',
    );
    // A second window would mount in a later frame: settle before counting, or
    // a green here only means the poll was early.
    await browser.pause(1000);
    expect(await modalCount()).toBe(1);
    expect(await fieldValue('compose-subject')).toBe(`Re: ${SUBJECT}`);
  });

  it('the chevron unfolds the details and opens nothing', async function () {
    // The same message, still open — case 1's compose was closed in afterEach.
    expect(await selectedSubject()).toBe(SUBJECT);
    expect(await modalCount()).toBe(0);

    expect(await clickTestid('header-toggle')).toBe(true);
    const open = await waitFor(
      senderHeader,
      (h) => !!h && h.expanded === 'true',
      'the chevron did not report aria-expanded="true" after it was clicked',
      10_000,
      200,
    );
    // Unfolded means the details are actually there, not just an attribute.
    expect(open.text).toContain('To:');
    expect(open.label).toBe('Hide details');
    // The chevron folds; it must not reach the row's reply handler.
    expect(await modalCount()).toBe(0);

    expect(await clickTestid('header-toggle')).toBe(true);
    const shut = await waitFor(
      senderHeader,
      (h) => !!h && h.expanded === 'false',
      'the chevron did not fold the details again on a second click',
      10_000,
      200,
    );
    expect(shut.label).toBe('Show details');
    expect(await modalCount()).toBe(0);
  });

  // ── 3 + 4: a message inside a thread ──────────────────────────────────────

  describe('inside a thread', function () {
    /** The folded partner message — found once, used by both cases. */
    let folded = -1;

    it('a collapsed thread message replies to that message, not to the newest', async function () {
      await openThread(CROSS_FOLDER_SUBJECT);

      // Folded, and its snippet is its OWN body — that is the body having
      // loaded, which is what makes "the reply quotes it" provable.
      const headers = await waitFor(
        threadHeaders,
        (hs) => foldedWith(hs, CROSS_FOLDER_INBOX_BODY) >= 0,
        `no folded thread message showed the snippet "${CROSS_FOLDER_INBOX_BODY}"`,
        30_000,
        1000,
      );
      folded = foldedWith(headers, CROSS_FOLDER_INBOX_BODY);

      const clicked = await browser.execute((i) => {
        const h = document.querySelectorAll('[data-testid="thread-email-header"]')[i];
        if (!h) return false;
        h.click();
        return true;
      }, folded);
      expect(clicked).toBe(true);

      const compose = await prefilledCompose(
        'clicking the folded thread message opened no compose window addressed to its sender',
      );

      // The message clicked, not the newest one in the thread (our Sent reply,
      // which would answer ourselves).
      expect(compose.to).toBe('partner@example.com');
      expect(compose.subject).toBe(`Re: ${CROSS_FOLDER_SUBJECT}`);

      expect(await clickTestid('compose-quoted-toggle')).toBe(true);
      await waitFor(
        () => testidPresent('compose-quoted'),
        (present) => present,
        'the quoted original never expanded, so what the reply quotes is unproven',
        10_000,
        200,
      );
      expect(await testidText('compose-quoted')).toContain(CROSS_FOLDER_INBOX_BODY);
    });

    it('the thread chevron unfolds the message without a compose', async function () {
      expect(folded).toBeGreaterThanOrEqual(0);
      expect(await modalCount()).toBe(0);

      expect(await clickTestid('header-toggle', folded)).toBe(true);
      const body = await waitFor(
        () => threadBodyAt(folded),
        (text) => !!text && text.includes(CROSS_FOLDER_INBOX_BODY),
        'the thread chevron did not render that message\'s body',
        20_000,
        400,
      );
      expect(body).toContain(CROSS_FOLDER_INBOX_BODY);
      expect(await modalCount()).toBe(0);
    });
  });

  // ── 5 + 6: the row's 3-dot menu ───────────────────────────────────────────

  it('the row menu replies with the body loaded', async function () {
    await openRowMenu(SUBJECT);
    expect(await menuLabels()).toContain('Reply');
    expect(await clickMenuItem('Reply')).toBe(true);

    const compose = await prefilledCompose(
      'the row menu\'s Reply opened no compose window addressed to the sender',
    );

    expect(compose.subject).toBe(`Re: ${SUBJECT}`);
    expect(compose.to).toBe(SENDER);

    // The menu only ever holds the row's header: the quote proves the body
    // was resolved before compose opened.
    expect(await clickTestid('compose-quoted-toggle')).toBe(true);
    await waitFor(
      () => testidPresent('compose-quoted'),
      (present) => present,
      'the quoted original never expanded on a reply opened from the row menu',
      10_000,
      200,
    );
    expect(await testidText('compose-quoted')).toContain(BODY);
  });

  it('the row menu starts a new conversation with the sender', async function () {
    await openRowMenu(SUBJECT);
    expect(await menuLabels()).toContain(`New message to ${SENDER_NAME}`);
    expect(await clickMenuItem(`New message to ${SENDER_NAME}`)).toBe(true);

    const compose = await prefilledCompose(
      'the row menu\'s "New message to" opened no compose window addressed to the sender',
    );

    expect(compose.to).toBe(SENDER);
    // A fresh conversation: no subject, and nothing quoted to toggle.
    expect(compose.subject).toBe('');
    expect(await testidPresent('compose-quoted-toggle')).toBe(false);
  });
});
