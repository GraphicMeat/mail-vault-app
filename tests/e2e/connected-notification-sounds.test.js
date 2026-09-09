import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { appDataDir, MOCK_PASSWORD, trackMailbox } from './mockImap.js';

const SELECT = '#new-email-sound';
const PREVIEW = 'button[aria-label="Preview sound"]';
const wait = (condition, message) => browser.waitUntil(condition, { timeout: 30_000, interval: 150, timeoutMsg: message });

async function openNotifications() {
  await openSettings();
  assert.equal(await clickSettingsNav('Mail preferences'), true);
  assert.equal(await clickSettingsNav('Notifications'), true);
  await wait(() => browser.execute(sel => !!document.querySelector(sel), SELECT), 'Sound setting did not appear');
}

async function chooseSound(sound) {
  await wait(() => browser.execute(selector => {
    const select = document.querySelector(selector);
    return select && !select.disabled;
  }, SELECT), 'Sound selector stayed disabled');
  assert.equal(await browser.execute((selector, value) => {
    const select = document.querySelector(selector);
    if (!select || select.disabled) return false;
    select.scrollIntoView({ block: 'nearest' });
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, SELECT, sound), true);
  await wait(() => browser.execute((selector, value) => document.querySelector(selector)?.value === value, SELECT, sound), 'Sound selection did not update');
}

// Tauri's invoke is read-only. Observe its IPC fetch and legacy fallback;
// both still reach Rust and return the real response to the application.
async function observeNativeCalls() {
  assert.equal(await browser.execute(() => {
    const original = window.fetch;
    const originalStringify = JSON.stringify;
    const names = ['preview_notification_sound', 'send_notification'];
    const commands = new Map(names
      .map(command => [window.__TAURI_INTERNALS__.convertFileSrc(command, 'ipc'), command]));
    const calls = [];
    window.__SOUND_NATIVE_CALLS__ = calls;
    window.__SOUND_ORIGINAL_FETCH__ = original;
    window.__SOUND_ORIGINAL_STRINGIFY__ = originalStringify;
    const observe = function (resource, options) {
      const result = original.call(this, resource, options);
      const command = commands.get(String(resource));
      if (!command) return result;
      const args = JSON.parse(options.body);
      return result.then(async response => {
        const ok = response.headers.get('Tauri-Response') === 'ok';
        const error = ok ? undefined : await response.clone().text();
        calls.push({ command, args, ok, error });
        return response;
      });
    };
    // The app's CSP can make Tauri use postMessage instead of IPC fetch.
    // Observe serialization at that boundary, wrapping only the two response
    // callbacks for this command. Forward each callback without changing it.
    const observeFallback = function (value, ...rest) {
      if (names.includes(value?.cmd) && Number.isInteger(value.callback) && Number.isInteger(value.error)) {
        const callbacks = window.__TAURI_INTERNALS__.callbacks;
        for (const [id, ok] of [[value.callback, true], [value.error, false]]) {
          const callback = callbacks.get(id);
          if (callback) callbacks.set(id, data => {
            calls.push({ command: value.cmd, args: value.payload, ok, error: ok ? undefined : String(data) });
            return callback(data);
          });
        }
      }
      return originalStringify.call(this, value, ...rest);
    };
    window.fetch = observe;
    JSON.stringify = observeFallback;
    return window.fetch === observe && JSON.stringify === observeFallback;
  }), true, 'Could not observe native IPC requests');
}

async function receiveEmail(subject) {
  const server = browser.mockImap[0];
  const client = new ImapFlow({
    host: server.host, port: server.port, secure: false, logger: false,
    auth: { user: browser.mockAccounts[0].email, pass: MOCK_PASSWORD },
  });
  await client.connect();
  try {
    await client.append('INBOX', Buffer.from([
      'From: Sound test <sound@mock.test>',
      `To: ${browser.mockAccounts[0].email}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${subject}@mock.test>`,
      'Content-Type: text/plain; charset=utf-8', '', 'Incoming sound test.', '',
    ].join('\r\n')));
  } finally {
    await client.logout();
  }
  await wait(() => browser.execute(wanted => window.__SOUND_NATIVE_CALLS__.some(call =>
    call.command === 'send_notification' && call.args.body.includes(wanted)), subject), 'Incoming email did not trigger its native notification');
  return browser.execute(wanted => window.__SOUND_NATIVE_CALLS__.find(call =>
    call.command === 'send_notification' && call.args.body.includes(wanted)), subject);
}

describe('Mac incoming email sounds', function () {
  this.timeout(120_000);
  let restoreInbox;

  before(async function () {
    if (process.platform !== 'darwin') this.skip();
    restoreInbox = await trackMailbox(browser.mockImap[0], 'INBOX');
    await waitForApp();
    await waitForEmails();
    await openNotifications();
    await observeNativeCalls();
  });

  after(async function () {
    if (process.platform !== 'darwin') return;
    try {
      await browser.execute(() => {
        if (window.__SOUND_ORIGINAL_FETCH__) window.fetch = window.__SOUND_ORIGINAL_FETCH__;
        if (window.__SOUND_ORIGINAL_STRINGIFY__) JSON.stringify = window.__SOUND_ORIGINAL_STRINGIFY__;
        delete window.__SOUND_ORIGINAL_FETCH__;
        delete window.__SOUND_ORIGINAL_STRINGIFY__;
        delete window.__SOUND_NATIVE_CALLS__;
      });
      await closeSettings();
    } finally {
      await restoreInbox?.();
    }
  });

  it('offers five sounds and previews each through the native player', async () => {
    assert.deepEqual(await browser.execute(sel => [...document.querySelector(sel).options].map(option => option.value), SELECT),
      ['none', 'Glass', 'Ping', 'Pop', 'Purr', 'Tink']);
    assert.equal(await browser.execute(sel => document.querySelector(sel).disabled, PREVIEW), true);
    for (const sound of ['Glass', 'Ping', 'Pop', 'Purr', 'Tink']) {
      await chooseSound(sound);
      assert.equal(await browser.execute(sel => {
        const button = document.querySelector(sel);
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, PREVIEW), true);
      await wait(() => browser.execute(wanted => window.__SOUND_NATIVE_CALLS__.some(call =>
        call.command === 'preview_notification_sound' && call.args.sound === wanted), sound), 'Native preview did not finish');
      const call = await browser.execute(wanted => window.__SOUND_NATIVE_CALLS__.find(call =>
        call.command === 'preview_notification_sound' && call.args.sound === wanted), sound);
      assert.equal(call.ok, true, call.error);
    }
  });

  it('saves the selection on disk and restores it after a reload', async () => {
    await chooseSound('Ping');
    await wait(() => {
      try {
        const saved = JSON.parse(readFileSync(join(appDataDir(browser.testDataDir), 'frontend-settings.json'), 'utf8'));
        return saved['mailvault-settings']?.state?.notificationSettings?.sound === 'Ping';
      } catch { return false; }
    }, 'Sound selection was not saved to disk');
    await browser.refresh();
    await waitForApp();
    await waitForEmails();
    await openNotifications();
    assert.equal(await browser.execute(sel => document.querySelector(sel).value, SELECT), 'Ping');
    await observeNativeCalls();
  });

  it('uses the selected sound for received mail and sends silent notifications when Off', async () => {
    await closeSettings();
    const audible = await receiveEmail(`sound-ping-${Date.now()}`);
    assert.equal(audible.ok, true, audible.error);
    assert.equal(audible.args.sound, 'Ping');

    await openNotifications();
    await chooseSound('none');
    assert.equal(await browser.execute(sel => document.querySelector(sel).disabled, PREVIEW), true);
    await closeSettings();
    const silent = await receiveEmail(`sound-off-${Date.now()}`);
    assert.equal(silent.ok, true, silent.error);
    assert.equal(silent.args.sound, undefined);
  });
});
