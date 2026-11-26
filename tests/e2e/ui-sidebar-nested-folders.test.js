/**
 * E2E: the "Folders under account" sidebar layout.
 *
 * Picks the layout through its visible Settings card, then checks the folder
 * selector opens directly below the selected account inside the account list,
 * that a folder opens from there, and that Stacked brings the Folders section
 * back.
 */

import assert from 'node:assert/strict';
import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { clickReachable } from './insightsHelpers.js';

async function pickLayout(label) {
  await openSettings();
  assert.equal(await clickSettingsNav('Appearance'), true);
  await clickReachable('[data-testid="settings-page"] [role="tab"][id$="-layout"]');
  await clickReachable(`[data-testid="settings-page"] button[aria-label="${label}"]`);
  await closeSettings();
}

const placement = () => browser.execute(() => {
  const list = document.querySelector('[data-testid="sidebar-account-list"]');
  const selector = document.querySelector('[data-testid="folder-selector"]');
  const selected = list?.querySelector('.sidebar-account-selected');
  return {
    layout: document.querySelector('[data-sidebar-layout]')?.dataset.sidebarLayout,
    inList: !!(list && selector && list.contains(selector)),
    afterSelected: !!(selected && selector && (selected.compareDocumentPosition(selector) & Node.DOCUMENT_POSITION_FOLLOWING)),
    newFolderOnRow: !!selected?.querySelector('[data-testid="new-folder-btn"]'),
    heading: [...document.querySelectorAll('.sidebar-folder-section h2')].length,
    rows: selector ? selector.querySelectorAll('[data-testid="folder-row"]').length : 0,
  };
});

describe('Sidebar: folders under the account', function () {
  this.timeout(120000);
  let ready = false;

  before(async function () {
    ready = (await waitForApp()) === 'ready';
    if (!ready) this.skip();
    await waitForEmails();
  });

  after(async function () {
    if (ready) await pickLayout('Stacked');
  });

  it('opens source filter, folder search and folders below the selected account', async () => {
    await pickLayout('Folders under account');
    await browser.waitUntil(async () => (await placement()).layout === 'nested', { timeout: 5000 });
    // An account, not All Inboxes, so the row carries New folder.
    await browser.execute(() => {
      const row = document.querySelector('[data-testid="sidebar-account-list"] .sidebar-account-open');
      row?.click();
    });
    await browser.waitUntil(async () => (await placement()).afterSelected, { timeout: 5000 });
    const shown = await placement();
    assert.ok(shown.inList, `selector not in the account list: ${JSON.stringify(shown)}`);
    assert.ok(shown.newFolderOnRow, `New folder missing on the selected row: ${JSON.stringify(shown)}`);
    assert.equal(shown.heading, 0);
    assert.ok(shown.rows > 0);
    assert.equal(await browser.execute(() => !!document.querySelector('[data-testid="folder-selector"] input[type="search"]')), true);
  });

  it('opens a folder from the nested list', async () => {
    // DOM only: ui-* specs run in CI without the e2e store seam.
    const target = await browser.execute(() => {
      const rows = [...document.querySelectorAll('[data-testid="folder-selector"] [data-testid="folder-row"]')];
      return rows.find(r => r.dataset.path && r.getAttribute('aria-current') !== 'true')?.dataset.path || null;
    });
    assert.ok(target, 'no second folder to open');
    await clickReachable(`[data-testid="folder-selector"] [data-testid="folder-row"][data-path="${target}"]`);
    await browser.waitUntil(() => browser.execute(p => document.querySelector(
      `[data-testid="folder-selector"] [data-testid="folder-row"][data-path="${CSS.escape(p)}"]`)?.getAttribute('aria-current') === 'true', target), { timeout: 10000 });
  });

  it('brings the Folders section back with Stacked', async () => {
    await pickLayout('Stacked');
    await browser.waitUntil(async () => (await placement()).layout === 'stacked', { timeout: 5000 });
    const shown = await placement();
    assert.equal(shown.inList, false);
    assert.equal(shown.heading, 1);
  });
});
