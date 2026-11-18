import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForApp, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { dismissOnboardingNotice } from './insightsHelpers.js';

const wait = (predicate, message) => browser.waitUntil(predicate, { timeout: 15000, interval: 100, timeoutMsg: message });

async function setGroupDraft(value) {
  await browser.execute(text => {
    const input = document.querySelector('input[id^="account-group-"]');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function setMode(theme) {
  await browser.execute(value => {
    if (document.documentElement.getAttribute('data-theme') === value) return;
    [...document.querySelectorAll('button')]
      .find(button => /^switch to (light|dark) mode$/i.test((button.getAttribute('aria-label') || button.title || '').trim()))
      ?.click();
  }, theme);
  await wait(() => browser.execute(value => document.documentElement.getAttribute('data-theme') === value, theme), `Theme ${theme} did not apply`);
}

async function captureScreen(name, selector, capture) {
  await wait(() => browser.execute(value => {
    const element = document.querySelector(value);
    return !!element && element.getBoundingClientRect().height > 0;
  }, selector), `${name}: ${selector} not reached`);
  await browser.pause(300);
  await dismissOnboardingNotice();
  await browser.execute(() => {
    document.querySelectorAll('[data-capture-exclude][role="alert"] button[aria-label]').forEach(button => button.click());
  });
  await browser.pause(250);
  capture(name);
  writeFileSync(resolve(process.env.HARNESS_SHOTS_OUT || '.artifacts', `${name.slice(0, name.lastIndexOf('-'))}.reached`), `${selector}\n`);
}

describe('Account groups capture', function () {
  this.timeout(180000);

  it('captures grouped sidebar, settings, and collapsed rail', async () => {
    assert.equal(await waitForApp(), 'ready');
    await dismissOnboardingNotice();
    assert.ok(browser.mockAccounts.length >= 3, 'Three mock accounts required');
    await browser.setWindowRect(0, 0, 1280, 1000);
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
      await captureScreen(`sidebar-account-groups-${theme}`, '.sidebar-account-list [role="group"][aria-label="Work"]', capture);
      await openSettings();
      assert.equal(await clickSettingsNav('Accounts'), true);
      await wait(() => browser.execute(() => !!document.querySelector('.account-settings-list')
        && !!document.querySelector('input[id^="account-group-"]')), 'Account group settings did not render');
      const accountButtons = await $$('.account-settings-account-button');
      await accountButtons[1].click();
      await wait(() => browser.execute(() => document.querySelector('.account-group-field [data-testid="account-group-chip"]')?.getAttribute('aria-label') === 'Remove Work'
        && !!document.querySelector('.account-group-field [role="group"][aria-label="Existing groups"]')),
      'Work account group picker did not render');
      await captureScreen(`settings-account-group-${theme}`, '.account-group-field [data-testid="account-group-chip"]', capture);
      await setGroupDraft('Stu');
      await wait(() => browser.execute(() => [...document.querySelectorAll('.typeahead-list [role="option"]')]
        .some(option => option.textContent.includes('Create') && option.textContent.includes('Stu'))),
      'Create Stu option did not render');
      await captureScreen(`settings-account-group-create-${theme}`, '.typeahead-list [role="option"]', capture);
      await setGroupDraft('');
      await browser.execute(() => document.querySelector('input[id^="account-group-"]').blur());
      await browser.setWindowRect(0, 0, 375, 800);
      await browser.pause(250);
      await browser.execute(() => {
        const cloud = document.querySelector('.account-group-cloud');
        const scroller = document.querySelector('.account-settings-detail [role="tabpanel"]');
        scroller.scrollTop += Math.max(0, cloud.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 60);
      });
      await wait(() => browser.execute(() => document.querySelector('.account-group-cloud').getBoundingClientRect().bottom
        <= document.querySelector('.account-settings-detail [role="tabpanel"]').getBoundingClientRect().bottom),
        'Group cloud did not fit in the narrow window');
      await captureScreen(`settings-account-group-mobile-${theme}`, '.account-group-field [role="group"]', capture);
      await browser.setWindowRect(0, 0, 1280, 1000);
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
      await captureScreen(`sidebar-collapsed-groups-${theme}`, '.sidebar-collapsed-accounts .sidebar-collapsed-divider', capture);
      await browser.execute(() => window.__SETTINGS_STORE__.setState({ sidebarCollapsed: false }));
      await wait(() => browser.execute(() => !!document.querySelector('.sidebar-account-list [role="group"][aria-label="Work"]')),
        'Expanded sidebar did not return');
    }
  });
});
