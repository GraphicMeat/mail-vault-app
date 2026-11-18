import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForApp, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { raiseWindow } from '../../scripts/screenshots/window.js';
import { dismissOnboardingNotice } from './insightsHelpers.js';

const wait = (predicate, message) => browser.waitUntil(predicate, { timeout: 15000, interval: 100, timeoutMsg: message });

async function setMode(theme) {
  await browser.execute(value => {
    if (document.documentElement.getAttribute('data-theme') === value) return;
    [...document.querySelectorAll('button')]
      .find(button => /^switch to (light|dark) mode$/i.test((button.getAttribute('aria-label') || button.title || '').trim()))
      ?.click();
  }, theme);
  await wait(() => browser.execute(value => document.documentElement.getAttribute('data-theme') === value, theme), `Theme ${theme} did not apply`);
}

async function captureScreen(name, capture) {
  await browser.pause(300);
  await dismissOnboardingNotice();
  await browser.execute(() => {
    document.querySelectorAll('[data-capture-exclude][role="alert"] button[aria-label]').forEach(button => button.click());
  });
  await browser.pause(250);
  capture(name);
  const selector = name.startsWith('sidebar-account-groups-')
    ? '.sidebar-account-list [role="group"][aria-label="Work"]'
    : name.startsWith('settings-account-group-')
      ? '.account-settings-list input[id^="account-group-"]'
      : '.sidebar-collapsed-accounts .sidebar-collapsed-divider';
  writeFileSync(resolve(process.env.HARNESS_SHOTS_OUT || '.artifacts', `${name.replace(/-(light|dark)$/, '')}.reached`), `${selector}\n`);
}

describe('Account groups capture', function () {
  this.timeout(180000);

  it('captures grouped sidebar, settings, and collapsed rail', async () => {
    assert.equal(await waitForApp(), 'ready');
    await dismissOnboardingNotice();
    assert.ok(browser.mockAccounts.length >= 3, 'Three mock accounts required');
    assert.equal(await raiseWindow(1280, 1000), 'ok');
    const [personal, workOne, workTwo] = browser.mockAccounts;
    await browser.execute((a, b, c) => window.__SETTINGS_STORE__.setState({
      language: 'en', sidebarLayout: 'stacked', sidebarCollapsed: false,
      hiddenAccounts: {}, accountOrder: [a, b, c],
      accountGroups: { [a]: 'Personal', [b]: 'Work', [c]: 'Work' },
      displayNames: { [a]: 'Personal mail', [b]: 'Work mail', [c]: 'Team mail' },
      unreadPerAccount: { [a]: 3, [b]: 7 },
    }), personal.id, workOne.id, workTwo.id);
    await wait(() => browser.execute(() => !!document.querySelector('.sidebar-account-list [role="group"][aria-label="Work"]')),
      'Grouped sidebar did not render');
    const out = resolve(process.env.HARNESS_SHOTS_OUT || '.artifacts');
    mkdirSync(out, { recursive: true });
    process.env.SHOTS_APP_BINARY = resolve('target/debug/mailvault');
    process.env.SHOTS_OUT = out;
    const { capture } = await import('../../scripts/screenshots/capture.js');
    for (const theme of ['light', 'dark']) {
      await setMode(theme);
      await captureScreen(`sidebar-account-groups-${theme}`, capture);
      await openSettings();
      assert.equal(await clickSettingsNav('Accounts'), true);
      await wait(() => browser.execute(() => !!document.querySelector('.account-settings-list')
        && !!document.querySelector('input[id^="account-group-"]')), 'Account group settings did not render');
      await captureScreen(`settings-account-group-${theme}`, capture);
      await closeSettings();
      await browser.execute(() => window.__SETTINGS_STORE__.setState({ sidebarCollapsed: true }));
      await wait(() => browser.execute(emails => {
        const rail = document.querySelector('.sidebar-collapsed-accounts');
        const divider = rail?.querySelector('.sidebar-collapsed-divider');
        const rows = emails.map(email => [...(rail?.querySelectorAll('button[aria-label]') || [])]
          .find(button => button.getAttribute('aria-label').includes(email)));
        if (!divider || rows.some(row => !row)) return false;
        const visible = element => {
          element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          const item = element.getBoundingClientRect();
          const pane = rail.getBoundingClientRect();
          return item.top >= pane.top && item.bottom <= pane.bottom;
        };
        const allVisibleInTurn = rows.every(visible);
        return allVisibleInTurn && visible(divider);
      }, browser.mockAccounts.slice(0, 3).map(account => account.email)), 'Collapsed avatars and divider must each be reachable');
      await captureScreen(`sidebar-collapsed-groups-${theme}`, capture);
      await browser.execute(() => window.__SETTINGS_STORE__.setState({ sidebarCollapsed: false }));
      await wait(() => browser.execute(() => !!document.querySelector('.sidebar-account-list [role="group"][aria-label="Work"]')),
        'Expanded sidebar did not return');
    }
  });
});
