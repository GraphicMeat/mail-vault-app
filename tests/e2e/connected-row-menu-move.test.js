/**
 * E2E: the row menu's "Move to folder" — where it opens, and what it sends.
 *
 * bson73, discussion #1, 2026-09-03, two reports in one message:
 *
 *  1. The menu opened on a row near the bottom of the window ran off the
 *     bottom edge, and so did the folder list it opens beside it — "you just
 *     scroll up and try again". Every floating panel now shifts to stay
 *     inside the window (useViewportShift). This spec opens the menu on the
 *     lowest fully visible row, checks the menu would NOT have fit where its
 *     anchor put it, and measures where it actually is; then the same for the
 *     folder list.
 *
 *  2. "invalid args `uids` for command `imap_move_emails`: invalid type:
 *     string "…:INBOX:34363", expected u32". The row menu hands the move
 *     workflow selection keys — what the checkbox writes — and a row that came
 *     from another folder than the one on screen carries the full
 *     `account:folder:uid` key. An all-folders search from any folder but
 *     INBOX lists INBOX hits exactly like that (the reporter was filing
 *     Hetzner status mails found by search), and the workflow's single-folder
 *     branch passed the key through to the IMAP command as a uid. This spec
 *     searches all folders from Sent, moves the INBOX hit for real, reads
 *     both folders over raw IMAP, and puts the message back.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { openRowMenu, rowMenuIsOpen, clickRowAction } from './rowMenu.js';
import { CROSS_FOLDER_SUBJECT } from './mockImap.js';
import { imap } from './rawImap.js';

const LUKE = 'luke@mock.test';
const TARGET = 'Archive';

// ── DOM helpers ─────────────────────────────────────────────────────────────

/**
 * Open the row menu of the first rendered row that matches: `{ subject,
 * sender }` for a row carrying both, or `{ withinOfBottom: px }` for the lowest
 * row whose bottom edge sits inside the window and within `px` of its bottom.
 */
const openRowMenuWhere = (m, why) => openRowMenu(m.subject
  // The subject alone also matches the "Re:" reply that sits in Sent — the
  // newer message, so the first row. The hit wanted is the one from the other
  // folder, and it is the only one whose row names the partner.
  ? { text: [m.subject, m.sender], not: `Re: ${m.subject}` }
  : m, why, 20_000);

const dropdownState = () => browser.execute(() => {
  const d = document.querySelector('[data-testid="move-to-folder-dropdown"]');
  if (!d) return null;
  const r = d.getBoundingClientRect();
  return {
    top: r.top, bottom: r.bottom, height: d.offsetHeight,
    shift: d.dataset.viewportShift || null,
    text: (d.innerText || '').trim(),
  };
});

const pickTarget = (label) => browser.execute((needle) => {
  const d = document.querySelector('[data-testid="move-to-folder-dropdown"]');
  for (const b of d?.querySelectorAll('[data-testid="move-folder-option"]') || []) {
    if ((b.textContent || '').trim() === needle) { b.click(); return true; }
  }
  return false;
}, label);

const closeEverything = () => browser.execute(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
});

// ── the server's own view ───────────────────────────────────────────────────

/** Every uid in `mailbox` whose Subject contains `subject`. */
async function uidsWithSubject(port, mailbox, subject) {
  const lines = await imap(port, mailbox, `UID SEARCH SUBJECT "${subject}"`);
  const line = lines.find(l => l.startsWith('* SEARCH'));
  return line ? line.slice('* SEARCH'.length).trim().split(/\s+/).filter(Boolean).map(Number) : [];
}

const waitFor = (pred, msg, timeout = 30_000) =>
  browser.waitUntil(async () => pred(), { timeout, interval: 400, timeoutMsg: msg });

describe('Row menu — Move to folder', function () {
  this.timeout(180_000);

  let port = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    port = browser.mockAccounts.find(a => a.email === LUKE).imapPort;
    await switchToFolder(LUKE, 'INBOX');
  });

  // ── 1. the menu, and the folder list beside it, stay inside the window ────
  // The harness seeds the row surface as favorite-menu (wdio.conf.js), a list
  // menu that hangs from the row's trigger: the geometry the report was about.

  it('opens the menu on the lowest visible row inside the window', async function () {
    // The lowest row whose bottom edge is inside the window. Its menu hangs
    // from the bottom of that row, so without the shift it would not fit.
    const row = await openRowMenuWhere(
      { withinOfBottom: 160 },
      'no row sits within 160px of the bottom edge — is the list shorter than the window?',
    );
    await browser.pause(400); // the open animation

    const menu = await browser.execute(() => {
      const m = document.querySelector('[role="menu"][data-surface="row"]');
      const r = m.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: m.offsetHeight, innerHeight: window.innerHeight, shift: m.dataset.viewportShift || null };
    });
    // The precondition that makes this a test: anchored where its row put it,
    // the menu would have run off the bottom.
    expect(row.bottom + 4 + menu.height).toBeGreaterThan(menu.innerHeight);
    expect(menu.shift).not.toBeNull();
    expect(menu.bottom).toBeLessThanOrEqual(menu.innerHeight);
    expect(menu.top).toBeGreaterThanOrEqual(0);
  });

  it('opens the folder list beside that menu inside the window too', async function () {
    expect(await clickRowAction('move')).toBe(true);
    await waitFor(async () => (await dropdownState())?.height > 0, 'the folder list never opened');
    await browser.pause(400);

    const d = await dropdownState();
    const innerHeight = await browser.execute(() => window.innerHeight);
    // It hangs from the Move item, which sits near the bottom of a menu that
    // itself sits at the bottom edge: unshifted it cannot fit.
    expect(d.shift).not.toBeNull();
    expect(d.bottom).toBeLessThanOrEqual(innerHeight);
    expect(d.top).toBeGreaterThanOrEqual(0);

    await closeEverything();
    await waitFor(async () => !(await rowMenuIsOpen()), 'Escape did not close the menu');
  });

  // ── 2. a search hit from another folder moves under its own folder ────────

  describe('a search hit from another folder', function () {
    let inboxUidBefore = null;
    let archiveBefore = null;
    let moved = false;

    before(async function () {
      [inboxUidBefore] = await uidsWithSubject(port, 'INBOX', CROSS_FOLDER_SUBJECT);
      expect(inboxUidBefore).toBeDefined();
      archiveBefore = await uidsWithSubject(port, TARGET, CROSS_FOLDER_SUBJECT);
      expect(archiveBefore).toEqual([]);

      // Sent, not INBOX: the hit must come from a folder other than the one on
      // screen, or it is keyed by bare uid and the bug never shows.
      await switchToFolder(LUKE, 'Sent');
      await browser.waitUntil(async () => browser.execute(async (q) => {
        const store = window.__SEARCH_STORE__;
        if (!store) return false;
        store.setState({ searchQuery: q });
        store.getState().setSearchFilters({ folder: 'all', location: 'server' });
        await store.getState().performSearch();
        return true;
      }, CROSS_FOLDER_SUBJECT), { timeout: 20_000, interval: 500, timeoutMsg: 'Search store never became available' });

      await waitFor(async () => browser.execute((want) => {
        const rows = window.__SEARCH_STORE__?.getState?.().searchResults || [];
        return rows.some(r => r.subject === want && r._mailbox === 'INBOX');
      }, CROSS_FOLDER_SUBJECT), `the all-folders search never listed "${CROSS_FOLDER_SUBJECT}" from INBOX`, 60_000);
    });

    after(async function () {
      await closeEverything();
      await browser.execute(() => {
        window.__SEARCH_STORE__?.getState?.().clearSearch?.();
        window.__SEARCH_STORE__?.setState?.({ searchActive: false, searchResults: [], searchQuery: '' });
      });
      if (!moved) return;
      // Put the message back for the specs after this one; a Sent reply that
      // travelled with it (a threaded hit) goes back to Sent.
      try {
        const replies = await uidsWithSubject(port, TARGET, `Re: ${CROSS_FOLDER_SUBJECT}`);
        for (const uid of replies) await imap(port, TARGET, `UID MOVE ${uid} "Sent"`);
        const roots = (await uidsWithSubject(port, TARGET, CROSS_FOLDER_SUBJECT)).filter(u => !replies.includes(u));
        for (const uid of roots) await imap(port, TARGET, `UID MOVE ${uid} "INBOX"`);
      } catch (e) {
        console.warn('[row-menu-move] restore failed:', e.message);
      }
    });

    it('moves it under INBOX, where it lives, and the server agrees', async function () {
      await openRowMenuWhere(
        { subject: CROSS_FOLDER_SUBJECT, sender: 'Partner' },
        `no result row for "${CROSS_FOLDER_SUBJECT}" from Partner was rendered`,
      );
      expect(await clickRowAction('move')).toBe(true);
      await waitFor(async () => (await dropdownState())?.height > 0, 'the folder list never opened');
      expect(await pickTarget(TARGET)).toBe(true);
      moved = true;

      // The failure mode is the list staying open with the error under it.
      await waitFor(async () => {
        const d = await dropdownState();
        if (d && /invalid args|expected u32/i.test(d.text)) {
          throw new Error(`the move sent a selection key as a uid: ${d.text}`);
        }
        return d === null;
      }, 'the folder list never closed after picking a target');

      await waitFor(async () => (await uidsWithSubject(port, 'INBOX', CROSS_FOLDER_SUBJECT)).length === 0,
        `uid ${inboxUidBefore} is still in INBOX on the server`);
      const inArchive = await uidsWithSubject(port, TARGET, CROSS_FOLDER_SUBJECT);
      expect(inArchive.length).toBeGreaterThan(0);
    });

    it('drops the moved hit from the results list', async function () {
      await waitFor(async () => browser.execute((want) => {
        const rows = window.__SEARCH_STORE__?.getState?.().searchResults || [];
        return !rows.some(r => r.subject === want && r._mailbox === 'INBOX');
      }, CROSS_FOLDER_SUBJECT), 'the moved hit is still listed as an INBOX result');
    });
  });
});
