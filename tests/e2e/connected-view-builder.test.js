/**
 * E2E: the reader's view builder turns an email's words into a saved view.
 *
 * The open email is Luke's `SENDER_AUTH_SUBJECT` fixture (INBOX, body "This one
 * passed SPF and DKIM."): its words are rare across the mock mail, so the
 * daemon has distinctive ones to offer. A generic "Luke message NN" holds only
 * `luke`, `message` and `body`, which the "too common" cut drops, and the panel
 * would rightly offer nothing.
 *
 * The chain: `views.keywords` ranks the words in the daemon, the panel shows
 * them as chips, "New view" saves a view of the first one scoped to Luke's
 * account, the sidebar lists it, and opening it lists the email. Every number
 * comes from the daemon; the spec only checks the screen agrees.
 */
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { SENDER_AUTH_SUBJECT, SENDER_AUTH_BODY } from './mockImap.js';

const LUKE = 'luke@mock.test';
const SENDER = 'Verified Sender';

describe('View builder', function () {
  this.timeout(300_000);
  let lukeId = null;
  let uid = null;
  let billing = null;
  let keywords = null;

  const rpc = (method, params) => browser.executeAsync((m, p, done) => {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((value) => done({ ok: true, value }), (error) => done({ ok: false, error: String(error?.message || error) }));
  }, method, params);

  const listViews = async () => {
    const reply = await rpc('views.list', {});
    expect(reply.ok).toBe(true);
    return reply.value || [];
  };

  const clickRow = (subject) => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
    if (!row) return false;
    row.click();
    return true;
  }, subject);

  const headerNames = (name) => browser.execute((needle) =>
    (document.querySelector('[data-testid="sender-header"]')?.innerText || '').includes(needle), name);

  const chips = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="view-builder-chips"] [role="checkbox"]')].map((chip) => ({
      text: (chip.textContent || '').trim(),
      checked: chip.getAttribute('aria-checked'),
    })));

  const builderOpen = () => browser.execute(() =>
    document.querySelector('[data-testid="view-builder-toggle"]')?.getAttribute('aria-pressed') || null);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');

    lukeId = await browser.execute((email) =>
      (window.__MAIL_STORE__?.getState().accounts || []).find((a) => a.email === email)?.id || null, LUKE);
    expect(lukeId).toBeTruthy();

    // Three starters fill a free plan, and "New view" would be refused.
    billing = await browser.execute(() => {
      const before = window.__SETTINGS_STORE__.getState().billingProfile;
      window.__SETTINGS_STORE__.setState({ billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active', clientAccessGranted: true } });
      return before ?? null;
    });
  });

  after(async function () {
    if ((await builderOpen().catch(() => null)) === 'true') {
      await browser.execute(() => document.querySelector('[data-testid="view-builder-toggle"]')?.click()).catch(() => {});
    }
    await browser.executeAsync((done) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      invoke('daemon_rpc', { method: 'views.list', params: {} })
        .then((views) => Promise.all((views || []).filter((v) => !v.builtin)
          .map((v) => invoke('daemon_rpc', { method: 'views.delete', params: { id: v.id } }))))
        .then(() => done(), () => done());
    }).catch(() => {});
    await browser.execute((profile) => window.__SETTINGS_STORE__?.setState({ billingProfile: profile }), billing).catch(() => {});
  });

  it('offers the email\'s words, makes a view of one, and the view lists the email', async function () {
    await browser.waitUntil(async () => clickRow(SENDER_AUTH_SUBJECT), {
      timeout: 60_000, interval: 1000, timeoutMsg: `row "${SENDER_AUTH_SUBJECT}" never appeared in Luke's INBOX`,
    });
    await browser.waitUntil(async () => headerNames(SENDER), {
      timeout: 30_000, interval: 400, timeoutMsg: `"${SENDER_AUTH_SUBJECT}" never opened in the reader`,
    });

    uid = await browser.execute((subject) =>
      (window.__MAIL_STORE__?.getState().sortedEmails || []).find((e) => e.subject === subject)?.uid ?? null,
    SENDER_AUTH_SUBJECT);
    expect(uid).not.toBeNull();

    // The panel asks once per email and an index still building answers
    // "unavailable": wait for the daemon to have words before opening it, so
    // the panel's one ask gets them (cached, once the body is indexed). Every
    // 2s: a foreground RPC parks the indexer ~400ms, and this one waits on it.
    let last = null;
    await browser.waitUntil(async () => {
      last = await rpc('views.keywords', { accountId: lukeId, mailbox: 'INBOX', uid });
      return last.ok && last.value?.available === true && (last.value.keywords || []).length > 0;
    }, { timeout: 120_000, interval: 2000 }).catch(() => {
      throw new Error(`views.keywords never offered a word for "${SENDER_AUTH_SUBJECT}": ${JSON.stringify(last)}`);
    });
    keywords = last.value.keywords.map((k) => k.term);

    expect(await builderOpen()).toBe('false');
    await browser.execute(() => document.querySelector('[data-testid="view-builder-toggle"]').click());
    await browser.waitUntil(async () => (await builderOpen()) === 'true',
      { timeout: 5_000, timeoutMsg: 'the view builder toggle did not turn on' });
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('[data-testid="view-builder-panel"]')),
      { timeout: 10_000, timeoutMsg: 'the view builder panel never opened' });

    let shown = [];
    await browser.waitUntil(async () => (shown = await chips()).length > 0, {
      timeout: 30_000, interval: 300,
      timeoutMsg: `the panel showed no chips, though the daemon offered ${JSON.stringify(keywords)}`,
    });
    // None picked yet, and the first is a word of this email. Not compared
    // with the list asked above word for word: the indexer reaching the body
    // between the two asks changes which words survive.
    expect(shown.every((c) => c.checked === 'false')).toBe(true);
    const term = shown[0].text;
    expect(`${SENDER_AUTH_SUBJECT} ${SENDER_AUTH_BODY}`.toLowerCase()).toContain(term);

    const before = (await listViews()).map((v) => v.id);
    expect(await browser.execute(() => document.querySelector('[data-testid="view-builder-new"]')?.disabled)).toBe(true);

    await browser.execute(() => document.querySelector('[data-testid="view-builder-chips"] [role="checkbox"]').click());
    await browser.waitUntil(async () => (await chips())[0]?.checked === 'true',
      { timeout: 5_000, timeoutMsg: `the chip "${term}" did not turn on` });
    await browser.waitUntil(async () => browser.execute(() =>
      document.querySelector('[data-testid="view-builder-new"]')?.disabled === false),
    { timeout: 5_000, timeoutMsg: '"New view" never became usable with a word picked' });

    await browser.execute(() => document.querySelector('[data-testid="view-builder-new"]').click());

    // The notice also shows for a failed save: the stored view is the proof.
    let made = null;
    await browser.waitUntil(async () => {
      made = (await listViews()).find((v) => !before.includes(v.id)) || null;
      return !!made;
    }, { timeout: 15_000, interval: 300, timeoutMsg: `no view was stored for "${term}"` });
    expect(made.name).toBe(term);
    expect(made.builtin).toBeFalsy();
    expect(made.def.accounts).toEqual([lukeId]);
    expect(made.def.mailboxes || []).toEqual([]);
    expect(made.def.query).toBe(term);
    expect(await browser.execute(() => !!document.querySelector('[data-testid="view-builder-refused"]'))).toBe(false);

    // The sidebar lists it, under its name.
    const rowSelector = `[data-testid="view-row-${made.id}"]`;
    if (await browser.execute(() => document.querySelector('[data-testid="views-fold"]')?.getAttribute('aria-expanded') === 'false')) {
      await browser.execute(() => document.querySelector('[data-testid="views-fold"]').click());
    }
    await browser.waitUntil(async () => browser.execute((sel, name) =>
      (document.querySelector(sel)?.textContent || '').includes(name), rowSelector, term), {
      timeout: 15_000, interval: 300, timeoutMsg: `the sidebar never listed the view "${term}"`,
    });

    // Anti-vacuity: the daemon finds the email through the view before the
    // screen is asked to show it.
    let evaluated = null;
    await browser.waitUntil(async () => {
      evaluated = await rpc('views.evaluate', { viewId: made.id, accounts: [{ accountId: lukeId, address: LUKE }] });
      return evaluated.ok && evaluated.value?.available === true
        && (evaluated.value.rows || []).some((row) => row.subject === SENDER_AUTH_SUBJECT);
    }, { timeout: 60_000, interval: 2000 }).catch(() => {
      throw new Error(`the view "${term}" never found "${SENDER_AUTH_SUBJECT}": ${JSON.stringify(evaluated?.value?.total ?? evaluated)}`);
    });

    // One click: clicking the open view's row again closes it.
    await browser.execute((sel) => document.querySelector(sel).click(), rowSelector);
    await browser.waitUntil(async () => browser.execute((sel) =>
      document.querySelector(sel)?.getAttribute('aria-current') === 'true', rowSelector),
    { timeout: 10_000, timeoutMsg: `the view "${term}" did not become the open one` });
    await browser.waitUntil(async () => browser.execute((subject) => {
      const inStore = (window.__SEARCH_STORE__?.getState().searchResults || []).some((e) => e.subject === subject);
      const inDom = [...document.querySelectorAll('[data-testid="email-row"]')].some((row) => (row.innerText || '').includes(subject));
      return inStore && inDom;
    }, SENDER_AUTH_SUBJECT), {
      timeout: 30_000, interval: 300, timeoutMsg: `the view "${term}" opened without listing "${SENDER_AUTH_SUBJECT}"`,
    });
  });
});
