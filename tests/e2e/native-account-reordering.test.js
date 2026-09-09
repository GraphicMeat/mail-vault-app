/**
 * Account order is edited through the grip in Settings and shared with the sidebar.
 * Run on an unlocked macOS runner with existing Accessibility permission.
 * Native input is required to exercise WebKit's real pointer capture, so this
 * belongs to local-manual rather than the connected-ci suite.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForApp, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

const LIST = '[data-testid="settings-page"] .account-settings-reorder-list';
const wait = (condition, message) => browser.waitUntil(condition, {
  timeout: 15_000, interval: 100, timeoutMsg: message,
});
const order = () => browser.execute(sel => [...document.querySelectorAll(`${sel} > li`)].map(row => row.dataset.accountId), LIST);
const selected = () => browser.execute(sel => document.querySelector(`${sel} button[aria-pressed="true"]`)?.closest('li').dataset.accountId, LIST);
const sameOrder = async expected => JSON.stringify(await order()) === JSON.stringify(expected);
let nativeDir;
let nativeInput;
let heldAt;
const appBinary = process.env.TAURI_APP_BINARY || resolve('target/debug/mailvault');

async function releaseMouse() {
  if (heldAt) {
    execFileSync(nativeInput, [appBinary, 'release', '0', '0', String(heldAt.x), String(heldAt.y), 'true']);
    heldAt = null;
  }
  await browser.releaseActions();
}

async function points(sourceId, targetId, handle = true) {
  return browser.execute((sel, source, target, fromHandle) => {
    const rows = [...document.querySelectorAll(`${sel} > li`)];
    const sourceRow = rows.find(row => row.dataset.accountId === source);
    const targetRow = rows.find(row => row.dataset.accountId === target);
    if (!sourceRow || !targetRow) return null;
    sourceRow.scrollIntoView({ block: 'nearest' });
    const from = sourceRow.querySelector(fromHandle ? '.account-settings-drag-handle' : '.account-settings-account-button').getBoundingClientRect();
    const to = targetRow.getBoundingClientRect();
    return {
      from: { x: Math.round(from.left + from.width / 2), y: Math.round(from.top + from.height / 2) },
      to: { x: Math.round(to.left + 15), y: Math.round(to.bottom - 8) },
    };
  }, LIST, sourceId, targetId, handle);
}

async function dragTo(from, to, release = true) {
  const origin = await browser.executeAsync(done => {
    const win = window.__TAURI__.window.getCurrentWindow();
    Promise.all([win.innerPosition(), win.scaleFactor()])
      .then(([position, scale]) => done({ x: position.x / scale, y: position.y / scale }),
        error => done({ error: String(error) }));
  });
  assert.equal(origin.error, undefined);
  heldAt = { x: origin.x + to.x, y: origin.y + to.y };
  execFileSync(nativeInput, [appBinary, 'drag', String(origin.x + from.x), String(origin.y + from.y),
    String(heldAt.x), String(heldAt.y), String(release)], { timeout: 10_000 });
  if (release) heldAt = null;
}

async function keyOnHandle(id, key) {
  const focused = await browser.execute((sel, accountId) => {
    const row = [...document.querySelectorAll(`${sel} > li`)].find(item => item.dataset.accountId === accountId);
    const handle = row?.querySelector('.account-settings-drag-handle');
    handle?.focus();
    return !!handle;
  }, LIST, id);
  assert.equal(focused, true);
  await pressKey(key);
}

async function pressKey(key) {
  const codes = { Home: 115, End: 119, ArrowDown: 125, ArrowUp: 126, Escape: 53 };
  assert.ok(key in codes, `No native keycode for ${key}`);
  execFileSync(nativeInput, [appBinary, 'key', String(codes[key]), '0', '0', '0', 'true'], { timeout: 10_000 });
}

(process.platform === 'darwin' ? describe : describe.skip)('Account reordering', function () {
  this.timeout(90_000);
  let ids;
  let previousOrder;

  before(async () => {
    nativeDir = mkdtempSync(join(tmpdir(), 'mailvault-native-input-'));
    nativeInput = join(nativeDir, 'input');
    execFileSync('/usr/bin/swiftc', [resolve('tests/e2e/nativeInput.swift'), '-o', nativeInput], { timeout: 60_000 });
    await waitForApp();
    const initial = await browser.execute(() => ({
      ids: window.__MAIL_STORE__.getState().accounts.map(account => account.id),
      order: window.__SETTINGS_STORE__.getState().accountOrder,
    }));
    ids = initial.ids;
    previousOrder = initial.order;
    assert.equal(ids.length, 3, 'The connected harness must seed three accounts');
  });

  beforeEach(async () => {
    await browser.execute(value => window.__SETTINGS_STORE__.getState().setAccountOrder(value), ids);
    await openSettings();
    assert.equal(await clickSettingsNav('Accounts'), true);
    await wait(() => sameOrder(ids), 'Your Accounts did not render the saved order');
  });

  afterEach(async () => {
    await releaseMouse();
    await closeSettings();
  });

  after(async () => {
    if (previousOrder) await browser.execute(value => window.__SETTINGS_STORE__.getState().setAccountOrder(value), previousOrder);
    if (nativeDir) rmSync(nativeDir, { recursive: true, force: true });
  });

  it('drags from the grip, updates the sidebar, and saves the order to disk', async () => {
    const currentSelection = await selected();
    const position = await points(ids[0], ids[2]);
    assert.ok(position);
    await browser.execute(() => {
      window.__accountReorderInput = {};
      document.addEventListener('pointerdown', event => { window.__accountReorderInput.trusted = event.isTrusted; }, { once: true });
      document.addEventListener('gotpointercapture', () => { window.__accountReorderInput.captured = true; }, { once: true });
    });
    await dragTo(position.from, position.to);
    const expected = [ids[1], ids[2], ids[0]];
    await wait(() => sameOrder(expected), 'Dragging the grip did not move the account');
    assert.deepEqual(await browser.execute(() => window.__accountReorderInput), { trusted: true, captured: true });
    assert.equal(await selected(), currentSelection, 'Reordering changed the selected account');
    await wait(async () => {
      const saved = await browser.executeAsync(done => {
        window.__TAURI__.core.invoke('read_settings_json').then(done, error => done({ error: String(error) }));
      });
      return typeof saved === 'string'
        && JSON.stringify(JSON.parse(saved)['mailvault-settings']?.state?.accountOrder) === JSON.stringify(expected);
    }, 'The account order was not persisted to disk');
    await closeSettings();
    const sidebarEmails = await browser.execute(() => [...document.querySelectorAll('[data-testid="sidebar-account-list"] .sidebar-account-open')]
      .map(row => row.getAttribute('title')));
    const expectedEmails = expected.map(id => browser.mockAccounts.find(account => account.id === id).email);
    assert.deepEqual(sidebarEmails, expectedEmails);
    await openSettings();
    assert.equal(await clickSettingsNav('Accounts'), true);
    await wait(() => sameOrder(expected), 'Closing Settings lost the account order');
  });

  it('keeps a normal account-name drag from changing the order', async () => {
    const position = await points(ids[0], ids[2], false);
    await dragTo(position.from, position.to);
    assert.deepEqual(await order(), ids);
  });

  it('cancels an unfinished drag with Escape without closing Settings', async () => {
    const position = await points(ids[0], ids[2]);
    await dragTo(position.from, position.to, false);
    await wait(() => browser.execute(() => !!document.querySelector('.account-settings-drag-preview')), 'Dragging did not show a preview');
    assert.deepEqual(await order(), ids, 'The order changed before dropping');
    await pressKey('Escape');
    await releaseMouse();
    assert.deepEqual(await order(), ids);
    assert.equal(await browser.execute(() => !!document.querySelector('[data-testid="settings-page"][role="dialog"]')), true);
    assert.equal(await browser.execute(() => !!document.querySelector('.account-settings-drag-preview')), false);
  });

  it('ignores a drop outside Your Accounts', async () => {
    const position = await points(ids[0], ids[2]);
    const outside = await browser.execute(() => {
      const rect = document.querySelector('.account-settings-detail').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    });
    await dragTo(position.from, outside);
    assert.deepEqual(await order(), ids);
  });

  it('moves with keyboard keys while retaining focus and selection, without the old order section', async () => {
    const currentSelection = await selected();
    await keyOnHandle(ids[2], 'Home');
    await wait(() => sameOrder([ids[2], ids[0], ids[1]]), 'Home did not move the account first');
    await keyOnHandle(ids[2], 'ArrowDown');
    await wait(() => sameOrder([ids[0], ids[2], ids[1]]), 'ArrowDown did not move the account one place');
    assert.equal(await browser.execute(() => document.activeElement.closest('li')?.dataset.accountId), ids[2]);
    assert.equal(await selected(), currentSelection);
    assert.equal(await clickSettingsNav('Advanced'), true);
    assert.equal(await browser.execute(() => [...document.querySelectorAll('[data-testid="settings-page"] h4')]
      .some(heading => heading.textContent.trim() === 'Account order')), false);
  });
});
