import assert from 'node:assert/strict';
import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { clickReachable, setControl, openInsights, waitForInsights, setInsightsRange,
  nativeInvoke, cacheScenarioHeaders, captureInsights, summaryText, startNativeProbe, stopNativeProbe, nativeProbeOutcomes } from './insightsHelpers.js';

async function assertNoWindowOverflow() {
  const dimensions = await browser.execute(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth,
    page: document.querySelector('[data-testid="insights-page"]')?.getBoundingClientRect().toJSON() }));
  assert.ok(dimensions.scroll <= dimensions.inner + 1, `App overflow: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.page && dimensions.page.right <= dimensions.inner + 1);
}

async function appearanceSection(section) {
  await openSettings();
  assert.equal(await clickSettingsNav('Appearance'), true);
  await clickReachable(`[data-testid="settings-page"] [role="tab"][id$="-${section}"]`);
}

async function ensureInsightsOpen() {
  if (await browser.execute(() => !!document.querySelector('[data-testid="insights-page"]'))) await waitForInsights();
  else await openInsights();
}

describe('Insights native workspace and responsive states', function () {
  this.timeout(240000);
  before(async () => { await waitForApp(); await waitForEmails(); await cacheScenarioHeaders(); });
  beforeEach(async () => { await startNativeProbe(); });
  afterEach(async function () {
    const outcomes = await nativeProbeOutcomes();
    console.log(`[insights] UI native outcomes (${this.currentTest.title}):`, JSON.stringify(outcomes));
    if (this.currentTest.state === 'failed' && await browser.execute(() => !!document.querySelector('[data-testid="insights-page"]'))) {
      try { await captureInsights(`ui-failure-${this.currentTest.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}`); } catch (error) { console.log('[insights] Failure capture:', error.message); }
    }
    await stopNativeProbe();
  });

  it('enters and returns from each sidebar layout through the visible control', async () => {
    for (const [layout, label] of [['stacked', 'Stacked'], ['split', 'Split sections'], ['switcher', 'Account switcher']]) {
      await appearanceSection('layout');
      await clickReachable(`[data-testid="settings-page"] button[aria-label="${label}"]`);
      await closeSettings();
      const before = await browser.execute(() => ({ mailbox: window.__MAIL_STORE__?.getState().activeMailbox,
        account: window.__MAIL_STORE__?.getState().activeAccountId,
        layout: document.querySelector('[data-sidebar-layout]')?.dataset.sidebarLayout }));
      assert.equal(before.layout, layout);
      assert.ok(before.account && before.mailbox, 'Read actual mailbox state before opening Insights');
      await openInsights(); await setInsightsRange();
      await clickReachable('[data-testid="insights-close"]');
      assert.equal(await browser.execute(() => !!document.querySelector('[data-testid="insights-page"]')), false);
      const after = await browser.execute(() => ({ mailbox: window.__MAIL_STORE__?.getState().activeMailbox, account: window.__MAIL_STORE__?.getState().activeAccountId }));
      assert.equal(after.mailbox, before.mailbox); assert.equal(after.account, before.account);
    }
  });

  it('preserves a live search and the Explorer location/filter across Insights visits', async () => {
    await clickReachable('[data-testid="mail-search-toggle"]');
    await setControl('[data-testid="mail-search-input"]', 'Inventory');
    await clickReachable('#mail-search-panel button[type="submit"]');
    await browser.waitUntil(() => browser.execute(() => window.__SEARCH_STORE__?.getState().searchActive === true && !window.__SEARCH_STORE__.getState().isSearching), { timeout: 30000 });
    const beforeSearch = await browser.execute(() => ({ query: window.__SEARCH_STORE__.getState().searchQuery,
      active: window.__SEARCH_STORE__.getState().searchActive, count: window.__SEARCH_STORE__.getState().searchResults.length }));
    assert.ok(beforeSearch.count > 0, 'Real search produced mail before leaving');
    await openInsights(); await setInsightsRange(); await clickReachable('[data-testid="insights-close"]');
    assert.deepEqual(await browser.execute(() => ({ query: window.__SEARCH_STORE__.getState().searchQuery,
      active: window.__SEARCH_STORE__.getState().searchActive, count: window.__SEARCH_STORE__.getState().searchResults.length })), beforeSearch);
    await clickReachable('[data-testid="mail-view-explorer"]');
    await setControl('[data-testid="explorer-grouping"]', 'sender');
    await clickReachable('[data-testid="explorer-group-open"]');
    await setControl('[data-testid="explorer-search"]', 'Inventory');
    const beforeExplorer = await browser.execute(() => ({ grouping: document.querySelector('[data-testid="explorer-grouping"]').value,
      query: document.querySelector('[data-testid="explorer-search"]').value,
      crumbs: document.querySelector('.explorer-breadcrumbs').textContent }));
    assert.ok(beforeExplorer.crumbs.length > 0);
    await openInsights(); await clickReachable('[data-testid="insights-close"]');
    assert.deepEqual(await browser.execute(() => ({ grouping: document.querySelector('[data-testid="explorer-grouping"]').value,
      query: document.querySelector('[data-testid="explorer-search"]').value,
      crumbs: document.querySelector('.explorer-breadcrumbs').textContent })), beforeExplorer);
    await clickReachable('[data-testid="mail-view-list"]');
    await setControl('[data-testid="mail-search-input"]', '');
    await clickReachable('#mail-search-panel button[type="submit"]');
    await browser.waitUntil(() => browser.execute(() => !window.__SEARCH_STORE__?.getState().searchActive
      && !window.__SEARCH_STORE__?.getState().isSearching), { timeout: 10000 });
  });

  it('returns to the ordinary mail workspace when an account is selected from Insights', async () => {
    await appearanceSection('layout');
    await clickReachable('[data-testid="settings-page"] button[aria-label="Stacked"]');
    await closeSettings();
    await openInsights();
    try {
      await clickReachable(`[data-testid="sidebar"] .sidebar-account-open[aria-label*="${browser.mockAccounts[1].email}"]`);
      await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-testid="insights-page"]')), {
        timeout: 5000, interval: 100, timeoutMsg: 'Selecting an ordinary account left Insights covering the mail workspace',
      });
      assert.equal(await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId), browser.mockAccounts[1].id);
    } finally {
      if (await browser.execute(() => !!document.querySelector('[data-testid="insights-page"]'))) await clickReachable('[data-testid="insights-close"]');
    }
  });

  it('returns to the ordinary mail workspace when its current folder is selected from Insights', async () => {
    await openInsights();
    try {
      await clickReachable('[data-testid="sidebar-folder-list"] [role="button"][title="INBOX"]');
      await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-testid="insights-page"]')), {
        timeout: 5000, interval: 100, timeoutMsg: 'Selecting an ordinary folder left Insights covering the mail workspace',
      });
      assert.equal(await browser.execute(() => window.__MAIL_STORE__.getState().activeMailbox), 'INBOX');
    } finally {
      if (await browser.execute(() => !!document.querySelector('[data-testid="insights-page"]'))) await clickReachable('[data-testid="insights-close"]');
    }
  });

  it('keeps the collapsed entry reachable and uses the sender list at narrow widths', async () => {
    await clickReachable('button[title="Collapse sidebar"]');
    await openInsights(); await setInsightsRange();
    await captureInsights('collapsed-sidebar');
    await clickReachable('[data-testid="insights-close"]');
    await clickReachable('button[title="Expand sidebar"]');
    await browser.setWindowSize(720, 900);
    await openInsights(); await setInsightsRange();
    await assertNoWindowOverflow(); await captureInsights('720-map-list');
    await clickReachable('[data-testid="insights-tab-activity"]');
    await setInsightsRange('2026-01-01', '2026-12-31');
    await assertNoWindowOverflow();
    const dailyBounds = await browser.execute(() => {
      const calendar = document.querySelector('.insights-calendar').getBoundingClientRect();
      return { right: calendar.right, dates: [...document.querySelectorAll('.insights-calendar-day')].map(day => ({
        date: day.dataset.date, right: day.getBoundingClientRect().right,
      })) };
    });
    assert.ok(dailyBounds.dates.every(day => day.right <= dailyBounds.right + 1), 'Every annual date fits the calendar content without hidden horizontal overflow');
    await captureInsights('720-activity');
    await browser.setWindowSize(600, 900);
    await browser.waitUntil(() => browser.execute(() => innerWidth <= 620), { timeout: 5000 });
    await assertNoWindowOverflow();
    const calendar = await browser.execute(() => ({ groups: document.querySelectorAll('.insights-calendar-block').length,
      dates: [...document.querySelectorAll('button[data-date]')].map(button => button.dataset.date),
      width: document.querySelector('.insights-calendar')?.getBoundingClientRect().width }));
    assert.equal(calendar.groups, 4); assert.equal(calendar.dates.length, 365); assert.equal(new Set(calendar.dates).size, 365);
    console.log('[insights] narrow calendar content width:', calendar.width);
    await captureInsights('narrow-activity');
    await browser.setWindowSize(1200, 900);
  });

  it('renders the actual light/dark and Indigo/Graphite controls without changing date counts', async () => {
    await browser.setWindowSize(1200, 900);
    await ensureInsightsOpen();
    await setInsightsRange('2026-01-01', '2026-12-31');
    for (const [theme, palette] of [['Light', 'Indigo'], ['Dark', 'Indigo'], ['Dark', 'Graphite'], ['Light', 'Graphite']]) {
      await appearanceSection('colors');
      await clickReachable(`[data-testid="settings-page"] button[aria-label="${theme}"]`);
      await clickReachable(`[data-testid="settings-page"] button[aria-label="${palette}"]`);
      await closeSettings();
      const applied = await browser.execute(() => ({ theme: document.documentElement.dataset.theme, palette: document.documentElement.dataset.palette }));
      assert.equal(applied.theme, theme.toLowerCase()); assert.equal(applied.palette, palette.toLowerCase());
      await clickReachable('[data-testid="insights-tab-activity"]');
      assert.equal(await browser.execute(() => document.querySelectorAll('button[data-date]').length), 365);
      await assertNoWindowOverflow();
      await captureInsights(`${theme.toLowerCase()}-${palette.toLowerCase()}`);
    }
  });

  it('runs tab and calendar keyboard handlers and restores focus after closing date details', async () => {
    await ensureInsightsOpen();
    await setInsightsRange();
    await clickReachable('[data-testid="insights-tab-map"]');
    await browser.execute(() => {
      const map = document.querySelector('[data-testid="insights-tab-map"]');
      map.focus(); map.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    assert.equal(await browser.execute(() => document.activeElement?.getAttribute('data-testid')), 'insights-tab-activity');
    await browser.execute(() => {
      const day = document.querySelector('button[data-date="2026-09-01"]');
      day.focus(); day.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    assert.equal(await browser.execute(() => document.activeElement?.dataset.date), '2026-09-08');
    await browser.execute(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="insights-matches"]')), { timeout: 15000 });
    await clickReachable('[data-testid="insights-close-matches"]');
    await browser.waitUntil(() => browser.execute(() => document.activeElement?.dataset.date === '2026-09-08'), { timeout: 5000 });
    console.log('[insights] Keyboard checks cover app handlers and focus; synthetic events are not trusted physical native activation.');
  });

  it('keeps saved scope and tab through a real WebView reload without persisting mail data', async () => {
    await ensureInsightsOpen();
    await setInsightsRange();
    await setControl('[data-testid="insights-direction"]', 'both'); await waitForInsights();
    await clickReachable('[data-testid="insights-tab-timeline"]');
    await browser.waitUntil(async () => {
      const settings = JSON.parse(await nativeInvoke('read_settings_json', {}));
      return settings['mailvault-settings']?.state?.insightsPreferences?.tab === 'timeline';
    }, { timeout: 10000, interval: 200 });
    const settings = JSON.parse(await nativeInvoke('read_settings_json', {}));
    const preferences = settings['mailvault-settings'].state.insightsPreferences;
    assert.equal(preferences.direction, 'both'); assert.equal(preferences.startDate, '2026-09-01');
    assert.equal(Object.keys(preferences).some(key => /headers|messages|copies|coverage|progress|selectedDay/i.test(key)), false);
    await browser.execute(() => location.reload());
    await waitForApp(); await startNativeProbe(); await openInsights();
    assert.equal(await browser.execute(() => document.querySelector('[data-testid="insights-direction"]').value), 'both');
    assert.equal(await browser.execute(() => document.querySelector('[data-testid="insights-tab-timeline"]').getAttribute('aria-selected')), 'true');
    await setInsightsRange('2000-01-01', '2000-01-31');
    assert.match((await summaryText()).total, /0/);
    assert.ok(await browser.execute(() => document.querySelector('.insights-empty')?.textContent.length > 0));
    await captureInsights('empty-range');
  });

  it('keeps German labels and controls inside the narrow workspace', async () => {
    await ensureInsightsOpen();
    await openSettings();
    assert.equal(await clickSettingsNav('Language'), true);
    await clickReachable('[data-testid="language-row-de"]');
    await closeSettings();
    await browser.setWindowSize(720, 900);
    await setInsightsRange();
    await clickReachable('[data-testid="insights-tab-activity"]');
    await assertNoWindowOverflow();
    const labels = await browser.execute(() => [...document.querySelectorAll('[data-testid="insights-page"] input, [data-testid="insights-page"] select, .insights-tabs button')].filter(node => node.offsetHeight > 0).map(node => ({ right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width })));
    assert.ok(labels.every(label => label.width > 0 && label.right <= 721));
    await captureInsights('german-narrow');
  });
});
