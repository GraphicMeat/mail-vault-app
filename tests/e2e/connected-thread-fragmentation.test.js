/**
 * E2E Test: a conversation stays ONE thread when its References chain breaks
 *
 * Replying three times inside MailVault used to leave three rows for one
 * conversation. Its replies carried `References: <parent>` only, and the
 * recipient's client then extended that truncated chain — so their answer
 * rooted on our reply rather than on the conversation, and the list read the
 * first reference as the thread root.
 *
 * The fixture (mockImap.js) is that exact shape: five messages, ours in Sent
 * and theirs in INBOX, with `frag-3` naming only its parent. Read as
 * `references[0]`, they split 3 + 2; linked through the whole chain, they are
 * one thread of five.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { FRAGMENTED_SUBJECT, FRAGMENTED_COUNT } from './mockImap.js';

/** Every visible row that carries the fragmented conversation's subject. */
async function fragmentRows() {
  return browser.execute((subj) => [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj))
    .map(r => ({
      count: Number(r.getAttribute('data-thread-count') || 1),
      text: (r.textContent || '').trim().slice(0, 60),
    })), FRAGMENTED_SUBJECT);
}

/** What the list is showing, for a failure message worth reading. */
async function visibleRows() {
  return browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0)
    .slice(0, 12)
    .map(r => `${r.getAttribute('data-thread-count') || '1'}× ${(r.textContent || '').trim().slice(0, 50)}`));
}

describe('Thread fragmentation', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('groups a truncated-chain conversation into a single row', async function () {
    // The Sent half is merged into the INBOX list asynchronously, so the row's
    // count climbs as headers land — poll for the whole conversation.
    await browser.waitUntil(
      async () => (await fragmentRows()).some(r => r.count === FRAGMENTED_COUNT),
      {
        timeout: 60_000,
        interval: 1000,
        timeoutMsg: `no ${FRAGMENTED_COUNT}-message row for "${FRAGMENTED_SUBJECT}"; `
          + `matching rows: ${JSON.stringify(await fragmentRows())}; list: ${JSON.stringify(await visibleRows())}`,
      },
    );

    // One row, not three: no fragment of the conversation is left behind.
    const rows = await fragmentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(FRAGMENTED_COUNT);
  });

  it('opens it as one thread of five messages', async function () {
    const opened = await browser.execute((subj) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find(r => r.offsetHeight > 0 && (r.textContent || '').includes(subj));
      if (!row) return false;
      row.click();
      return true;
    }, FRAGMENTED_SUBJECT);
    expect(opened).toBe(true);

    await browser.waitUntil(
      async () => browser.execute((n) => (document.body.textContent || '').includes(`${n} messages in thread`), FRAGMENTED_COUNT),
      {
        timeout: 45_000,
        interval: 500,
        timeoutMsg: `thread header never said "${FRAGMENTED_COUNT} messages in thread"`,
      },
    );

    // Every message is present, ours from Sent included.
    const headers = await browser.execute(() => document.querySelectorAll('[data-testid="thread-email-header"]').length);
    expect(headers).toBe(FRAGMENTED_COUNT);
  });
});
