/**
 * E2E: a one-time code that arrives by mail is offered in a corner bubble,
 * with Copy and Copy & delete.
 *
 * Two deliveries into Yoda's INBOX over IMAP, exactly as a sender would: one
 * with the code in the subject, one with the code only in the body (the app
 * reads the body for that). The clipboard is a stub installed into the
 * webview, so the copy is observed without the OS pasteboard.
 *
 * Yoda, dated 2020, cleaned up in `after`: the same reasons as
 * connected-instant-arrival.test.js, which this follows.
 */

import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2;          // MOCK_ACCOUNTS order: luke, vader, yoda

const SUBJECT_CODE = 'Your verification code is 482913';
const BODY_SUBJECT = 'Sign in to Acme';
const BODY_CODE = '775421';

const OLD_HEADER_DATE = 'Wed, 01 Jan 2020 12:00:00 +0000';
const OLD_INTERNAL_DATE = new Date('2020-01-01T12:00:00Z');

const rfc822 = (subject, body) => Buffer.from([
  'From: Acme <no-reply@acme.test>',
  `To: ${YODA}`,
  `Subject: ${subject}`,
  `Date: ${OLD_HEADER_DATE}`,
  `Message-ID: <${subject.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}@mock.test>`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  body,
  '',
].join('\r\n'));

const BUBBLE = '[data-testid="code-bubble"]';

describe('A one-time code from the mail is offered in a corner bubble', function () {
  this.timeout(300_000);

  async function withYoda(fn) {
    const { host, port } = browser.mockImap[YODA_SERVER];
    const client = new ImapFlow({
      host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout();
    }
  }

  const deliver = (subject, body) => withYoda(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      return await client.append('INBOX', rfc822(subject, body), [], OLD_INTERNAL_DATE);
    } finally {
      lock.release();
    }
  });

  const uidsIn = (mailbox, subject) => withYoda(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      return await client.search({ subject }, { uid: true });
    } finally {
      lock.release();
    }
  });

  const bubbles = () => browser.execute((sel) => [...document.querySelectorAll(sel)].map((b) => ({
    code: b.querySelector('[data-testid="code-bubble-code"]')?.textContent || '',
    text: b.textContent || '',
  })), BUBBLE);

  const waitForBubble = (code) => browser.waitUntil(async () => (await bubbles()).some((b) => b.code === code), {
    timeout: 20_000, interval: 250,
    timeoutMsg: `no bubble offered the code ${code} within 20 s of its arrival`,
  });

  const clickInBubble = (code, label) => browser.execute((sel, c, l) => {
    const bubble = [...document.querySelectorAll(sel)]
      .find((b) => b.querySelector('[data-testid="code-bubble-code"]')?.textContent === c);
    const button = bubble && [...bubble.querySelectorAll('button')]
      .find((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase() === l);
    if (!button) return false;
    button.click();
    return true;
  }, BUBBLE, code, label);

  const copied = () => browser.execute(() => window.__E2E_COPIED__ || null);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.waitUntil(async () =>
      (await browser.execute(() => window.__DB_PROBE__?.daemonHealth?.().alive)) === true, {
      timeout: 180_000, interval: 1_000, timeoutMsg: 'the daemon never came up',
    });
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setLocalCacheDurationMonths(0));
    await browser.pause(1_500);
    await switchToFolder(YODA, 'INBOX');
    // The pasteboard, observed: the real one is not readable from here.
    await browser.execute(() => {
      window.__E2E_COPIED__ = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (text) => { window.__E2E_COPIED__ = text; return Promise.resolve(); } },
      });
    });
  });

  after(async function () {
    for (const subject of [SUBJECT_CODE, BODY_SUBJECT]) {
      for (const mailbox of ['INBOX', 'Trash']) {
        try {
          const uids = await uidsIn(mailbox, subject);
          if (!uids.length) continue;
          await withYoda(async (client) => {
            const lock = await client.getMailboxLock(mailbox);
            try {
              await client.messageDelete(uids, { uid: true });
            } finally {
              lock.release();
            }
          });
        } catch (e) {
          console.warn(`[code-bubble] could not purge "${subject}" from ${mailbox}:`, e.message);
        }
      }
    }
  });

  it('offers a code from the subject, and Copy puts it on the clipboard', async function () {
    expect(await bubbles()).toEqual([]);
    await deliver(SUBJECT_CODE, 'Enter it within ten minutes.');
    await waitForBubble('482913');

    expect((await bubbles()).find((b) => b.code === '482913').text).toContain('Acme');
    expect(await clickInBubble('482913', 'copy')).toBe(true);
    await browser.waitUntil(async () => (await copied()) === '482913', {
      timeout: 5_000, timeoutMsg: 'Copy did not put the code on the clipboard',
    });
    // The message is still there: Copy alone deletes nothing.
    expect((await bubbles()).some((b) => b.code === '482913')).toBe(true);
    expect((await uidsIn('INBOX', SUBJECT_CODE)).length).toBe(1);

    expect(await clickInBubble('482913', 'dismiss')).toBe(true);
    await browser.waitUntil(async () => !(await bubbles()).some((b) => b.code === '482913'), {
      timeout: 5_000, timeoutMsg: 'the X did not dismiss the bubble',
    });
  });

  it('reads a code from the body, and Copy & delete removes the message', async function () {
    await browser.execute(() => { window.__E2E_COPIED__ = null; });
    await deliver(BODY_SUBJECT, `Your one-time passcode is ${BODY_CODE}. It expires in 10 minutes.`);
    await waitForBubble(BODY_CODE);
    await browser.waitUntil(async () => (await visibleRowSubjects()).some((r) => r.includes(BODY_SUBJECT)), {
      timeout: 10_000, interval: 250, timeoutMsg: `"${BODY_SUBJECT}" was not on screen`,
    });

    expect(await clickInBubble(BODY_CODE, 'copy & delete')).toBe(true);
    await browser.waitUntil(async () => (await copied()) === BODY_CODE, {
      timeout: 5_000, timeoutMsg: 'Copy & delete did not put the code on the clipboard',
    });
    await browser.waitUntil(async () => !(await bubbles()).some((b) => b.code === BODY_CODE), {
      timeout: 10_000, timeoutMsg: 'Copy & delete left the bubble on screen',
    });
    await browser.waitUntil(async () => !(await visibleRowSubjects()).some((r) => r.includes(BODY_SUBJECT)), {
      timeout: 10_000, interval: 250, timeoutMsg: `"${BODY_SUBJECT}" stayed in the list after Copy & delete`,
    });
    // Gone from the inbox on the server too, not only from the list.
    await browser.waitUntil(async () => (await uidsIn('INBOX', BODY_SUBJECT)).length === 0, {
      timeout: 20_000, interval: 500, timeoutMsg: `"${BODY_SUBJECT}" is still in the server INBOX`,
    });
  });
});
