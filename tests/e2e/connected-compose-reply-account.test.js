/**
 * E2E: which mailbox a reply leaves from, with three accounts on screen.
 *
 * connected-compose-reply-modes proves the same rule against a SEEDED
 * selection. This file never seeds one: every case clicks a real row, so the
 * message reaches compose the way it does in the app — through `selectEmail`,
 * a body fetched from the mock server, and (in the unified cases) a bare uid
 * whose account only the list knew.
 *
 * Reported 2026-08-26: a reply left from the account that had SENT last, not
 * the one holding the message. So each case seeds `lastComposeIdentity` on a
 * DIFFERENT account than the one being read — that identity is exactly what
 * used to win, and a case that leaves it unset passes either way.
 *
 * Why yoda for the unified cases: its UIDs start at 901, dates are derived
 * from the UID, and the unified list sorts date-descending — so its rows land
 * at the top instead of behind vader's 700. Uid 906 specifically: 907/908/909
 * carry the body-fetch faults, and 906 is `\Seen` already, so clicking it
 * moves no other spec's unread count.
 *
 * Harness facts this leans on:
 *   - Reply is pressed in the reader, not typed: the keyboard shortcuts read
 *     `selectedEmail`, and a thread selection holds none.
 *   - The unified list is built from each account's cached headers, so yoda
 *     has to be activated once before All Inboxes shows any of its mail.
 */
import { waitForApp, waitForEmails, clickSidebarItem, visibleRowSubjects } from './helpers.js';
import { closeComposeHard, fieldValue, modalOpen, modalTitle } from './composeHelpers.js';

const clickRow = (needle) => browser.execute((text) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find((r) => (r.innerText || '').includes(text));
  if (!row || row.offsetHeight === 0) return false;
  row.click();
  return true;
}, needle);

const activate = (accountId) => browser.execute((id) => {
  window.__MAIL_STORE__.getState().activateAccount(id, 'INBOX');
}, accountId);

const rememberSentFrom = (account) => browser.execute((id, address) => {
  window.__SETTINGS_STORE__.setState({ lastComposeIdentity: { accountId: id, address } });
}, account.id, account.email);

const selectionLoaded = () => browser.execute(() => {
  const s = window.__MAIL_STORE__.getState();
  // A row can open either shape. In the unified list yoda's messages arrive as
  // two-message THREADS — which is what the report was about — and a thread
  // selection deliberately holds no `selectedEmail` at all.
  return (!!s.selectedEmail && !s.loadingEmail) || !!s.selectedThread;
});

/**
 * Click a reply/forward button in the reader's action bar. The keyboard
 * shortcuts read `selectedEmail`, which a thread selection does not have, so
 * the button is the only way in to the path the reporter used.
 */
const clickAction = (label) => browser.execute((needle) => {
  const button = [...document.querySelectorAll('button')].find((b) => b.offsetHeight > 0
    && ((b.innerText || '').trim() === needle || b.getAttribute('aria-label') === needle));
  if (!button) return false;
  button.click();
  return true;
}, label);

/**
 * True once the thread item has the fetched BODY on screen. Load-bearing, and
 * the store cache is NOT a substitute: a thread item replies with
 * `loadedEmail || email`, and its header row carries the account already — the
 * bug only bites once the loaded body (which comes back from the server with
 * no account on it) is the thing being answered. Cache-filled and
 * item-rendered are different moments, and asserting on the first one let this
 * pass against the pre-fix build.
 */
const bodyRendered = (marker) => browser.execute((needle) =>
  (document.body.innerText || '').includes(needle), marker);

/** The fixture body of yoda's uid 906 — `Body of <prefix> <uid> for <owner>.` */
const YODA_BODY = 'Body of yoda message 906';

describe('Connected Compose Reply Account — three accounts, one reply', function () {
  this.timeout(240_000);

  let luke;
  let vader;
  let yoda;

  /** Wait until a row whose text contains `needle` is rendered, then click it. */
  async function openRow(needle) {
    await browser.waitUntil(
      async () => (await visibleRowSubjects()).some((s) => s.includes(needle)),
      {
        timeout: 60_000,
        interval: 300,
        timeoutMsg: `No row containing "${needle}" ever rendered — the account's headers never reached the list`,
      },
    );
    expect(await clickRow(needle)).toBe(true);
    await browser.waitUntil(selectionLoaded, {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `The body of "${needle}" never loaded, so there was nothing to reply to`,
    });
  }

  /** Wait until the thread item is answering with a fetched body, not its row. */
  async function waitForBody(marker) {
    await browser.waitUntil(() => bodyRendered(marker), {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `"${marker}" never rendered — the reply would answer the header row instead`,
    });
  }

  /** Press Reply or Forward in the reader, wait for the window. */
  async function openMode(label) {
    await browser.waitUntil(() => clickAction(label), {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: `No visible "${label}" button in the reader — nothing was open to answer`,
    });
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: `Compose did not open on "${label}"`,
    });
    await browser.pause(300);
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    [luke, vader, yoda] = browser.mockAccounts || [];
    expect(luke?.id).toBeDefined();
    expect(vader?.id).toBeDefined();
    expect(yoda?.id).toBeDefined();

    // The unified list is assembled from cached headers, so an account that has
    // never been opened contributes nothing to it.
    await activate(yoda.id);
    await browser.waitUntil(
      () => browser.execute(() => (window.__MAIL_STORE__.getState().emails || [])
        .some((e) => (e.subject || '').includes('Yoda message'))),
      { timeout: 60_000, interval: 300, timeoutMsg: 'Yoda mail never reached the store' },
    );
  });

  afterEach(async function () {
    await closeComposeHard();
    await browser.execute(() => {
      window.__SETTINGS_STORE__.setState({ lastComposeIdentity: null });
      window.__MAIL_STORE__.setState({ selectedEmail: null, selectedEmailId: null, selectedThread: null });
    });
  });

  after(async function () {
    // Leave the app on luke's INBOX: later specs in the run assume it.
    this.timeout(60_000);
    await activate(luke.id);
    await waitForEmails();
  });

  it('replies from the account whose inbox is open, not the one that sent last', async function () {
    await rememberSentFrom(luke);
    await activate(vader.id);
    await openRow('Vader message');

    await openMode('Reply');

    expect(await modalTitle()).toBe('Reply');
    expect(await fieldValue('compose-from')).toBe(`${vader.id} ${vader.email}`);
  });

  it('replies to a row in All Inboxes from that row account, not the active one', async function () {
    await rememberSentFrom(luke);
    await activate(luke.id);
    await waitForEmails();
    expect(await clickSidebarItem('All Inboxes')).toBe(true);

    // A unified row click forwards a bare uid; only the list knew whose it was.
    // Yoda's rows open as threads here — the shape the bug was reported on.
    await openRow('Yoda message 906');
    await waitForBody(YODA_BODY);

    await openMode('Reply');

    expect(await fieldValue('compose-from')).toBe(`${yoda.id} ${yoda.email}`);
    // The account being read is genuinely NOT the active one — otherwise the
    // old code would have answered yoda for the wrong reason.
    expect(await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId)).toBe(luke.id);
  });

  it('forwards a foreign row from the mailbox it is in', async function () {
    await rememberSentFrom(vader);
    await activate(luke.id);
    await waitForEmails();
    expect(await clickSidebarItem('All Inboxes')).toBe(true);
    await openRow('Yoda message 906');
    await waitForBody(YODA_BODY);

    await openMode('Forward');

    expect(await modalTitle()).toBe('Forward');
    expect(await fieldValue('compose-from')).toBe(`${yoda.id} ${yoda.email}`);
  });
});
