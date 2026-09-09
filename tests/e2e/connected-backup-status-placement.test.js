/**
 * Backup status placement in the compiled macOS app. Schedule health is a
 * deterministic fixture in the normal E2E store seam; placement changes use
 * Appearance controls. The runner supplies mock accounts and an isolated HOME.
 * No backup is due during this spec and no real account or keychain is used.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir } from './mockImap.js';
import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

const LUKE = '11111111-1111-4111-8111-111111111111';
const VADER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'luke@mock.test';
const wait = (predicate, message) => browser.waitUntil(predicate, { timeout: 15000, interval: 100, timeoutMsg: message });

async function choose(label) {
  assert.equal(await browser.execute(wanted => {
    const root = document.querySelector('[data-testid="settings-page"][role="dialog"]');
    const button = root && [...root.querySelectorAll('button')].find(el =>
      (el.getAttribute('aria-label') || el.textContent.trim()) === wanted
      && el.offsetHeight > 0 && !el.disabled && !el.closest('[hidden], [inert]'));
    if (!button) return false;
    button.scrollIntoView({ block: 'center', behavior: 'instant' });
    button.click();
    return true;
  }, label), true, `Missing Appearance choice: ${label}`);
  await wait(() => browser.execute(wanted => [...document.querySelectorAll('[data-testid="settings-page"] button[aria-pressed="true"]')]
    .some(el => (el.getAttribute('aria-label') || el.textContent.trim()) === wanted), label), `${label} was not selected`);
}

async function layoutSettings() {
  await openSettings();
  assert.equal(await clickSettingsNav('Appearance'), true);
  assert.equal(await clickSettingsNav('Layout'), true);
}

function rowGeometry() {
  return browser.execute(email => {
    const open = [...document.querySelectorAll('.mail-sidebar .sidebar-account-open')]
      .find(el => el.title.includes(email));
    if (!open) return null;
    const row = open.closest('.sidebar-account-row');
    const badge = row.querySelector('.sidebar-backup-status');
    const avatar = row.querySelector('.sidebar-account-avatar').getBoundingClientRect();
    const label = row.querySelector('.sidebar-account-label').getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const icon = badge?.querySelector('svg').getBoundingClientRect();
    const target = badge?.getBoundingClientRect();
    return {
      location: badge?.dataset.location || 'hidden', labelWidth: label.width,
      avatarLeft: avatar.left, avatarRight: avatar.right, labelLeft: label.left,
      rowRight: bounds.right, rowTop: bounds.top, rowBottom: bounds.bottom,
      iconLeft: icon?.left, iconRight: icon?.right,
      targetWidth: target?.width, targetHeight: target?.height,
      targetTop: target?.top, targetBottom: target?.bottom,
      separateButton: badge ? !open.contains(badge) && badge.tagName === 'BUTTON' : true,
      health: badge?.dataset.health, color: badge && getComputedStyle(badge).color,
    };
  }, EMAIL);
}

function diskSettings() {
  try {
    return JSON.parse(readFileSync(join(appDataDir(browser.testDataDir), 'frontend-settings.json'), 'utf8'))['mailvault-settings']?.state;
  } catch { return null; }
}

// tauri-plugin-webdriver-automation 0.1.3 dispatches untrusted KeyboardEvents,
// so Enter never performs a native button's default click. Check the button's
// focus contract and real click action without pretending to test that default.
async function clickBackup(selector) {
  assert.equal(await browser.execute(sel => {
    const button = document.querySelector(sel);
    if (!button || button.closest('[inert], [hidden]')) return false;
    button.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    button.focus({ preventScroll: true });
    if (document.activeElement !== button || button.tagName !== 'BUTTON' || button.tabIndex < 0
      || !button.getAttribute('aria-label')) return false;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (hit !== button && !button.contains(hit)) return false;
    button.click();
    return true;
  }, selector), true, `Backup button is not independently reachable: ${selector}`);
  await wait(() => browser.execute(() => document.querySelector('[data-testid="settings-content"]')?.dataset.page === 'backup'), 'Backup details did not open');
  await wait(() => browser.execute(email => [...document.querySelectorAll('[data-testid="settings-content"] .ring-2')]
    .some(el => el.textContent.includes(email)), EMAIL), 'Backup details did not highlight the requested account');
}

describe('Sidebar backup status placement', function () {
  this.timeout(120000);

  before(async () => {
    assert.equal(await waitForApp(), 'ready');
    await waitForEmails();
    await wait(() => browser.execute(() => !!window.__SETTINGS_STORE__ && !!window.__MAIL_STORE__), 'The build must enable VITE_E2E');
  });

  beforeEach(async () => {
    await closeSettings();
    await browser.execute((luke, vader) => {
      const now = Date.now();
      window.__SETTINGS_STORE__.setState({
        language: 'en', sidebarLayout: 'stacked', sidebarDensity: 'comfortable', sidebarCollapsed: false,
        sidebarBackupStatusLocation: 'avatar', viewStyle: 'list', transferHoverEnabled: false,
        displayNames: { [luke]: 'A deliberately long account name for backup placement' },
        billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active' },
        backupGlobalEnabled: false,
        backupSchedules: { [luke]: { enabled: true, interval: 'daily' }, [vader]: { enabled: true, interval: 'daily' } },
        backupState: {
          [luke]: { lastStatus: 'success', lastBackupTime: now, lastAttemptTime: now },
          [vader]: { lastStatus: 'degraded', lastBackupTime: now, lastAttemptTime: now },
        },
      });
      window.__MAIL_STORE__.setState({ unifiedInbox: false });
    }, LUKE, VADER);
    await wait(async () => (await rowGeometry())?.location === 'avatar', 'Seeded account status did not appear');
  });

  after(async () => { await closeSettings(); });

  for (const density of ['Comfortable', 'Compact']) {
    it(`gives the account name more room on the avatar in ${density.toLowerCase()} density`, async () => {
      await layoutSettings();
      await choose(density);
      await choose('End of row');
      await closeSettings();
      const atEnd = await rowGeometry();
      assert.equal(atEnd.location, 'row');
      assert.ok(atEnd.iconLeft > atEnd.avatarRight + 24);
      await layoutSettings();
      await choose('On avatar');
      await closeSettings();
      const onAvatar = await rowGeometry();
      assert.equal(onAvatar.location, 'avatar');
      assert.ok(onAvatar.labelWidth >= atEnd.labelWidth + 24, 'The badge must release the trailing status column');
      assert.ok(onAvatar.iconLeft < onAvatar.avatarRight && onAvatar.iconRight > onAvatar.avatarRight, 'Badge must overlap the avatar edge');
      assert.ok(onAvatar.iconRight <= onAvatar.labelLeft - 2, 'Badge must leave space before the account name');
      assert.ok(onAvatar.targetWidth >= 24 && onAvatar.targetHeight >= 24);
      assert.ok(onAvatar.targetTop >= onAvatar.rowTop - 1 && onAvatar.targetBottom <= onAvatar.rowBottom + 1);
      assert.equal(onAvatar.separateButton, true);
      assert.equal(onAvatar.health, 'success');
      assert.notEqual(onAvatar.color, atEnd.color, 'Avatar success should use the quieter treatment');
    });
  }

  it('previews every choice, persists Hidden through reload, and leaves schedules enabled', async () => {
    await layoutSettings();
    for (const [label, count] of [['End of row', 2], ['Hidden', 0], ['On avatar', 2], ['Hidden', 0]]) {
      await choose(label);
      assert.equal(await browser.execute(() => document.querySelectorAll('.sidebar-backup-preview .sidebar-backup-status').length), count);
    }
    await closeSettings();
    assert.equal(await browser.execute(() => document.querySelectorAll('.mail-sidebar .sidebar-backup-status').length), 0);
    await wait(() => diskSettings()?.sidebarBackupStatusLocation === 'hidden', 'Hidden choice was not written to disk');
    const schedules = diskSettings().backupSchedules;
    assert.equal(schedules[LUKE].enabled, true);
    assert.equal(schedules[VADER].enabled, true);
    await browser.refresh();
    assert.equal(await waitForApp(), 'ready');
    await wait(() => browser.execute(() => window.__SETTINGS_STORE__?.persist.hasHydrated()), 'Settings did not hydrate after reload');
    assert.equal(await browser.execute(() => window.__SETTINGS_STORE__.getState().sidebarBackupStatusLocation), 'hidden');
    assert.equal(await browser.execute(() => document.querySelectorAll('.mail-sidebar .sidebar-backup-status').length), 0);
    assert.deepEqual(diskSettings().backupSchedules, schedules);
    await layoutSettings();
    assert.equal(await browser.execute(() => [...document.querySelectorAll('.settings-segments button')]
      .some(el => el.textContent.trim() === 'Hidden' && el.getAttribute('aria-pressed') === 'true')), true);
  });

  it('opens the account’s backup details from stacked, split, and switcher layouts without switching mail accounts', async () => {
    for (const layout of ['Stacked', 'Split sections', 'Account switcher']) {
      await layoutSettings();
      await choose(layout);
      await closeSettings();
      const previousAccount = await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId);
      if (layout === 'Account switcher') {
        assert.equal(await browser.execute(() => {
          const button = document.querySelector('.sidebar-account-switcher');
          if (!button) return false;
          button.click(); return true;
        }), true);
        await wait(() => browser.execute(() => !!document.querySelector('.sidebar-account-chooser')), 'Account chooser did not open');
      }
      const root = layout === 'Account switcher' ? '.sidebar-account-chooser' : '.mail-sidebar';
      await clickBackup(`${root} .sidebar-backup-status[data-health="success"]`);
      assert.equal(await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId), previousAccount);
      assert.equal(await browser.execute(() => !!document.querySelector('.sidebar-account-chooser')), false);
      await closeSettings();
    }
  });

  it('keeps warning glyphs and independently focusable actions in the collapsed rail', async () => {
    assert.equal(await browser.execute(() => {
      const button = document.querySelector('.mail-sidebar button[title="Collapse sidebar"]');
      if (!button) return false;
      button.click(); return true;
    }), true);
    await wait(() => browser.execute(() => !!document.querySelector('.sidebar-collapsed-backup')), 'Sidebar did not collapse');
    assert.equal(await browser.execute(() => !!document.querySelector('.sidebar-collapsed-backup [data-health="warning"] .lucide-alert-circle')), true);
    const previousAccount = await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId);
    await clickBackup('.sidebar-collapsed-backup .sidebar-backup-status[data-health="success"]');
    assert.equal(await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId), previousAccount);
  });

  it('opens backup details directly from the closed account switcher', async () => {
    assert.equal(await browser.execute(email => {
      const button = [...document.querySelectorAll('.sidebar-account-open')].find(el => el.title.includes(email));
      if (!button) return false;
      button.click(); return true;
    }, EMAIL), true);
    await wait(() => browser.execute(id => window.__MAIL_STORE__.getState().activeAccountId === id, LUKE), 'Account did not activate');
    await layoutSettings();
    await choose('Account switcher');
    await closeSettings();
    await clickBackup('.sidebar-switcher-row .sidebar-backup-status');
    assert.equal(await browser.execute(() => !!document.querySelector('.sidebar-account-chooser')), false);
    assert.equal(await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId), LUKE);
  });
});
