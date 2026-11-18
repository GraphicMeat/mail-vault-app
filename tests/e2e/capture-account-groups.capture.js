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

async function assignedGroup(accountId, expected) {
  await wait(() => browser.execute(id => window.__SETTINGS_STORE__.getState().accountGroups[id], accountId)
    .then(name => expected == null ? name == null : name === expected), `Expected account group ${expected || '(none)'}`);
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

async function captureScreen(name, selector, capture, activateAppWindow) {
  await wait(() => browser.execute(value => {
    const element = document.querySelector(value);
    return !!element && element.getBoundingClientRect().height > 0;
  }, selector), `${name}: ${selector} not reached`);
  await dismissOnboardingNotice();
  await browser.execute(() => {
    document.querySelectorAll('[data-capture-exclude][role="alert"] button[aria-label]').forEach(button => button.click());
  });
  activateAppWindow();
  await browser.pause(500);
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
    await browser.executeAsync(done => window.__TAURI_INTERNALS__.invoke('daemon_rpc', {
      method: 'tags.ensure', params: { name: 'Capture tag', color: '' },
    }).then(() => done(null), error => done(String(error)))).then(error => assert.equal(error, null));
    await wait(() => browser.execute(() => !!document.querySelector('.sidebar-account-list [role="group"][aria-label="Work"]')),
      'Grouped sidebar did not render');
    const out = resolve(process.env.HARNESS_SHOTS_OUT || '.artifacts');
    mkdirSync(out, { recursive: true });
    process.env.SHOTS_APP_BINARY = resolve('target/debug/mailvault');
    process.env.SHOTS_OUT = out;
    const { capture, activateAppWindow } = await import('../../scripts/screenshots/capture.js');
    for (const theme of ['light', 'dark']) {
      await setMode(theme);
      await captureScreen(`sidebar-account-groups-${theme}`, '.sidebar-account-list [role="group"][aria-label="Work"]', capture, activateAppWindow);
      await openSettings();
      assert.equal(await clickSettingsNav('Accounts'), true);
      await wait(() => browser.execute(() => !!document.querySelector('.account-settings-list')
        && !!document.querySelector('input[id^="account-group-"]')), 'Account group settings did not render');
      const accountButtons = await $$('.account-settings-account-button');
      await accountButtons[1].click();
      await wait(() => browser.execute(() => document.querySelector('.account-group-field [data-testid="account-group-chip"]')?.getAttribute('aria-label') === 'Remove Work'
        && !!document.querySelector('.account-group-field [role="group"][aria-label="Existing groups"]')),
      'Work account group picker did not render');
      await captureScreen(`settings-account-group-${theme}`, '.account-group-field [data-testid="account-group-chip"]', capture, activateAppWindow);
      await setGroupDraft('Stu');
      await wait(() => browser.execute(() => [...document.querySelectorAll('.typeahead-list [role="option"]')]
        .some(option => option.textContent.includes('Create') && option.textContent.includes('Stu'))),
      'Create Stu option did not render');
      await captureScreen(`settings-account-group-create-${theme}`, '.typeahead-list [role="option"]', capture, activateAppWindow);
      await $('.typeahead-list [role="option"]:last-child').click();
      await assignedGroup(workOne.id, 'Stu');
      await $('.account-group-field [data-testid="account-group-chip"]').click();
      await assignedGroup(workOne.id, undefined);
      await setGroupDraft('Wo');
      await $('.typeahead-list [role="option"]:first-child').click();
      await assignedGroup(workOne.id, 'Work');
      await $('.account-group-cloud button').click();
      await assignedGroup(workOne.id, 'Personal');
      assert.equal(await browser.execute(() => document.querySelector('.account-group-cloud button')?.getAttribute('aria-pressed')), 'true');
      await $('.account-group-cloud button').click();
      await assignedGroup(workOne.id, undefined);
      await $('.account-group-cloud button:last-child').click();
      await assignedGroup(workOne.id, 'Work');
      await browser.setWindowRect(0, 0, 375, 800);
      assert.equal(await browser.execute(() => innerWidth), 375, 'Narrow capture must have a 375px webview');
      await browser.pause(250);
      await browser.execute(() => {
        const cloud = document.querySelector('.account-group-cloud');
        const scroller = document.querySelector('.account-settings-detail [role="tabpanel"]');
        scroller.scrollTop += Math.max(0, cloud.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 60);
      });
      await wait(() => browser.execute(() => document.querySelector('.account-group-cloud').getBoundingClientRect().bottom
        <= document.querySelector('.account-settings-detail [role="tabpanel"]').getBoundingClientRect().bottom),
        'Group cloud did not fit in the narrow window');
      await captureScreen(`settings-account-group-mobile-${theme}`, '.account-group-field [role="group"]', capture, activateAppWindow);
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
      await captureScreen(`sidebar-collapsed-groups-${theme}`, '.sidebar-collapsed-accounts .sidebar-collapsed-divider', capture, activateAppWindow);
      await browser.execute(() => window.__SETTINGS_STORE__.setState({ sidebarCollapsed: false }));
      await wait(() => browser.execute(() => !!document.querySelector('.sidebar-account-list [role="group"][aria-label="Work"]')),
        'Expanded sidebar did not return');
      await openSettings();
      assert.equal(await clickSettingsNav('Views'), true);
      await wait(() => browser.execute(() => !!document.querySelector('[data-testid="views-row-builtin-starred"]')),
        'Starter view did not load');
      await $('[data-testid="views-row-builtin-starred"]').click();
      await wait(() => browser.execute(() => !!document.querySelector('#view-tags')),
        'View tag picker did not render');
      await browser.execute(() => {
        const input = document.querySelector('#view-tags');
        input.scrollIntoView({ block: 'center' });
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Capture');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await wait(() => browser.execute(() => !!document.querySelector('.view-editor .typeahead-list [role="option"]')),
        'View tag option did not render');
      await $('.view-editor .typeahead-list [role="option"]').click();
      await wait(() => browser.execute(() => !!document.querySelector('.view-editor .typeahead-chip button[aria-label="Remove Capture tag"]')),
        'View tag chip did not render');
      await captureScreen(`settings-view-tags-${theme}`, '.view-editor .typeahead-chip button', capture, activateAppWindow);
      await $('.view-editor .typeahead-chip button').click();
      await closeSettings();
    }
  });
});
