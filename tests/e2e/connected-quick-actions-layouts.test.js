/**
 * E2E: which quick-action layout each surface actually shows.
 *
 * The report: Settings > Quick actions > Email reader said "All views, Inline",
 * yet the reader of that INBOX showed only a "..." trigger. "Use everywhere" on
 * the Message rows tab with Scope = Current view had copied the rows' radial
 * layout into a Current-view override for the reader, and Settings always
 * opened on All views, so the override that governed the view was never shown
 * and every All-views edit looked ignored.
 *
 * Covers that path through the real Settings UI, the precedence rules
 * (Current view beats All views, linked vs separate style, reset to the
 * all-view defaults) and every surface x layout x scope combination.
 *
 * Assertions are on the main window's DOM only: the Settings preview renders
 * the same `.quick-actions` markup and must never answer for the real surface.
 * Sample rows and bars (Settings, onboarding) sit inside a
 * `[data-quick-actions-preview]` marker and are skipped the same way.
 */
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

const LUKE = 'luke@mock.test';
const SURFACES = ['row', 'selection', 'reader'];
const MODES = ['inline', 'menu', 'radial', 'favorite-menu'];
const SURFACE_TAB = { row: 'Message rows', selection: 'Selection bar', reader: 'Email reader' };
const LAYOUT_LABEL = { inline: 'Inline', menu: 'Menu', radial: 'Radial', 'favorite-menu': 'Favorite plus menu' };

describe('Quick action layouts', function () {
  this.timeout(600_000);
  let scopeKey = null;

  const resetQuickActions = () => browser.execute(() => window.__SETTINGS_STORE__.getState().resetQuickActions());
  const quickActions = () => browser.execute(() => window.__SETTINGS_STORE__.getState().quickActions);

  /** The surface as the main window renders it; never the Settings preview. */
  const surfaceState = (surface) => browser.execute((wanted) => {
    const outside = (el) => !el.closest('[data-testid="settings-page"], [data-quick-actions-preview]');
    // A row mounts its quick actions once hovered: hover the first, and a
    // caller's next poll finds them.
    if (wanted === 'row') [...document.querySelectorAll('[data-testid="email-row"]')].find(outside)?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const selector = wanted === 'reader' ? '.email-action-bar .quick-actions[data-surface="reader"]'
      : wanted === 'selection' ? '[data-testid="selection-action-bar"] .quick-actions[data-surface="selection"]'
        : '.quick-actions[data-surface="row"]';
    // The reader's default inline set renders three groups; the first is the
    // main one and the only one that follows the configured layout.
    const root = [...document.querySelectorAll(selector)].find(outside);
    if (!root) return null;
    const trigger = root.querySelector('.quick-actions-trigger');
    return {
      layout: root.dataset.layout,
      actions: [...root.querySelectorAll('[data-quick-action]')].map((b) => b.dataset.quickAction),
      trigger: !!trigger,
      triggerText: (trigger?.querySelector('span')?.textContent || '').trim(),
    };
  }, surface);

  const waitForLayout = (surface, mode) => browser.waitUntil(
    async () => (await surfaceState(surface))?.layout === mode,
    { timeout: 10_000, interval: 200, timeoutMsg: `${surface} never showed the ${mode} layout` },
  ).catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(await surfaceState(surface))}`);
  });

  /** The trigger opens the wheel itself, not a list, and the wheel closes again. */
  async function expectRadialOpens(surface) {
    const opened = await browser.execute((wanted) => {
      const selector = wanted === 'reader' ? '.email-action-bar .quick-actions[data-surface="reader"]'
        : wanted === 'selection' ? '[data-testid="selection-action-bar"] .quick-actions[data-surface="selection"]'
          : '.quick-actions[data-surface="row"]';
      const root = [...document.querySelectorAll(selector)].find((el) => !el.closest('[data-testid="settings-page"], [data-quick-actions-preview]'));
      const trigger = root?.querySelector('.quick-actions-trigger');
      if (!trigger) return false;
      trigger.click();
      return true;
    }, surface);
    expect(opened).toBe(true);
    const wheel = (wanted) => browser.execute((s) =>
      !!document.querySelector(`.quick-actions-radial[data-surface="${s}"]:not(.quick-actions-radial-preview)`), wanted);
    await browser.waitUntil(() => wheel(surface), { timeout: 5_000, interval: 100, timeoutMsg: `${surface} radial trigger did not open the wheel` });
    // The backdrop is the one element whose click is wired to onClose.
    await browser.execute((s) => document.querySelector(`.quick-actions-radial[data-surface="${s}"]`)?.previousElementSibling?.click(), surface);
    await browser.waitUntil(async () => !(await wheel(surface)), { timeout: 5_000, interval: 100, timeoutMsg: `${surface} wheel did not close` });
  }

  async function expectLayout(surface, mode) {
    await waitForLayout(surface, mode);
    const state = await surfaceState(surface);
    if (mode === 'inline') {
      expect(state.actions.length).toBeGreaterThan(0);
      if (surface === 'reader') {
        expect(state.actions).toContain('reply');
        expect(state.actions).toContain('forward');
      }
      if (surface === 'row') expect(state.trigger).toBe(false);
    } else if (mode === 'menu') {
      expect(state.actions).toEqual([]);
      expect(state.trigger).toBe(true);
      expect(state.triggerText.length).toBeGreaterThan(0);
    } else if (mode === 'favorite-menu') {
      expect(state.actions.length).toBe(1);
      if (surface === 'reader') expect(state.actions).toEqual(['reply']);
      expect(state.trigger).toBe(true);
    } else {
      expect(state.actions).toEqual([]);
      expect(state.trigger).toBe(true);
      expect(state.triggerText).toBe('');
      await expectRadialOpens(surface);
    }
  }

  // ── selection ─────────────────────────────────────────────────────────────
  // The list's own checkboxes and bar, never a sample's.
  const toggleFirstRow = () => browser.execute(() => {
    const box = [...document.querySelectorAll('[data-testid="email-row"] input[type="checkbox"]')]
      .find((el) => !el.closest('[data-quick-actions-preview]'));
    if (!box) return false;
    box.click();
    return true;
  });
  const rowChecked = () => browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"] input[type="checkbox"]:checked')]
    .some((el) => !el.closest('[data-quick-actions-preview]')));
  const selectionShown = () => browser.execute(() => [...document.querySelectorAll('[data-testid="selection-action-bar"]')]
    .some((el) => !el.closest('[data-quick-actions-preview]')));
  async function selectRow() {
    if (await rowChecked()) return;
    expect(await toggleFirstRow()).toBe(true);
    await browser.waitUntil(selectionShown, { timeout: 10_000, interval: 200, timeoutMsg: 'selecting a row showed no selection bar' });
  }
  async function clearSelection() {
    if (!(await rowChecked())) return;
    await toggleFirstRow();
    await browser.waitUntil(async () => !(await rowChecked()),
      { timeout: 10_000, interval: 200, timeoutMsg: 'the row stayed selected' });
  }

  // ── Settings UI ──────────────────────────────────────────────────────────
  async function openQuickActions(surface) {
    await openSettings();
    await browser.pause(300);
    expect(await clickSettingsNav('Appearance')).toBe(true);
    expect(await clickSettingsNav('Quick actions')).toBe(true);
    expect(await clickSettingsNav(SURFACE_TAB[surface])).toBe(true);
  }
  const checkedIn = (group) => browser.execute((name) => {
    const root = document.querySelector('[data-testid="settings-page"][role="dialog"]');
    const radiogroup = root && [...root.querySelectorAll('[role="radiogroup"]')].find((g) => g.getAttribute('aria-label') === name);
    return radiogroup?.querySelector('[role="radio"][aria-checked="true"]')?.textContent.trim() || null;
  }, group);
  async function pick(group, label) {
    const clicked = await browser.execute((name, wanted) => {
      const root = document.querySelector('[data-testid="settings-page"][role="dialog"]');
      const radiogroup = root && [...root.querySelectorAll('[role="radiogroup"]')].find((g) => g.getAttribute('aria-label') === name);
      const radio = radiogroup && [...radiogroup.querySelectorAll('[role="radio"]')].find((r) => r.textContent.trim() === wanted);
      if (!radio || radio.disabled) return false;
      radio.click();
      return true;
    }, group, label);
    expect(clicked).toBe(true);
    await browser.waitUntil(async () => (await checkedIn(group)) === label,
      { timeout: 5_000, interval: 100, timeoutMsg: `${group} never showed ${label}` });
  }
  async function clickSettingsButton(label) {
    const clicked = await browser.execute((wanted) => {
      const root = document.querySelector('[data-testid="settings-page"][role="dialog"]');
      const button = root && [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === wanted && b.offsetHeight > 0);
      if (!button) return false;
      button.click();
      return true;
    }, label);
    expect(clicked).toBe(true);
  }
  const settingsHasButton = (label) => browser.execute((wanted) => {
    const root = document.querySelector('[data-testid="settings-page"][role="dialog"]');
    return !!root && [...root.querySelectorAll('button')].some((b) => b.textContent.trim() === wanted && b.offsetHeight > 0);
  }, label);

  /** The user's setup: rows tab, Current view, style "Use everywhere". */
  async function linkCurrentViewFromRows() {
    await openQuickActions('row');
    await pick('Scope', 'Current view');
    await pick('Style across sections', 'Use everywhere');
    await browser.waitUntil(async () => {
      const keys = Object.keys((await quickActions()).overrides);
      return keys.length === 1 && keys[0] === scopeKey;
    }, { timeout: 5_000, interval: 100, timeoutMsg: 'Use everywhere did not write this view\'s override' });
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    await resetQuickActions();
    // The wheel only renders as a wheel in a window of at least 420 x 430.
    const size = await browser.execute(() => [window.innerWidth, window.innerHeight]);
    expect(size[0] >= 420 && size[1] >= 430).toBe(true);

    const opened = await browser.execute(() => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((el) => !el.closest('[data-quick-actions-preview]'));
      if (!row) return false;
      row.click();
      return true;
    });
    expect(opened).toBe(true);
    await waitForLayout('reader', 'inline');

    // The view's real scope key, made by the app: "Customize this view" on
    // the reader tab, read back, then cleared again.
    await openQuickActions('reader');
    await pick('Scope', 'Current view');
    await clickSettingsButton('Customize this view');
    await browser.waitUntil(async () => Object.keys((await quickActions()).overrides).length === 1,
      { timeout: 5_000, interval: 100, timeoutMsg: 'Customize this view wrote no override' });
    [scopeKey] = Object.keys((await quickActions()).overrides);
    await closeSettings();
    await resetQuickActions();
  });

  afterEach(async function () {
    await closeSettings().catch(() => {});
    await clearSelection().catch(() => {});
    await resetQuickActions();
  });

  after(async function () {
    await closeSettings().catch(() => {});
    await resetQuickActions();
  });

  it('shows the scope that governs this view, and its layout change reaches the reader', async function () {
    await linkCurrentViewFromRows();
    await clickSettingsNav(SURFACE_TAB.reader);
    // The reader is governed by the override "Use everywhere" just wrote.
    expect(await checkedIn('Scope')).toBe('Current view');
    expect(await checkedIn('Layout')).toBe('Radial');
    await pick('Layout', 'Inline');
    await closeSettings();
    await expectLayout('reader', 'inline');

    await openQuickActions('reader');
    expect(await checkedIn('Scope')).toBe('Current view');
    expect(await checkedIn('Layout')).toBe('Inline');
  });

  it('a Current-view override beats an All-views layout', async function () {
    await linkCurrentViewFromRows();
    await clickSettingsNav(SURFACE_TAB.reader);
    await pick('Scope', 'All views');
    await pick('Layout', 'Menu');
    await closeSettings();
    expect((await quickActions()).defaults.reader.mode).toBe('menu');
    await expectLayout('reader', 'radial');
  });

  it('"Use everywhere" carries a layout to the other surfaces of the view, "Set separately" does not', async function () {
    await linkCurrentViewFromRows();
    await pick('Layout', 'Menu');
    let scoped = (await quickActions()).overrides[scopeKey];
    expect(SURFACES.map((s) => scoped[s].mode)).toEqual(['menu', 'menu', 'menu']);
    await closeSettings();
    await expectLayout('row', 'menu');
    await expectLayout('reader', 'menu');

    await openQuickActions('row');
    expect(await checkedIn('Scope')).toBe('Current view');
    await pick('Style across sections', 'Set separately');
    await pick('Layout', 'Favorite plus menu');
    scoped = (await quickActions()).overrides[scopeKey];
    expect(SURFACES.map((s) => scoped[s].mode)).toEqual(['favorite-menu', 'menu', 'menu']);
    await closeSettings();
    await expectLayout('row', 'favorite-menu');
    await expectLayout('reader', 'menu');
  });

  it('"Use all-view defaults" returns the view to the All-views layout', async function () {
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setQuickActionStyle('reader', null, { mode: 'menu' }));
    await linkCurrentViewFromRows();
    await closeSettings();
    await expectLayout('reader', 'radial');

    await openQuickActions('reader');
    expect(await checkedIn('Scope')).toBe('Current view');
    await clickSettingsButton('Use all-view defaults');
    await browser.waitUntil(async () => !(await quickActions()).overrides[scopeKey]?.reader,
      { timeout: 5_000, interval: 100, timeoutMsg: 'the reader kept its Current-view override' });
    // Still on this view's scope, now offering to customize it again.
    expect(await checkedIn('Scope')).toBe('Current view');
    expect(await settingsHasButton('Customize this view')).toBe(true);
    await closeSettings();
    await expectLayout('reader', 'menu');
  });

  for (const surface of SURFACES) {
    for (const mode of MODES) {
      for (const scoped of [false, true]) {
        it(`${surface} x ${mode} x ${scoped ? 'Current view' : 'All views'}`, async function () {
          if (scoped) {
            // All views says something else, so only the override can pass.
            const other = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
            await browser.execute((s, m) => window.__SETTINGS_STORE__.getState().setQuickActionStyle(s, null, { mode: m }), surface, other);
            // The scope as the app keyed it; the round trip below proves no
            // other key was made.
            const [kind, accountId, mailbox, view, viewMode] = JSON.parse(scopeKey);
            await browser.execute((s, scope, m) => window.__SETTINGS_STORE__.getState().setQuickActionStyle(s, scope, { mode: m }),
              surface, { kind, accountId, mailbox, view, viewMode }, mode);
            expect(Object.keys((await quickActions()).overrides)).toEqual([scopeKey]);
          } else {
            await browser.execute((s, m) => window.__SETTINGS_STORE__.getState().setQuickActionStyle(s, null, { mode: m }), surface, mode);
          }
          if (surface === 'selection') await selectRow();
          await expectLayout(surface, mode);
        });
      }
    }
  }

  // The star shows the message's state, like the one beside the sender:
  // starred, the row's Unstar and the reader's Star are drawn filled; not
  // starred, the row's Star and the reader's Star are outlines. Filled and
  // outline stars share their paths; only the svg's fill tells them apart.
  it('a starred message shows the filled star, an unstarred one the outline', async function () {
    const starState = () => browser.execute(() => {
      const real = (el) => !el.closest('[data-testid="settings-page"], [data-quick-actions-preview]');
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((el) => real(el) && el.querySelector('[data-testid="star-toggle"]'));
      if (!row) return null;
      row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      const fill = (root, action) => root?.querySelector(`[data-quick-action="${action}"] svg`)?.getAttribute('fill') ?? null;
      const rowActions = row.querySelector('.quick-actions[data-surface="row"]');
      const reader = [...document.querySelectorAll('.email-action-bar')].find(real);
      return {
        starred: row.querySelector('[data-testid="star-toggle"]')?.getAttribute('aria-pressed') === 'true',
        rowStar: fill(rowActions, 'star'),
        rowUnstar: fill(rowActions, 'unstar'),
        readerStar: fill(reader, 'star'),
      };
    });
    const clickStar = () => browser.execute(() => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((el) => !el.closest('[data-testid="settings-page"], [data-quick-actions-preview]')
          && el.querySelector('[data-testid="star-toggle"]'));
      const star = row?.querySelector('[data-testid="star-toggle"]');
      if (!star) return false;
      star.click();
      return true;
    });
    const waitForStar = (want, why) => browser.waitUntil(async () => {
      const state = await starState();
      return !!state && Object.entries(want).every(([key, value]) => state[key] === value);
    }, { timeout: 10_000, interval: 200, timeoutMsg: why }).catch(async (error) => {
      throw new Error(`${error.message}: ${JSON.stringify(await starState())}`);
    });

    // Every row action inline, so Star and Unstar are buttons on the row.
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setQuickActionStyle('row', null, { mode: 'inline' }));
    // The reader shows the same message as the first single-message row (a
    // conversation row has no star to toggle).
    expect(await browser.execute(() => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find((el) => !el.closest('[data-testid="settings-page"], [data-quick-actions-preview]')
          && el.querySelector('[data-testid="star-toggle"]'));
      row?.click();
      return !!row;
    })).toBe(true);
    await waitForLayout('reader', 'inline');
    if ((await starState())?.starred) {
      expect(await clickStar()).toBe(true);
      await waitForStar({ starred: false }, 'the first message never lost its star');
    }
    try {
      await waitForStar({ rowStar: 'none', rowUnstar: null, readerStar: 'none' },
        'an unstarred message did not show outline stars');
      expect(await clickStar()).toBe(true);
      await waitForStar({ starred: true, rowStar: null, rowUnstar: 'currentColor', readerStar: 'currentColor' },
        'a starred message did not show filled stars');
    } finally {
      if ((await starState())?.starred) {
        await clickStar();
        await waitForStar({ starred: false }, 'the message kept the star this test gave it').catch(() => {});
      }
    }
  });
});
