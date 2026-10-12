/**
 * E2E: a search from All inboxes says which account holds each hit, lights that
 * account in the sidebar while the pointer is on the row, and "Go to mailbox"
 * opens the hit where it lives.
 *
 * Before: a hit carried the account id but not the address, so the account dot
 * (guarded on the address) never drew and a hit read as nobody's. The row menu
 * had no way out of the search to the message's own folder and thread.
 *
 * Fixture: FRAGMENTED_SUBJECT. Every account's INBOX holds the same three-message
 * conversation (the harness seeds threadMode 'grouped'), so a search for it from
 * All inboxes returns hits in more than one account. The hit opened is yoda's
 * middle message: not the first account (so the switch is real) and not the
 * newest (so the anchor is not just the default).
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { FRAGMENTED_SUBJECT } from './mockImap.js';
import { rowMenuIsOpen, clickRowAction, rowMenuItems } from './rowMenu.js';

const YODA = 'yoda@mock.test';
const MIDDLE_SUBJECT = `Re: ${FRAGMENTED_SUBJECT}`;

const yodaId = () => browser.mockAccounts.find(account => account.email === YODA).id;

const searchAll = (query) => browser.execute((q) => {
  const store = window.__SEARCH_STORE__;
  if (!store) return false;
  store.setState({ searchQuery: q });
  store.getState().performSearch();
  return true;
}, query);

const hits = () => browser.execute(() => (window.__SEARCH_STORE__?.getState?.().searchResults || [])
  .map(row => ({ uid: row.uid, subject: row.subject, accountId: row._accountId, accountEmail: row._accountEmail, mailbox: row._mailbox })));

/** The visible result rows with the account badge each one draws. */
const rowBadges = () => browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')]
  .filter(r => r.offsetHeight > 0 && !r.closest('[data-quick-actions-preview]'))
  .map(r => {
    const dot = r.querySelector('[data-testid="account-dot"]');
    return { text: (r.textContent || '').trim().slice(0, 40), dot: dot ? { accountId: dot.dataset.accountId, initial: dot.textContent, title: dot.title } : null };
  }));

/** Move the pointer onto / off the first visible row whose text holds `text`. */
const pointAtRow = (text, on) => browser.execute((want, entering) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find(r => r.offsetHeight > 0 && (r.textContent || '').includes(want) && !r.closest('[data-quick-actions-preview]'));
  if (!row) return false;
  row.dispatchEvent(new MouseEvent(entering ? 'mouseover' : 'mouseout', { bubbles: true, relatedTarget: document.body }));
  return true;
}, text, on);

/** What the sidebar names as pointed at: the account's button title or label. */
const pointedAccounts = () => browser.execute(() => [...document.querySelectorAll('.sidebar-account-pointed, [data-pointed="true"]')]
  .map(el => `${el.getAttribute('aria-label') || ''} ${[...el.querySelectorAll('[title]')].map(t => t.title).join(' ')} ${el.title || ''}`));

describe('Search from All inboxes: account badge, sidebar light, Go to mailbox', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // All inboxes is built from each account's cached headers: visit both first.
    await switchToFolder(YODA, 'INBOX');
    await switchToFolder(browser.testEnv.TEST_EMAIL, 'INBOX');
    const clicked = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    expect(clicked).toBe(true);
    await browser.waitUntil(() => browser.execute(() => {
      const s = window.__MAIL_STORE__?.getState?.();
      return !!s && s.activeMailbox === 'UNIFIED' && !s.loadingProgress
        && new Set(s.sortedEmails.map(e => e._accountId).filter(Boolean)).size >= 2;
    }), { timeout: 30_000, timeoutMsg: 'All inboxes never loaded two accounts' });

    expect(await searchAll(FRAGMENTED_SUBJECT)).toBe(true);
    await browser.waitUntil(async () => {
      const found = await hits();
      return new Set(found.map(hit => hit.accountId)).size >= 2 && found.some(hit => hit.accountId === yodaId());
    }, { timeout: 30_000, timeoutMsg: 'the search never returned hits from two accounts' });
    await browser.waitUntil(() => browser.execute(() => !window.__SEARCH_STORE__.getState().isSearching),
      { timeout: 30_000, timeoutMsg: 'the search never finished' });
  });

  it('names the account of every hit, by address and by badge', async function () {
    const found = await hits();
    expect(found.length).toBeGreaterThan(1);
    // The daemon stamps the id; the app gives the row the address.
    expect(found.filter(hit => !hit.accountEmail)).toEqual([]);

    const rows = await rowBadges();
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.dot, `no account badge on "${row.text}"`).not.toBeNull();
      expect(row.dot.initial.length).toBeGreaterThan(0);
      expect(row.dot.title).toContain('@mock.test');
    }
    expect(new Set(rows.map(row => row.dot.accountId)).size).toBeGreaterThan(1);
  });

  it('lights the hit\'s account in the sidebar while the pointer is on the row', async function () {
    expect(await pointedAccounts()).toEqual([]);
    expect(await pointAtRow(MIDDLE_SUBJECT, true)).toBe(true);
    await browser.waitUntil(async () => (await pointedAccounts()).length === 1,
      { timeout: 5_000, timeoutMsg: 'no sidebar account lit under the pointer' });
    const [pointed] = await pointedAccounts();
    // Not necessarily yoda: the first matching row may be another account's.
    const rowAccount = await browser.execute(() => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find(r => r.offsetHeight > 0 && (r.textContent || '').includes('Re: Fragmented thread check'));
      return row?.querySelector('[data-testid="account-dot"]')?.title || null;
    });
    expect(pointed).toContain(rowAccount);

    expect(await pointAtRow(MIDDLE_SUBJECT, false)).toBe(true);
    await browser.waitUntil(async () => (await pointedAccounts()).length === 0,
      { timeout: 5_000, timeoutMsg: 'the sidebar account stayed lit after the pointer left' });
  });

  it('Go to mailbox leaves the search and opens the hit\'s thread on that message', async function () {
    const target = (await hits()).find(hit => hit.accountId === yodaId() && hit.subject === MIDDLE_SUBJECT);
    expect(target, 'yoda\'s middle message is not among the hits').toBeTruthy();

    // Rows of both accounts share the subject: the badge names yoda's.
    await browser.waitUntil(async () => {
      if (await rowMenuIsOpen()) return true;
      await browser.execute((id, subject) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find(r => r.offsetHeight > 0 && (r.textContent || '').includes(subject)
            && r.querySelector('[data-testid="account-dot"]')?.dataset.accountId === id);
        row?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        row?.querySelector('.quick-actions[data-surface="row"] .quick-actions-trigger')?.click();
      }, yodaId(), MIDDLE_SUBJECT);
      await browser.pause(250);
      return rowMenuIsOpen();
    }, { interval: 300, timeout: 30_000, timeoutMsg: 'the row menu never opened on yoda\'s hit' });
    const items = await rowMenuItems();
    expect(items.map(item => item.action)).toContain('goToMailbox');
    expect(await clickRowAction('goToMailbox')).toBe(true);

    await browser.waitUntil(() => browser.execute((id) => {
      const s = window.__MAIL_STORE__.getState();
      return s.activeAccountId === id && s.activeMailbox === 'INBOX' && !s.unifiedInbox && !!s.selectedThread;
    }, yodaId()), { timeout: 30_000, timeoutMsg: 'Go to mailbox never opened yoda\'s INBOX thread' });

    const state = await browser.execute(() => {
      const s = window.__MAIL_STORE__.getState();
      return {
        searchActive: window.__SEARCH_STORE__.getState().searchActive,
        focusKey: s.threadFocusKey,
        members: s.selectedThread.emails.map(e => e.uid),
        subject: s.selectedThread.subject,
      };
    });
    expect(state.searchActive).toBe(false);
    expect(state.members.length).toBeGreaterThan(1);
    expect(state.focusKey.endsWith(`|INBOX|${target.uid}`)).toBe(true);

    // The thread shows that one message open.
    await browser.waitUntil(() => browser.execute(
      () => document.querySelectorAll('[data-testid="header-toggle"][aria-expanded="true"]').length === 1,
    ), { timeout: 15_000, timeoutMsg: 'the thread did not open exactly one message' });
  });
});
