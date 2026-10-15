/**
 * E2E: "hide view mail" keeps a message a saved view holds off its folder.
 *
 * One view, saved straight through the daemon, finds one Luke INBOX message by
 * its subject. With the list toggle on, that row leaves INBOX and the header's
 * total drops by one; off, both come back. The daemon decides membership
 * (`views.hidden_members`) and the app only filters by the key set it hands
 * back, so this is the one place the whole chain runs end to end.
 *
 * The starter views are deleted: `hidden_members` is the union of every saved
 * view, and Needs reply or Attachments can hold other INBOX mail, which would
 * move the count by more than the one message this view finds. The view is
 * saved before they go, so no list the window loads in between holds none.
 *
 * The message is archived first: a view finds what the search index holds, and
 * the index is built from the vault, so a message only the server has is in no
 * view (and so is never hidden).
 */
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { clickSelectionAction } from './selectionBar.js';

const LUKE = 'luke@mock.test';
const VIEW_ID = 'e2e-view-hide';
const FULL = /^([\d,]+) emails$/;
const PARTIAL = /^([\d,]+) of ([\d,]+) emails$/;

const num = (s) => parseInt(s.replace(/,/g, ''), 10);

describe('Hide view mail', function () {
  this.timeout(300_000);
  let subject = null;

  const rpc = (method, params) => browser.executeAsync((m, p, done) => {
    window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
      .then((value) => done({ ok: true, value }), (error) => done({ ok: false, error: String(error?.message || error) }));
  }, method, params);

  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
    })));

  /// Exact subject: "Luke message 3" is a substring of "Luke message 38".
  const exact = (s) => new RegExp(`${s}(?!\\d)`);

  /// What the list holds, not only what the virtualized window draws.
  const listed = () => browser.execute((source) => {
    const re = new RegExp(source);
    const inStore = (window.__MAIL_STORE__?.getState().sortedEmails || []).some((e) => re.test(e.subject || ''));
    const inDom = [...document.querySelectorAll('[data-testid="email-row"]')].some((row) => re.test(row.innerText || ''));
    return { inStore, inDom };
  }, exact(subject).source);

  /// The header's total: "N emails", or M of "N of M emails".
  const headerTotal = async () => {
    const text = await browser.execute(() =>
      document.querySelector('[data-testid="email-list-count"]')?.textContent?.trim() || '');
    const full = text.match(FULL);
    if (full) return num(full[1]);
    const partial = text.match(PARTIAL);
    return partial ? num(partial[2]) : null;
  };

  const toggleState = () => browser.execute(() => {
    const button = document.querySelector('[data-testid="hide-view-mail-toggle"]');
    return button ? button.getAttribute('aria-pressed') : null;
  });
  const clickToggle = () => browser.execute(() => document.querySelector('[data-testid="hide-view-mail-toggle"]')?.click());
  const configOffered = () => browser.execute(() => !!document.querySelector('[data-testid="hide-view-mail-config"]'));
  /// Never picked: the one button opens the picker; OK with this view picked
  /// turns the hide on and splits the button.
  const pickViewToHide = async (id) => {
    await browser.execute(() => document.querySelector('[data-testid="hide-view-mail-config"]')?.click());
    await browser.waitUntil(() => browser.execute((viewId) =>
      !!document.querySelector(`[data-testid="hide-view-mail-pick"][data-view-id="${viewId}"]`), id),
    { timeout: 5_000, timeoutMsg: 'the picker never listed the view' });
    await browser.execute((viewId) =>
      document.querySelector(`[data-testid="hide-view-mail-pick"][data-view-id="${viewId}"]`).click(), id);
    await browser.execute(() => document.querySelector('[data-testid="hide-view-mail-ok"]')?.click());
  };
  const forgetPick = () => browser.execute(() =>
    window.__SETTINGS_STORE__?.setState({ hideViewMail: false, hideViewMailViews: null }));

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await forgetPick();
    await switchToFolder(LUKE, 'INBOX');

    const fresh = (await rows()).filter((r) => /Luke message \d\d(?!\d)/.test(r.text)
      && !r.icon?.startsWith('archived') && !r.icon?.startsWith('local-only'));
    // The pick connected-view-query-groups archives: two-digit, never archived.
    expect(fresh.length).toBeGreaterThan(3);
    subject = fresh[fresh.length - 3].text.match(/Luke message \d\d/)[0];
    // Into the vault, so the index (and with it the view) can find it.
    const clicked = await browser.execute((source) => {
      const re = new RegExp(source);
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        if (!re.test(row.innerText || '')) continue;
        row.querySelector('input[type="checkbox"]')?.click();
        return true;
      }
      return false;
    }, exact(subject).source);
    expect(clicked).toBe(true);
    expect(await clickSelectionAction('archive')).toBe(true);
    await browser.waitUntil(async () => (await rows()).some((r) => exact(subject).test(r.text) && r.icon?.startsWith('archived')), {
      timeout: 60_000, interval: 300, timeoutMsg: `"${subject}" never became an archived row`,
    });
    // Leave nothing selected: the selection bar is not what this spec is about.
    await browser.execute(() => {
      for (const box of document.querySelectorAll('[data-testid="email-row"] input[type="checkbox"]')) {
        if (box.checked) box.click();
      }
    });

    const lukeId = await browser.execute((email) =>
      (window.__MAIL_STORE__?.getState().accounts || []).find((a) => a.email === email)?.id || null, LUKE);
    expect(lukeId).toBeTruthy();

    // The first list seeds the starters, and a deleted starter stays deleted.
    const listedViews = await rpc('views.list', {});
    expect(listedViews.ok).toBe(true);
    // Saved before the starters go: a `loadViews` landing between a delete and
    // the save would leave the window with no view, and no toggle on offer.
    // One phrase alone carries a trailing `||`, or it is read as AND words.
    const saved = await rpc('views.save', { view: {
      id: VIEW_ID, name: 'E2E hide', icon: 'mail', position: 0, builtin: null,
      def: { accounts: [lukeId], mailboxes: ['INBOX'], query: `${subject} ||` },
    } });
    expect(saved.ok).toBe(true);
    for (const view of listedViews.value || []) {
      if (view.id === VIEW_ID) continue;
      expect((await rpc('views.delete', { id: view.id })).ok).toBe(true);
    }
    const after = await rpc('views.list', {});
    expect((after.value || []).map((v) => v.id)).toEqual([VIEW_ID]);

    // The header's "-1" below means something only if the view finds exactly
    // this one message: a subject that is also part of another would hide two.
    // Asked until the index has the message: a ready index can still be on
    // its way to it. Every 2s, a foreground RPC parks the indexer ~400ms.
    let evaluated = null;
    await browser.waitUntil(async () => {
      evaluated = await rpc('views.evaluate', { viewId: VIEW_ID, accounts: [{ accountId: lukeId, address: LUKE }] });
      return evaluated.ok && evaluated.value?.available === true && evaluated.value.total >= 1;
    }, { timeout: 120_000, interval: 2000 }).catch(() => {
      throw new Error(`the hide view never found "${subject}": ${JSON.stringify(evaluated)}`);
    });
    expect(evaluated.value.total).toBe(1);
    expect((evaluated.value.rows || []).map((row) => row.subject)).toEqual([subject]);
  });

  after(async function () {
    await forgetPick().catch(() => {});
    await rpc('views.delete', { id: VIEW_ID }).catch(() => {});
  });

  it('keeps the message a view holds off INBOX while on, and gives it back when off', async function () {
    // The stale window store still lists the starters loaded at launch, so the
    // button is offered; the daemon reads the views itself. Never picked, it
    // is one button and no on/off half.
    await browser.waitUntil(configOffered,
      { timeout: 15_000, timeoutMsg: 'the hide view mail button was never offered' });
    expect(await toggleState()).toBe(null);

    // Anti-vacuity: the message is in the list, and the header has a total.
    await browser.waitUntil(async () => (await listed()).inStore, {
      timeout: 30_000, interval: 300, timeoutMsg: `"${subject}" was never in INBOX`,
    });
    expect((await listed()).inDom).toBe(true);
    let before = null;
    await browser.waitUntil(async () => (before = await headerTotal()) !== null, {
      timeout: 30_000, interval: 300, timeoutMsg: 'the INBOX header never showed a total',
    });

    await pickViewToHide(VIEW_ID);
    await browser.waitUntil(async () => (await toggleState()) === 'true',
      { timeout: 5_000, timeoutMsg: 'OK in the picker did not turn the hide on' });

    // An index still building answers "unknown", which hides nothing, and
    // nothing asks again until a count refresh: flip it to ask again.
    let lastFlip = Date.now();
    await browser.waitUntil(async () => {
      const now = await listed();
      if (!now.inStore && !now.inDom) return true;
      if (Date.now() - lastFlip > 5_000) {
        await clickToggle();
        await browser.pause(200);
        await clickToggle();
        lastFlip = Date.now();
      }
      return false;
    }, { timeout: 90_000, interval: 500, timeoutMsg: `"${subject}" stayed in INBOX with the toggle on` });
    expect(await toggleState()).toBe('true');
    await browser.waitUntil(async () => (await headerTotal()) === before - 1, {
      timeout: 15_000, interval: 300,
      timeoutMsg: `the header total should drop from ${before} to ${before - 1}`,
    });

    await clickToggle();
    await browser.waitUntil(async () => (await toggleState()) === 'false',
      { timeout: 5_000, timeoutMsg: 'the toggle did not turn off' });
    await browser.waitUntil(async () => {
      const now = await listed();
      return now.inStore && now.inDom;
    }, { timeout: 30_000, interval: 300, timeoutMsg: `"${subject}" did not come back with the toggle off` });
    await browser.waitUntil(async () => (await headerTotal()) === before, {
      timeout: 15_000, interval: 300,
      timeoutMsg: `the header total should be back at ${before}`,
    });
  });
});
