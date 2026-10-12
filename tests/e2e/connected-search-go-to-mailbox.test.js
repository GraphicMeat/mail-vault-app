/**
 * E2E: a search from All inboxes says which account holds each hit, lights that
 * account in the sidebar while the pointer is on the row, and "Go to mailbox"
 * opens the hit where it lives.
 *
 * Before: a hit carried the account id but not the address, so the account dot
 * (guarded on the address) never drew and a hit read as nobody's. The row menu
 * had no way out of the search to the message's own folder and thread.
 *
 * Fixtures: "message" matches mail in every account (the badge and sidebar
 * cases). FRAGMENTED_SUBJECT is luke's three-message INBOX conversation (the
 * harness seeds threadMode 'grouped'); the spec enters All inboxes with yoda as
 * the active account, so opening luke's middle message is a real switch.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { FRAGMENTED_SUBJECT } from './mockImap.js';
import { rowMenuIsOpen, clickRowAction, rowMenuItems } from './rowMenu.js';

const LUKE = 'luke@mock.test';
const YODA = 'yoda@mock.test';

const idOf = email => browser.mockAccounts.find(account => account.email === email).id;

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
    // All inboxes is built from each account's cached headers: visit both
    // first, yoda last, so yoda is the account All inboxes leaves behind.
    await switchToFolder(LUKE, 'INBOX');
    await switchToFolder(YODA, 'INBOX');
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
  });

  /** Search and wait until it has finished and `ready(hits)` holds. */
  async function searchUntil(query, ready, why) {
    expect(await searchAll(query)).toBe(true);
    await browser.waitUntil(async () => ready(await hits()), { timeout: 30_000, timeoutMsg: why });
    await browser.waitUntil(() => browser.execute(() => !window.__SEARCH_STORE__.getState().isSearching),
      { timeout: 30_000, timeoutMsg: 'the search never finished' });
  }

  it('names the account of every hit, by address and by badge', async function () {
    await searchUntil('message', found => new Set(found.map(hit => hit.accountId)).size >= 2,
      'the search never returned hits from two accounts');
    const found = await hits();
    expect(found.length).toBeGreaterThan(1);
    // The daemon stamps the id; the app gives the row the address.
    expect(found.filter(hit => !hit.accountEmail)).toEqual([]);

    const rows = await rowBadges();
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter(row => !row.dot).map(row => row.text)).toEqual([]);
    for (const row of rows) {
      expect(row.dot.initial.length).toBeGreaterThan(0);
      expect(row.dot.title).toContain('@mock.test');
    }
    expect(new Set(rows.map(row => row.dot.accountId)).size).toBeGreaterThan(1);
  });

  it('lights the hit\'s account in the sidebar while the pointer is on the row', async function () {
    expect(await pointedAccounts()).toEqual([]);
    const row = await browser.execute(() => {
      const el = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find(r => r.offsetHeight > 0 && r.querySelector('[data-testid="account-dot"]'));
      if (!el) return null;
      el.setAttribute('data-e2e-pointed', 'yes');
      return el.querySelector('[data-testid="account-dot"]').title;
    });
    expect(row).toContain('@mock.test');
    const point = entering => browser.execute((on) => {
      document.querySelector('[data-e2e-pointed]')
        .dispatchEvent(new MouseEvent(on ? 'mouseover' : 'mouseout', { bubbles: true, relatedTarget: document.body }));
    }, entering);
    await point(true);
    await browser.waitUntil(async () => (await pointedAccounts()).length === 1,
      { timeout: 5_000, timeoutMsg: 'no sidebar account lit under the pointer' });
    expect((await pointedAccounts())[0]).toContain(row);
    await point(false);
    await browser.waitUntil(async () => (await pointedAccounts()).length === 0,
      { timeout: 5_000, timeoutMsg: 'the sidebar account stayed lit after the pointer left' });
  });

  it('Go to mailbox leaves the search and opens the hit\'s thread on that message', async function () {
    const luke = idOf(LUKE);
    await searchUntil(FRAGMENTED_SUBJECT,
      found => found.filter(hit => hit.accountId === luke && hit.mailbox === 'INBOX').length >= 3,
      'the search never returned luke\'s three conversation messages');
    // The middle one: neither the first nor the newest, so the anchor is not a default.
    const inbox = (await hits()).filter(hit => hit.accountId === luke && hit.mailbox === 'INBOX')
      .sort((a, b) => a.uid - b.uid);
    const target = inbox[1];
    expect(await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId)).not.toBe(luke);

    await browser.waitUntil(async () => {
      if (await rowMenuIsOpen()) return true;
      await browser.execute((id, uid) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find(r => r.offsetHeight > 0 && r.getAttribute('data-uid') === String(uid)
            && r.querySelector('[data-testid="account-dot"]')?.dataset.accountId === id);
        row?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        row?.querySelector('.quick-actions[data-surface="row"] .quick-actions-trigger')?.click();
      }, luke, target.uid);
      await browser.pause(250);
      return rowMenuIsOpen();
    }, { interval: 300, timeout: 30_000, timeoutMsg: 'the row menu never opened on the hit' });
    expect((await rowMenuItems()).map(item => item.action)).toContain('goToMailbox');
    expect(await clickRowAction('goToMailbox')).toBe(true);

    await browser.waitUntil(() => browser.execute((id) => {
      const s = window.__MAIL_STORE__.getState();
      return s.activeAccountId === id && s.activeMailbox === 'INBOX' && !s.unifiedInbox && !!s.selectedThread;
    }, luke), { timeout: 30_000, timeoutMsg: 'Go to mailbox never opened luke\'s INBOX thread' });

    const state = await browser.execute(() => {
      const s = window.__MAIL_STORE__.getState();
      return { searchActive: window.__SEARCH_STORE__.getState().searchActive, focusKey: s.threadFocusKey, members: s.selectedThread.emails.length };
    });
    expect(state.searchActive).toBe(false);
    expect(state.members).toBeGreaterThan(1);
    expect(state.focusKey.endsWith(`|INBOX|${target.uid}`)).toBe(true);

    // The thread shows that one message open.
    await browser.waitUntil(() => browser.execute(
      () => document.querySelectorAll('[data-testid="header-toggle"][aria-expanded="true"]').length === 1,
    ), { timeout: 15_000, timeoutMsg: 'the thread did not open exactly one message' });
  });
});
