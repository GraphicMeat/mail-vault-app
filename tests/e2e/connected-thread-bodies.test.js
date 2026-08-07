/**
 * E2E Test: Thread bodies come from the right mailbox
 *
 * A UID identifies a message only inside one mailbox — Sent UID 6 and INBOX
 * UID 6 are different messages. When the thread view resolved a body from the
 * active view instead of the message's own folder, it rendered a real but
 * unrelated message under the right header.
 *
 * The mock mailboxes are built for this (see mockImap.js): the Sent-folder
 * conversation and the cross-folder reply sit on UIDs that also exist in INBOX
 * holding "Body of mock message N".
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  SENT_THREAD_SUBJECT,
  SENT_THREAD_BODY,
  CROSS_FOLDER_SUBJECT,
  CROSS_FOLDER_INBOX_BODY,
  CROSS_FOLDER_SENT_BODY,
} from './mockImap.js';

/** What the list is currently showing — for failure messages worth reading. */
async function visibleRows() {
  return browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter(r => r.offsetHeight > 0)
    .slice(0, 12)
    .map(r => `${r.getAttribute('data-thread-count') || '1'}× ${(r.textContent || '').trim().slice(0, 60)}`));
}

/**
 * Open the multi-message thread carrying `subject`.
 *
 * Threads are built after the list paints (and, for the INBOX view, after the
 * Sent headers arrive), so this polls instead of clicking once.
 */
async function openThread(subject) {
  let opened = false;
  await browser.waitUntil(
    async () => {
      opened = await browser.execute((subj) => {
        const rows = [...document.querySelectorAll('[data-testid="email-row"]')];
        const row = rows.find(r => r.offsetHeight > 0
          && Number(r.getAttribute('data-thread-count') || 1) > 1
          && (r.textContent || '').includes(subj));
        if (row) { row.click(); return true; }
        // Not in the rendered window — page the virtual list down and retry.
        const list = [...document.querySelectorAll('div')]
          .find(d => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
        if (list) list.scrollTop = list.scrollTop > 0 ? 0 : list.scrollTop + list.clientHeight;
        return false;
      }, subject);
      if (!opened) return false;
      // The row is a thread, so the viewer must show the thread header.
      return browser.execute(() => (document.body.textContent || '').includes('messages in thread'));
    },
    {
      timeout: 45_000,
      interval: 1000,
      timeoutMsg: `no thread row for "${subject}"; rows: ${JSON.stringify(await visibleRows())}`,
    },
  );
}

/**
 * Expand every message in the open thread and return their rendered bodies.
 *
 * The newest message starts expanded, so this clicks only the ones showing
 * neither a body nor a loading spinner — clicking blindly would collapse it.
 */
async function readThreadBodies() {
  const expandAll = () => browser.execute(() => {
    let clicked = 0;
    for (const header of document.querySelectorAll('[data-testid="thread-email-header"]')) {
      const item = header.parentElement;
      const busy = item.querySelector('.email-content, iframe, .animate-spin');
      if (!busy && header.offsetHeight > 0) { header.click(); clicked++; }
    }
    return clicked;
  });

  const bodies = () => browser.execute(() => ({
    headers: document.querySelectorAll('[data-testid="thread-email-header"]').length,
    // Plain-text bodies render as React text (no iframe), so the DOM has them.
    texts: [...document.querySelectorAll('.email-content')]
      .map(b => (b.textContent || '').trim())
      .filter(Boolean),
  }));

  await browser.waitUntil(
    async () => {
      await expandAll();
      const { headers, texts } = await bodies();
      return headers > 0 && texts.length >= headers;
    },
    { timeout: 45_000, interval: 1500, timeoutMsg: `not every thread message rendered a body: ${JSON.stringify(await bodies())}` },
  );

  return (await bodies()).texts;
}

/** Click an account in the sidebar by its address. */
async function clickAccount(email) {
  return browser.execute((mail) => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    if (!sidebar) return false;
    for (const el of sidebar.querySelectorAll('div, button')) {
      const text = (el.textContent || '').trim();
      const title = el.getAttribute('title') || '';
      if ((text === mail || title.includes(mail)) && el.offsetHeight > 0) {
        (el.closest('div[class*="cursor-pointer"]') || el).click();
        return true;
      }
    }
    return false;
  }, email);
}

describe('Thread bodies resolve to their own mailbox', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();

    // The INBOX list only merges Sent once the Sent headers are in the store,
    // and on a cold profile that happens on an account switch, not at boot.
    // Round-trip through the second account to get there the way a user would.
    await clickAccount(browser.testEnv.TEST_EMAIL2);
    await browser.pause(8000);
    await clickAccount(browser.testEnv.TEST_EMAIL);
    await browser.pause(8000);
  });

  it('shows the Sent reply\'s own body in a thread opened from INBOX', async function () {
    await openThread(CROSS_FOLDER_SUBJECT);

    const bodies = await readThreadBodies();
    const joined = bodies.join('\n');

    expect(joined).toContain(CROSS_FOLDER_INBOX_BODY);
    expect(joined).toContain(CROSS_FOLDER_SENT_BODY);
    // The reply lives at a Sent UID that also exists in INBOX; that message's
    // body must not appear anywhere in this thread.
    expect(joined).not.toContain('Body of mock message');
  });

  it('shows Sent-folder bodies for a thread opened in the unified Sent view', async function () {
    // Unified mode: emails carry their own account and folder, and the active
    // mailbox is the virtual 'UNIFIED' — the case that used to fall back to INBOX.
    const inUnified = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    });
    expect(inUnified).toBe(true);
    await browser.pause(2000);

    const pickedSent = await browser.execute(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      if (!sidebar) return false;
      for (const el of sidebar.querySelectorAll('div, button')) {
        if ((el.textContent || '').trim() === 'Sent' && el.offsetHeight > 0) {
          el.click();
          return true;
        }
      }
      return false;
    });
    expect(pickedSent).toBe(true);
    await browser.pause(3000);

    await openThread(SENT_THREAD_SUBJECT);

    const bodies = await readThreadBodies();
    const joined = bodies.join('\n');

    expect(joined).toContain(SENT_THREAD_BODY);
    expect(joined).not.toContain('Body of mock message');
  });

  after(async function () {
    // Leave single-account INBOX behind for the specs that follow.
    await browser.execute((testEmail) => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      if (!sidebar) return;
      for (const el of sidebar.querySelectorAll('button, div')) {
        const title = el.getAttribute('title') || '';
        const text = (el.textContent || '').trim();
        if (title.includes(testEmail) || text === testEmail) { el.click(); return; }
      }
    }, browser.testEnv?.TEST_EMAIL);
    await browser.pause(2000);
  });
});
