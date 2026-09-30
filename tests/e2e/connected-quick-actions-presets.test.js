/**
 * E2E: Settings > Appearance > Quick actions draws the real list row, over
 * the latest messages of one of the person's inboxes, and nothing in it acts;
 * an action set applies to the surfaces the list itself shows.
 *
 * The sample account is picked at random once per app session and kept, so
 * `before` reads which one it is and opens that account's INBOX in the list:
 * every check below compares the sample with the list's own rows.
 *
 * Sample rows sit inside a `[data-quick-actions-preview]` marker; the list's
 * rows are the ones outside Settings and outside any marker.
 */
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

describe('Quick action samples and action sets', function () {
  this.timeout(300_000);
  let account = null;

  const resetQuickActions = () => browser.execute(() => window.__SETTINGS_STORE__.getState().resetQuickActions());

  async function openQuickActions() {
    await openSettings();
    await browser.pause(300);
    expect(await clickSettingsNav('Appearance')).toBe(true);
    expect(await clickSettingsNav('Quick actions')).toBe(true);
  }

  /** The live sample under the surface tabs: whose mail, and its rows. */
  const sample = () => browser.execute(() => {
    const frame = document.querySelector('[data-testid="settings-page"] .quick-actions-sample-frame');
    if (!frame) return null;
    return {
      account: frame.dataset.sampleAccount,
      marked: frame.hasAttribute('data-quick-actions-preview'),
      rows: [...frame.querySelectorAll('[data-testid="email-row"]')].map((row) => {
        const star = row.querySelector('[data-testid="star-toggle"]');
        return {
          uid: Number(row.dataset.uid),
          subject: (row.querySelector('[data-testid="row-subject"]')?.textContent || '').trim(),
          starred: star?.getAttribute('aria-pressed') === 'true',
          filled: (star?.querySelector('svg')?.getAttribute('class') || '').includes('fill-amber-400'),
          layout: row.querySelector('.quick-actions[data-surface="row"]')?.dataset.layout
            || (row.querySelector('.quick-actions-radial-preview') ? 'radial' : null),
        };
      }),
    };
  });
  // Real mail, not the cast: the cast's uids are negative.
  const waitForRealSample = () => browser.waitUntil(async () => {
    const shown = await sample();
    return !!shown?.rows.length && shown.rows.every((row) => row.uid > 0);
  }, { timeout: 20_000, interval: 250, timeoutMsg: 'the quick actions sample never showed cached mail' })
    .catch(async (error) => { throw new Error(`${error.message}: ${JSON.stringify(await sample())}`); });

  /** The list's own rows, never a sample's. A conversation row has no uid and no star. */
  const listRows = () => browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')]
    .filter((row) => !row.closest('[data-testid="settings-page"], [data-quick-actions-preview]'))
    .map((row) => ({
      uid: Number(row.dataset.uid),
      subject: (row.querySelector('[data-testid="row-subject"]')?.textContent || '').trim(),
      star: !!row.querySelector('[data-testid="star-toggle"]'),
      starred: row.querySelector('[data-testid="star-toggle"]')?.getAttribute('aria-pressed') === 'true',
    })));
  const clickListStar = (uid) => browser.execute((wanted) => {
    const row = [...document.querySelectorAll(`[data-testid="email-row"][data-uid="${wanted}"]`)]
      .find((el) => !el.closest('[data-testid="settings-page"], [data-quick-actions-preview]'));
    const star = row?.querySelector('[data-testid="star-toggle"]');
    if (!star) return false;
    star.click();
    return true;
  }, uid);

  /**
   * What the mail store holds of these messages: a click that reached mail
   * would move, flag, archive, select or open one. Only these uids: the list
   * may still be paging the rest in.
   */
  const mailState = (uids) => browser.execute((wanted) => {
    const s = window.__MAIL_STORE__.getState();
    return {
      messages: wanted.map((uid) => {
        const email = s.emails.find((e) => e.uid === uid);
        // The vault set is keyed accountId:mailbox:uid, by the row's own folder.
        const vaulted = email && s.archivedEmailIds?.has(`${email._accountId ?? s.activeAccountId}:${email._mailbox ?? s.activeMailbox}:${uid}`);
        return email ? [uid, [...(email.flags || [])].sort().join(' '), !!vaulted] : [uid, 'gone'];
      }),
      selected: s.selectedEmailIds.size,
      open: s.selectedEmail?.uid ?? null,
    };
  }, uids);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await resetQuickActions();
    // Which inbox the samples come from, then that inbox in the list.
    await openQuickActions();
    await waitForRealSample();
    const { account: id } = await sample();
    account = (browser.mockAccounts || []).find((a) => a.id === id);
    expect(account).toBeTruthy();
    await closeSettings();
    await switchToFolder(account.email, 'INBOX');
  });

  afterEach(async function () {
    await closeSettings().catch(() => {});
    await resetQuickActions();
  });

  it('draws the real rows over the latest messages of that inbox, as the list shows them', async function () {
    await openQuickActions();
    await waitForRealSample();
    const shown = await sample();
    expect(shown.account).toBe(account.id);
    expect(shown.marked).toBe(true);
    expect(shown.rows).toHaveLength(3);
    // A conversation row may name its thread by a reply's "Re:" subject.
    const bare = (subject) => subject.replace(/^((re|fwd?):\s*)+/i, '');
    const list = (await listRows()).map((item) => bare(item.subject));
    for (const row of shown.rows) {
      expect(row.subject.length).toBeGreaterThan(0);
      expect(list).toContain(bare(row.subject));
    }
  });

  it('a click in the sample reaches no mail', async function () {
    // The reset above is the radial default, whose actions mount only while the
    // wheel is open. Archive is an inline button in the favorite-menu layout,
    // which is what the harness seeds.
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setQuickActionStyle('row', null, { mode: 'favorite-menu' }));
    await openQuickActions();
    await waitForRealSample();
    const uids = (await sample()).rows.map((row) => row.uid);
    const before = await mailState(uids);
    expect(before.messages.every((message) => message[1] !== 'gone')).toBe(true);
    const clicked = await browser.execute(() => {
      const frame = document.querySelector('[data-testid="settings-page"] .quick-actions-sample-frame');
      const rows = [...frame.querySelectorAll('[data-testid="email-row"]')];
      const done = [];
      const click = (el, name) => { if (el) { el.click(); done.push(name); } };
      click(rows[0], 'row');
      click(rows[1]?.querySelector('[data-testid="star-toggle"]'), 'star');
      click(rows[2]?.querySelector('input[type="checkbox"]'), 'checkbox');
      // The row's own quick actions, drawn in place.
      for (const action of ['archive', 'toggleRead', 'star', 'deleteServer']) {
        click(rows[1]?.querySelector(`[data-quick-action="${action}"]:not(:disabled)`), action);
      }
      return done;
    });
    expect(clicked).toEqual(expect.arrayContaining(['row', 'star', 'checkbox', 'archive']));
    // Long enough for a write to have landed.
    await browser.pause(1500);
    expect(await mailState(uids)).toEqual(before);
    await closeSettings();
    const selectionBar = await browser.execute(() => [...document.querySelectorAll('[data-testid="selection-action-bar"]')]
      .some((el) => !el.closest('[data-quick-actions-preview]')));
    expect(selectionBar).toBe(false);
  });

  it('shows a starred message\'s star filled, as the list does', async function () {
    await openQuickActions();
    await waitForRealSample();
    const shown = (await sample()).rows;
    await closeSettings();
    // A message the list draws as a row of its own, with its star.
    const list = await listRows();
    const target = shown.find((row) => list.some((item) => item.uid === row.uid && item.star));
    expect(target).toBeTruthy();
    const star = async (on) => {
      if ((await listRows()).find((row) => row.uid === target.uid)?.starred === on) return;
      expect(await clickListStar(target.uid)).toBe(true);
      await browser.waitUntil(async () => (await listRows()).find((row) => row.uid === target.uid)?.starred === on,
        { timeout: 10_000, interval: 200, timeoutMsg: `the list never showed uid ${target.uid} ${on ? '' : 'un'}starred` });
    };
    try {
      await star(true);
      await openQuickActions();
      await browser.waitUntil(async () => {
        const row = (await sample())?.rows.find((item) => item.uid === target.uid);
        return !!row && row.starred && row.filled;
      }, { timeout: 10_000, interval: 250, timeoutMsg: 'the sample did not draw the starred message\'s star filled' })
        .catch(async (error) => { throw new Error(`${error.message}: ${JSON.stringify(await sample())}`); });
      const others = (await sample()).rows.filter((row) => row.uid !== target.uid && !row.starred);
      for (const row of others) expect(row.filled).toBe(false);
    } finally {
      await closeSettings().catch(() => {});
      await star(false).catch(() => {});
    }
  });

  it('an action set outlines its card and gives the list its row actions', async function () {
    await openQuickActions();
    await waitForRealSample();
    const cards = () => browser.execute(() => {
      const group = document.querySelector('[data-testid="settings-page"] [role="group"][aria-label="Action sets"]');
      return [...group.querySelectorAll('.choice-card')].map((card) => {
        const button = card.querySelector('.choice-card-button');
        return {
          name: button.textContent.trim(),
          pressed: button.getAttribute('aria-pressed') === 'true',
          selected: card.hasAttribute('data-selected'),
          border: getComputedStyle(card).borderTopColor,
        };
      });
    });
    // Where the cards and the sample sit, for the log: each card's picture
    // and the live wheel are drawn smaller by `zoom`.
    console.log('[quick-actions-presets] geometry', JSON.stringify(await browser.execute(() => {
      const rect = (el) => el && (({ left, top, width, height }) => ({ left, top, width, height }))(el.getBoundingClientRect());
      const root = document.querySelector('[data-testid="settings-page"]');
      const frame = root.querySelector('.quick-actions-sample-frame');
      return {
        cards: [...root.querySelectorAll('.choice-card')].slice(0, 8).map((card) => ({
          name: card.querySelector('.choice-card-button').textContent.trim(),
          card: rect(card),
          picture: rect(card.querySelector('.quick-actions-card-sample')),
          wheel: rect(card.querySelector('.quick-actions-radial-preview')),
          row: rect(card.querySelector('[data-testid="email-row"]')),
        })),
        frame: rect(frame),
        rows: [...frame.querySelectorAll('[data-testid="email-row"]')].map(rect),
        wheel: rect(frame.querySelector('.quick-actions-radial-preview')),
      };
    })));
    const initial = await cards();
    expect(initial.map((card) => card.name)).toEqual(['MailVault', 'Gmail', 'Outlook', 'Thunderbird']);
    expect(initial.filter((card) => card.pressed).map((card) => card.name)).toEqual(['MailVault']);
    const plainBorder = initial.find((card) => card.name === 'Gmail').border;

    const clicked = await browser.execute(() => {
      const group = document.querySelector('[data-testid="settings-page"] [role="group"][aria-label="Action sets"]');
      const button = [...group.querySelectorAll('.choice-card-button')].find((el) => el.textContent.trim() === 'Gmail');
      button?.click();
      return !!button;
    });
    expect(clicked).toBe(true);
    await browser.waitUntil(async () => (await cards()).find((card) => card.name === 'Gmail').pressed,
      { timeout: 5_000, interval: 100, timeoutMsg: 'the Gmail card never showed as the set in use' });
    const after = await cards();
    const gmail = after.find((card) => card.name === 'Gmail');
    expect(gmail.selected).toBe(true);
    expect(gmail.border).not.toBe(plainBorder);
    expect(after.find((card) => card.name === 'MailVault')).toMatchObject({ pressed: false, selected: false });
    expect(await browser.execute(() => window.__SETTINGS_STORE__.getState().quickActions.defaults.row.mode)).toBe('inline');
    // The sample's row between its neighbours shows the new set inline.
    await browser.waitUntil(async () => (await sample()).rows[1]?.layout === 'inline',
      { timeout: 5_000, interval: 100, timeoutMsg: 'the sample row did not take the Gmail layout' });

    await closeSettings();
    const listLayout = () => browser.execute(() => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((el) => !el.closest('[data-testid="settings-page"], [data-quick-actions-preview]'));
      row?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      const actions = row?.querySelector('.quick-actions[data-surface="row"]');
      return actions ? { layout: actions.dataset.layout, actions: [...actions.querySelectorAll('[data-quick-action]')].map((b) => b.dataset.quickAction) } : null;
    });
    await browser.waitUntil(async () => (await listLayout())?.layout === 'inline',
      { timeout: 10_000, interval: 200, timeoutMsg: 'the list row never showed the Gmail set inline' });
    expect((await listLayout()).actions).toContain('archive');
  });
});
