/**
 * E2E: the all-inboxes list acting on a VAULT-ONLY row, and the sidebar's
 * double-click shortcut back to an account's inbox.
 *
 * Both need more than one account, and the first needs a row that exists in the
 * vault and NOT in the server list — the case every read-state mutation missed.
 * `deriveDisplayRows` pushes such a row onto the list out of `localEmails`, and
 * `emails` never holds it, so "mark as read" mapped an array the row was not in
 * and nothing at all happened on screen. A single-account run cannot see it
 * either: the composite selection key only exists in unified mode.
 *
 * The vault-only row is built the way a person builds one — archive a message,
 * then delete the server copy — rather than by writing files behind the app.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

describe('All inboxes — acting on a vault-only row', function () {
  this.timeout(240_000);

  const LUKE = 'luke@mock.test';

  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      // The unread marker EmailRow/ThreadRow put on the row root.
      unread: row.classList.contains('bg-mail-surface'),
      icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
    })));

  const rowFor = async (subject) => (await rows()).find((r) => r.text.includes(subject));

  /**
   * The row, hunted for through a virtualized list.
   *
   * The unified list merges both inboxes, so a message that was near the bottom
   * of one account's INBOX is far past the render window here — absent from the
   * DOM, which reads exactly like a row that was never merged in. Page down and
   * wrap, the same way connected-backup-dot does.
   */
  async function findRow(subject, timeoutMsg) {
    let found = null;
    await browser.waitUntil(async () => {
      found = await rowFor(subject);
      if (found) return true;
      await browser.execute(() => {
        const list = [...document.querySelectorAll('div')]
          .find((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
        if (!list) return;
        const next = list.scrollTop + list.clientHeight;
        list.scrollTop = next >= list.scrollHeight - list.clientHeight ? 0 : next;
      });
      return false;
    }, { timeout: 90_000, interval: 500, timeoutMsg });
    return found;
  }

  const clickRowCheckbox = (subject) => browser.execute((needle) => {
    for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
      if (!(row.innerText || '').includes(needle)) continue;
      const box = row.querySelector('input[type="checkbox"]');
      if (!box) return false;
      box.click();
      return true;
    }
    return false;
  }, subject);

  const clickBarButton = (title) => browser.execute((t) => {
    const btn = document.querySelector(`button[title="${t}"]`);
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  }, title);

  const clickAllInboxes = () => browser.execute(() => {
    const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  });

  /** What the store believes, which is the only place `localEmails` is visible. */
  const storeView = () => browser.execute(() => {
    const s = window.__MAIL_STORE__?.getState?.();
    if (!s) return null;
    return {
      unified: s.activeMailbox === 'UNIFIED' || s.unifiedInbox === true,
      accountId: s.activeAccountId,
      mailbox: s.activeMailbox,
      localSubjects: (s.localEmails || []).map((e) => e.subject),
    };
  });

  /**
   * Enter the unified list and wait for the LOAD, not the mode flag.
   *
   * `activeMailbox === 'UNIFIED'` is set first and the per-account vault rows
   * are merged in later — with `_accountId` stamped on them, which is what the
   * composite selection key is built from. Acting in between selects
   * `"<uid>"` while the row answers to `"<account>:<uid>"`, and the mutation
   * matches nothing. That is a race in the SPEC, and it looked exactly like the
   * product bug this file exists for.
   */
  async function enterUnified(subject) {
    expect(await clickAllInboxes()).toBe(true);
    await browser.waitUntil(async () => (await storeView())?.unified === true, {
      timeout: 30_000, interval: 300, timeoutMsg: 'never entered the unified list',
    });
    await waitForEmails();
    await browser.waitUntil(async () => browser.execute((needle) => {
      const s = window.__MAIL_STORE__?.getState?.();
      const row = (s?.localEmails || []).find((e) => (e.subject || '').includes(needle));
      return Boolean(row && row._accountId);
    }, subject), {
      timeout: 60_000, interval: 400,
      timeoutMsg: `the unified list never merged "${subject}" in with its account stamped on it`,
    });
  }

  const localFlagsFor = (subject) => browser.execute((needle) => {
    const s = window.__MAIL_STORE__?.getState?.();
    const row = (s?.localEmails || []).find((e) => (e.subject || '').includes(needle));
    return row ? (row.flags || []) : null;
  }, subject);

  /**
   * Everything the mutation depends on, in one string.
   *
   * "the row stayed unread" is true of a selection key that never matched, a
   * derivation that never re-ran and a mutation that never fired — a timeout
   * message that cannot tell them apart costs a whole run to narrow.
   */
  const diagnose = (subject) => browser.execute((needle) => {
    const s = window.__MAIL_STORE__?.getState?.();
    if (!s) return 'no store';
    const pick = (e) => ({ uid: e.uid, acct: e._accountId, box: e._mailbox, flags: e.flags });
    return JSON.stringify({
      activeMailbox: s.activeMailbox,
      selected: [...(s.selectedEmailIds || [])],
      inEmails: (s.emails || []).filter((e) => (e.subject || '').includes(needle)).map(pick),
      inLocal: (s.localEmails || []).filter((e) => (e.subject || '').includes(needle)).map(pick),
      inSorted: (s.sortedEmails || []).filter((e) => (e.subject || '').includes(needle)).map(pick),
    });
  }, subject);

  let vaultOnlySubject = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('puts a message in the vault', async function () {
    await switchToFolder(LUKE, 'INBOX');

    const candidates = (await rows())
      .filter((r) => /Luke message \d+/.test(r.text) && !r.icon?.startsWith('archived') && r.unread);
    expect(candidates.length).toBeGreaterThan(0);
    vaultOnlySubject = candidates[candidates.length - 1].text.match(/Luke message \d+/)[0];

    expect(await clickRowCheckbox(vaultOnlySubject)).toBe(true);
    expect(await clickBarButton('Archive selected')).toBe(true);
    await browser.waitUntil(async () => !!(await rowFor(vaultOnlySubject))?.icon?.startsWith('archived'), {
      timeout: 60_000, interval: 300,
      timeoutMsg: `"${vaultOnlySubject}" never became an archived row`,
    });
  });

  it('marks that row read from the all-inboxes list', async function () {
    expect(vaultOnlySubject).not.toBeNull();

    await enterUnified(vaultOnlySubject);

    // The row has to BE there, unread, and come from the vault — without all
    // three the assertion below would pass against nothing.
    const before = await findRow(vaultOnlySubject,
      `"${vaultOnlySubject}" never appeared in the unified list`);
    expect(before.icon?.startsWith('archived')).toBe(true);
    expect(before.unread).toBe(true);
    // It is in the vault half of the store, which is the array the mutation
    // used to skip. Without this the assertions below prove nothing about it.
    expect((await storeView()).localSubjects.some((s) => (s || '').includes(vaultOnlySubject))).toBe(true);
    expect(await localFlagsFor(vaultOnlySubject)).not.toContain('\\Seen');

    expect(await clickRowCheckbox(vaultOnlySubject)).toBe(true);
    expect(await clickBarButton('Mark as read')).toBe(true);

    try {
      await browser.waitUntil(async () => (await rowFor(vaultOnlySubject))?.unread === false,
        { timeout: 30_000, interval: 300 });
    } catch {
      throw new Error(`"${vaultOnlySubject}" stayed unread after Mark as read. State: ${
        await diagnose(vaultOnlySubject)}`);
    }
    // And the vault row itself carries the flag, not just the rendered copy.
    expect(await localFlagsFor(vaultOnlySubject)).toContain('\\Seen');
  });

  it('keeps the vault copy read after the list is rebuilt from disk', async function () {
    // Leaving and re-entering re-reads local-index.json, so a flag that only
    // ever lived in memory comes back missing here. The server copy is not the
    // subject: this is the vault's own record of the message.
    await switchToFolder(LUKE, 'INBOX');
    await enterUnified(vaultOnlySubject);

    const back = await findRow(vaultOnlySubject,
      `"${vaultOnlySubject}" did not come back in the unified list`);
    expect(back.unread).toBe(false);
    expect(await localFlagsFor(vaultOnlySubject)).toContain('\\Seen');
  });
});

describe('Sidebar — double-click an account for its inbox', function () {
  this.timeout(180_000);

  const LUKE = 'luke@mock.test';
  const VADER = 'vader@mock.test';

  const activePair = () => browser.execute(() => {
    const s = window.__MAIL_STORE__?.getState?.();
    return s ? { accountId: s.activeAccountId, mailbox: s.activeMailbox, unified: s.unifiedInbox === true } : null;
  });

  const accountIdOf = (email) => (browser.mockAccounts || []).find((a) => a.email === email)?.id || null;

  /** The account row's box in the sidebar, in viewport coordinates. */
  const rowBox = (email) => browser.execute((needle) => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    if (!sidebar) return null;
    const leaf = [...sidebar.querySelectorAll('*')]
      .find((el) => el.children.length === 0 && (el.textContent || '').trim() === needle);
    const row = leaf?.closest('.cursor-pointer') || leaf?.parentElement;
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, email);

  /**
   * Two native presses on the row, through the engine.
   *
   * `browser.performActions` delivers real pointer input, but tauri-wd does not
   * track click counts, so WebKit never promotes the second press to a
   * `dblclick` — measured, not assumed: see the capability test below, which
   * fails the day the harness gains it and this can be simplified.
   */
  async function nativePressTwice({ x, y }) {
    await browser.performActions([{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', duration: 0, x, y },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
        { type: 'pause', duration: 40 },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
      ],
    }]);
    await browser.releaseActions();
  }

  /**
   * The click, then the dblclick the harness will not synthesize.
   *
   * The single click is native, so the account activation under test is the
   * engine's own; only the `dblclick` itself is dispatched. React's
   * onDoubleClick listens for exactly this event on exactly this element, so
   * the wiring — handler present, bound to the row, bubbling from the row's
   * children — is what gets exercised.
   */
  async function doubleClickRow(email) {
    const box = await rowBox(email);
    expect(box).not.toBeNull();
    await nativePressTwice(box);
    const result = await browser.execute((needle) => {
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      const leaf = [...sidebar.querySelectorAll('*')]
        .find((el) => el.children.length === 0 && (el.textContent || '').trim() === needle);
      const row = leaf?.closest('.cursor-pointer') || leaf?.parentElement;
      if (!row) return { dispatched: false, dblclickSeen: false };
      // Watched on the way past, so "the handler did nothing" and "the event
      // never reached the handler's element" cannot be confused.
      let seen = false;
      const wrapper = row.parentElement;
      const spy = () => { seen = true; };
      wrapper?.addEventListener('dblclick', spy);
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
      wrapper?.removeEventListener('dblclick', spy);
      return { dispatched: true, dblclickSeen: seen };
    }, email);
    expect(result.dispatched).toBe(true);
    return result;
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  // Pins the harness limit the helper above works around, so the workaround
  // cannot quietly outlive its reason: the day tauri-wd synthesizes dblclick,
  // this goes red and `doubleClickRow` loses its dispatch.
  it('does not get a dblclick out of two native presses (harness limit)', async function () {
    await switchToFolder(LUKE, 'INBOX');
    await browser.execute(() => {
      window.__DBLCLICKS__ = 0;
      window.__dblCounter__ = () => { window.__DBLCLICKS__ += 1; };
      document.addEventListener('dblclick', window.__dblCounter__, true);
    });
    const box = await rowBox(LUKE);
    expect(box).not.toBeNull();
    await nativePressTwice(box);
    await browser.pause(500);
    const seen = await browser.execute(() => {
      document.removeEventListener('dblclick', window.__dblCounter__, true);
      return window.__DBLCLICKS__;
    });
    expect(seen).toBe(0);
  });

  it('lands in the inbox even when the account was last read elsewhere', async function () {
    // Leave VADER somewhere that is not its inbox, so a single click would
    // resume there and the double click has something to prove.
    await switchToFolder(VADER, 'Archive', { requireRows: false });
    await switchToFolder(LUKE, 'INBOX');

    const landed = await doubleClickRow(VADER);
    expect(landed.dblclickSeen).toBe(true);

    await browser.waitUntil(async () => {
      const p = await activePair();
      return p?.accountId === accountIdOf(VADER) && p?.mailbox === 'INBOX' && p?.unified === false;
    }, {
      timeout: 60_000, interval: 300,
      timeoutMsg: `Double-clicking ${VADER} never landed in its INBOX (store says ${
        JSON.stringify(await activePair())}, dblclick delivered: ${landed.dblclickSeen})`,
    });
    await waitForEmails();
  });

  it('leaves the unified list for that account, not for its last folder', async function () {
    await switchToFolder(VADER, 'Archive', { requireRows: false });
    expect(await browser.execute(() => {
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    })).toBe(true);
    await browser.waitUntil(async () => (await activePair())?.unified === true, {
      timeout: 30_000, interval: 300, timeoutMsg: 'never entered the unified list',
    });

    const landed = await doubleClickRow(VADER);
    expect(landed.dblclickSeen).toBe(true);

    await browser.waitUntil(async () => {
      const p = await activePair();
      return p?.accountId === accountIdOf(VADER) && p?.mailbox === 'INBOX' && p?.unified === false;
    }, {
      timeout: 60_000, interval: 300,
      timeoutMsg: `Double-click out of the unified list did not land in ${VADER}'s INBOX (store says ${
        JSON.stringify(await activePair())}, dblclick delivered: ${landed.dblclickSeen})`,
    });
  });
});
