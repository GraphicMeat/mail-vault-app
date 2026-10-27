/**
 * E2E Test: Connected Account Setup
 *
 * The two mock-IMAP accounts are seeded before the app launches (see
 * wdio.conf.js), so this spec verifies they came up connected, then exercises
 * the add/remove flow end to end against a mock server.
 */

import {
  waitForApp,
  openSettings,
  closeSettings,
  clickSettingsNav,
} from './helpers.js';
import { createServer, connect } from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir, trackMailbox } from './mockImap.js';
import { openComposeFresh, setField, typeInBody, clickSend, outboxItems, nativeComposeRpc } from './composeHelpers.js';

// The proxy forwards the real mock SMTP protocol. One disposable account's
// MAIL FROM can be held after transport entry, then released without changing
// the server response or manufacturing a lifecycle result.
async function smtpEntryProxy(host, initialPort) {
  let targetPort = initialPort;
  let arm = null;
  let held = null;
  const sockets = new Set();
  const server = createServer((client) => {
    const upstream = connect({ host, port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    const cleanup = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
    upstream.pipe(client);
    if (!arm) { client.pipe(upstream); return; }

    let pending = Buffer.alloc(0);
    const forward = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf(10);
        if (end < 0) return;
        const line = pending.subarray(0, end + 1);
        pending = pending.subarray(end + 1);
        if (/^MAIL FROM:/i.test(line.toString('ascii'))
          && line.toString('ascii').toLowerCase().includes(arm.email)) {
          const reached = arm;
          arm = null;
          client.pause();
          held = { client, upstream, line, tail: pending, forward };
          pending = Buffer.alloc(0);
          reached.resolve();
          return;
        }
        upstream.write(line);
      }
    };
    client.on('data', forward);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    retarget(port) { targetPort = port; },
    arm(email) {
      if (arm || held) throw new Error('SMTP hold already active');
      return new Promise((resolve) => { arm = { email: email.toLowerCase(), resolve }; });
    },
    release() {
      if (!held) { arm = null; return; }
      const { client, upstream, line, tail, forward } = held;
      held = null;
      client.removeListener('data', forward);
      upstream.write(line);
      if (tail.length) upstream.write(tail);
      client.pipe(upstream);
      client.resume();
    },
    async stop() {
      this.release();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not happen within ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function credentialEntry(id) {
  const file = join(appDataDir(browser.testDataDir), 'test-credentials.json');
  return JSON.parse(readFileSync(file, 'utf8'))[id];
}

function receiptRows(id) {
  const db = new DatabaseSync(join(appDataDir(browser.testDataDir), 'app.db'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const prefix = `compose_receipt:${createHash('sha256').update(id).digest('hex')}:`;
    return db.prepare('SELECT value FROM meta WHERE key LIKE ?').all(`${prefix}%`).map((row) => JSON.parse(row.value));
  } finally { db.close(); }
}

const nativeAccounts = async () => (await nativeComposeRpc('accounts.list', {})).accounts;

describe('Connected Account Setup', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
  });

  it('updates through the native workflow and refuses an origin change without replacement', async()=>{
    const result=await browser.executeAsync(done=>{
      const state=window.__MAIL_STORE__.getState();const account=state.accounts[0];
      state.updateAccount(account.id,{displayName:'S2.3 native metadata'}).then(async saved=>{
        let refused=false;try{await state.updateAccount(account.id,{imapPort:(Number(saved.imapPort)||993)+1});}catch{refused=true;}
        done({id:saved.id,name:saved.displayName,secretFree:!['password','oauth2AccessToken','oauth2RefreshToken'].some(k=>Object.hasOwn(saved,k)),refused});
      }).catch(e=>done({failed:String(e?.message||e)}));
    });
    expect(result.failed).toBeUndefined();expect(result.name).toBe('S2.3 native metadata');expect(result.secretFree).toBe(true);expect(result.refused).toBe(true);
  });

  // Account rows live inside the settings page; the identical-looking sidebar
  // rows behind it must never be clicked by mistake.
  const SETTINGS_ROW_SELECTOR = '[data-testid="settings-page"] button[aria-pressed]';

  async function openAccountsTab() {
    await openSettings();
    await browser.execute(() => {
      for (const tab of document.querySelectorAll('[data-testid="settings-page"] button, [data-testid="settings-page"] [role="tab"]')) {
        if ((tab.textContent || '').trim().toLowerCase() === 'accounts') {
          tab.click();
          return;
        }
      }
    });
    await browser.waitUntil(
      async () => browser.execute((sel) => document.querySelectorAll(sel).length > 0, SETTINGS_ROW_SELECTOR),
      { timeout: 10_000, interval: 250, timeoutMsg: 'Accounts list did not render in Settings' },
    );
  }

  // ---------------------------------------------------------------------------
  // Helper: remove an account by email via Settings > Accounts
  // ---------------------------------------------------------------------------
  async function selectSettingsAccount(email) {
    await openAccountsTab();

    // Select the row for this account. Every query here is scoped to the
    // settings page: the sidebar behind it has account rows with the same text,
    // and clicking one of those switches accounts instead of selecting here —
    // leaving the previous account selected, which is how a remove would hit
    // the wrong account.
    const selected = await browser.execute((targetEmail, sel) => {
      for (const row of document.querySelectorAll(sel)) {
        if (!(row.innerText || '').includes(targetEmail)) continue;
        row.click();
        return true;
      }
      return false;
    }, email, SETTINGS_ROW_SELECTOR);

    if (!selected) {
      await closeSettings();
      return false;
    }
    await browser.waitUntil(() => browser.execute((target, selector) =>
      [...document.querySelectorAll(selector)].some((row) =>
        (row.innerText || '').includes(target) && row.getAttribute('aria-pressed') === 'true'),
    email, SETTINGS_ROW_SELECTOR),
    { timeout: 10_000, interval: 200, timeoutMsg: `Settings did not select ${email}` });
    return true;
  }

  async function openRemoveConfirmation(email) {
    if (!await selectSettingsAccount(email)) return false;

    // Account removal lives in Advanced; selecting an account opens Profile.
    if (!(await clickSettingsNav('Advanced'))) {
      throw new Error(`Could not open Advanced settings for ${email}`);
    }

    const clickedRemove = await browser.execute(() => {
      for (const btn of document.querySelectorAll('[data-testid="settings-page"] button')) {
        if ((btn.textContent || '').includes('Remove This Account') && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clickedRemove) throw new Error(`Could not open the remove confirmation for ${email}`);
    await browser.pause(500);

    // The confirmation names the account it is about to delete — check it before
    // confirming, so a mis-targeted row click can never remove a real account.
    const confirmLine = await browser.waitUntil(
      async () => browser.execute(() => {
        const page = document.querySelector('[data-testid="settings-page"]');
        const m = page && page.innerText.match(/Are you sure you want to remove .*/);
        return m ? m[0] : null;
      }),
      { timeout: 5000, interval: 250, timeoutMsg: 'Remove confirmation never appeared' },
    );

    if (!confirmLine.includes(email)) {
      throw new Error(`Remove confirmation says "${confirmLine}" — refusing to confirm for ${email}`);
    }

    return true;
  }

  async function confirmRemoval(email) {
    const result = await browser.execute((target) => {
      const page = document.querySelector('[data-testid="settings-page"]');
      const question = [...(page?.querySelectorAll('p') || [])]
        .find((item) => item.textContent.includes('Are you sure you want to remove')
          && item.textContent.includes(target));
      const card = question?.parentElement;
      const button = [...(card?.querySelectorAll('button') || [])]
        .find((item) => item.textContent.trim().startsWith('Remove'));
      const result = {
        question: question?.textContent.trim(), button: button?.textContent.trim(),
        disabled: button?.disabled, visible: !!button && button.offsetHeight > 0,
        alertBefore: card?.querySelector('[role="alert"]')?.textContent.trim(),
      };
      if (result.visible && !result.disabled) { button.click(); result.clicked = true; }
      return result;
    }, email);

    if (!result.clicked) throw new Error(`Could not confirm removal of ${email}: ${JSON.stringify(result)}`);
    return result;
  }

  async function removeAccountIfExists(email) {
    if (!await openRemoveConfirmation(email)) return false;
    await confirmRemoval(email);

    await browser.waitUntil(
      async () => {
        const accounts = await nativeAccounts();
        return !accounts.some((account) => account.email === email);
      },
      { timeout: 30_000, interval: 500, timeoutMsg: `${email} remained in native account listing after removal` },
    );

    await closeSettings();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Helper: add a test account via the AccountModal
  // ---------------------------------------------------------------------------
  async function addTestAccount({ email, password, imapHost, imapPort, smtpHost, smtpPort }) {
    // With accounts already present the sidebar has no Add button — it lives in
    // Settings → Accounts, which closes itself and opens the AccountModal.
    await openAccountsTab();

    const clickedAdd = await browser.execute(() => {
      const buttons = document.querySelectorAll('[data-testid="settings-page"] button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        const title = (btn.getAttribute('title') || '').trim();
        if ((text.includes('Add') && text.includes('Account')) || title === 'Add Account') {
          if (btn.offsetHeight > 0) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });

    expect(clickedAdd).toBe(true);
    await browser.pause(500);

    // Select "Other / Custom" provider
    const clickedCustom = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if ((btn.textContent || '').includes('Other / Custom') && btn.offsetHeight > 0) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    expect(clickedCustom).toBe(true);
    await browser.pause(500);

    // Fill email
    await browser.execute((val) => {
      const input = document.querySelector('input[type="email"], input[name="email"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, email);
    await browser.pause(300);

    // Fill password
    await browser.execute((val) => {
      const input = document.querySelector('input[type="password"], input[name="password"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, password);
    await browser.pause(300);

    // Helper to set input value via React-compatible approach
    async function setInputValue(selector, value) {
      await browser.execute((sel, val) => {
        const input = document.querySelector(sel);
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(
          input.type === 'number' ? window.HTMLInputElement.prototype : window.HTMLInputElement.prototype,
          'value'
        ).set;
        setter.call(input, String(val));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, selector, value);
      await browser.pause(200);
    }

    // The custom provider hides the server fields behind "Auto-detect Server
    // Settings" — it reveals them whether or not detection finds anything, but
    // detection probes DNS first, so wait for the fields rather than a fixed pause.
    const hasManualFields = await browser.execute(() => {
      return document.querySelector('input[name="imapHost"]') !== null;
    });

    if (!hasManualFields) {
      await browser.execute(() => {
        for (const btn of document.querySelectorAll('button')) {
          if ((btn.textContent || '').includes('Auto-detect') && btn.offsetHeight > 0) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      await browser.waitUntil(
        async () => browser.execute(() => document.querySelector('input[name="imapHost"]') !== null),
        { timeout: 60_000, interval: 1000, timeoutMsg: 'Server settings fields never appeared' },
      );
    }

    // Fill IMAP/SMTP settings
    await setInputValue('input[name="imapHost"]', imapHost);
    await setInputValue('input[name="imapPort"]', imapPort);
    await setInputValue('input[name="smtpHost"]', smtpHost);
    await setInputValue('input[name="smtpPort"]', smtpPort);

    // Click "Add Account" submit button
    const clickedSubmit = await browser.execute(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (text === 'Add Account' && btn.offsetHeight > 0 && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clickedSubmit) {
      // Debug: log visible buttons
      const debugInfo = await browser.execute(() => {
        const buttons = document.querySelectorAll('button');
        return Array.from(buttons).filter(b => b.offsetHeight > 0).map(b => b.textContent.trim()).join(' | ');
      });
      console.log('[addTestAccount] visible buttons:', debugInfo);
    }
    expect(clickedSubmit).toBe(true);

    // Wait for the connection test to resolve either way — a failed add reports
    // its reason in the modal, and that reason is what a failing spec should say.
    const outcome = await browser.waitUntil(
      async () => browser.execute((target) => {
        const text = document.body.innerText;
        if (text.includes('Account added successfully') || text.includes('Connected!')) return 'ok';
        // The modal auto-closes 1.5s after success, so a slow poll can miss the
        // banner entirely — the account landing in the sidebar counts too.
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (sidebar && (sidebar.innerText || '').includes(target)) return 'ok';
        // Scope the error read to the modal's form: Settings has its own
        // permanently-rendered danger copy that would otherwise read as a failure.
        const err = document.querySelector('form [class*="mail-danger"]');
        if (err && err.innerText.trim()) return `error: ${err.innerText.trim()}`;
        return null;
      }, email),
      {
        timeout: 60_000,
        timeoutMsg: `Account add neither succeeded nor reported an error within 60s for ${email}`,
        interval: 1000,
      },
    );

    expect(outcome).toBe('ok');

    // Wait for modal to auto-close
    await browser.pause(3000);
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  describe('Verify test accounts exist', function () {
    it('should have both seeded mock accounts available', async function () {
      await browser.pause(2000);

      const accountsPresent = await browser.execute((email1, email2) => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return { email1: false, email2: false };
        const allEls = sidebar.querySelectorAll('[title], span, div');
        let found1 = false;
        let found2 = false;
        for (const el of allEls) {
          const t = (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
          if (t.includes(email1)) found1 = true;
          if (t.includes(email2)) found2 = true;
        }
        return { email1: found1, email2: found2 };
      }, browser.testEnv.TEST_EMAIL, browser.testEnv.TEST_EMAIL2);

      expect(accountsPresent.email1).toBe(true);
      expect(accountsPresent.email2).toBe(true);
    });
  });

  describe('Add and remove an account', function () {
    this.timeout(300_000);
    // A third address on mock server #1 — the mock accepts any LOGIN, so this
    // exercises the real AccountModal flow (connection test included) without
    // disturbing the two seeded accounts.
    const email = 'r2d2@mock.test';
    let accountId;
    let proxy;
    let restoreSent;

    before(async function () {
      proxy = await smtpEntryProxy(browser.mockImap[0].host, browser.mockImap[0].smtpPort);
    });

    after(async function () {
      proxy?.release();
      try {
        const listed = await nativeAccounts();
        if (listed.some((account) => account.email === email)) await removeAccountIfExists(email);
      } finally {
        await restoreSent?.();
        await browser.execute(() => { window.__S24_APPEND_UNLISTEN__?.(); delete window.__S24_APPEND_EVENTS__; });
        await proxy?.stop();
      }
    });

    it('should add an account through the AccountModal', async function () {
      const { host, port } = browser.mockImap[0];

      await addTestAccount({
        email,
        password: browser.testEnv.TEST_PASSWORD,
        imapHost: host,
        imapPort: port,
        smtpHost: host,
        // The mock's own SMTP listener, not its IMAP port — the connection test
        // the modal runs reaches a server that answers.
        smtpPort: proxy.port,
      });

      const added = (await nativeAccounts()).filter((account) => account.email === email);
      expect(added).toHaveLength(1);
      accountId = added[0].id;
      expect(credentialEntry(accountId)).toBeDefined();
      // The native removal must erase this exact configured-root account tree.
      const tree = join(appDataDir(browser.testDataDir), 'Maildir', accountId);
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(tree, '.s24-target'), 'remove this exact account');

      const present = await browser.execute((target) => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return false;
        for (const el of sidebar.querySelectorAll('[title], span, div')) {
          const t = (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
          if (t.includes(target)) return true;
        }
        return false;
      }, email);

      expect(present).toBe(true);
    });

    it('changes server only after real IMAP and SMTP verification', async function () {
      const [before] = (await nativeAccounts()).filter((account) => account.id === accountId);
      const beforeCredential = credentialEntry(accountId);
      const otherId = browser.mockAccounts[1].id;
      const otherCredential = credentialEntry(otherId);
      expect(await selectSettingsAccount(email)).toBe(true);
      expect(await clickSettingsNav('Connection')).toBe(true);
      let connectionView;
      try {
        await browser.waitUntil(async () => {
          connectionView = await browser.execute((id) => {
            const page = document.querySelector('[data-testid="settings-page"]');
            const account = window.__MAIL_STORE__.getState().accounts.find((row) => row.id === id);
            const buttons = [...(page?.querySelectorAll('button') || [])];
            return {
              account: account && { id: account.id, authType: account.authType },
              selectedTab: page?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
              changeButtons: buttons.filter((button) => (button.textContent || '').includes('Change server'))
                .map((button) => ({ text: button.textContent.trim(), height: button.offsetHeight })),
              visibleButtons: buttons.filter((button) => button.offsetHeight > 0)
                .map((button) => button.textContent.trim()).filter(Boolean).slice(0, 40),
            };
          }, accountId);
          return connectionView.changeButtons.some((button) => button.text === 'Change server' && button.height > 0);
        }, { timeout: 10_000, interval: 200, timeoutMsg: 'Selected account Connection did not render Change server' });
      } catch (error) {
        throw new Error(`${error.message}; observed ${JSON.stringify(connectionView)}`);
      }
      const opened = await browser.execute(() => {
        const button = [...document.querySelectorAll('[data-testid="settings-page"] button')]
          .find((item) => item.offsetHeight > 0 && (item.textContent || '').trim() === 'Change server');
        button?.click();
        return !!button;
      });
      expect(opened).toBe(true);
      await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll('[role="dialog"]')]
        .some((dialog) => dialog.querySelector('h2')?.textContent?.trim().startsWith('Change server:')
          && dialog.querySelector('input[aria-label="IMAP host"]'))),
        { timeout: 10_000, interval: 200, timeoutMsg: 'Change server form did not open' });

      const setServerField = async (label, value) => {
        const found = await browser.execute((name, next) => {
          const dialog = [...document.querySelectorAll('[role="dialog"]')]
            .find((item) => item.querySelector('h2')?.textContent?.trim().startsWith('Change server:'));
          const input = dialog?.querySelector(`[aria-label="${name}"]`);
          if (!input) return false;
          const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, String(next));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, label, value);
        expect(found).toBe(true);
      };
      const verify = async () => {
        const clicked = await browser.execute(() => {
          const dialog = [...document.querySelectorAll('[role="dialog"]')]
            .find((item) => item.querySelector('h2')?.textContent?.trim().startsWith('Change server:'));
          const button = [...(dialog?.querySelectorAll('button') || [])]
            .find((item) => (item.textContent || '').includes('Verify & Save') && !item.disabled);
          button?.click();
          return !!button;
        });
        expect(clicked).toBe(true);
      };

      const next = browser.mockImap[1];
      await setServerField('Security', 'none');
      await setServerField('IMAP host', next.host);
      await setServerField('IMAP port', next.port);
      await setServerField('SMTP host', next.host);
      await setServerField('SMTP port', 1);
      await setServerField('Password', browser.testEnv.TEST_PASSWORD);
      await verify();
      let refusalView;
      try {
        await browser.waitUntil(async () => {
          refusalView = await browser.execute(() => {
            const dialog = [...document.querySelectorAll('[role="dialog"]')]
              .find((item) => item.querySelector('h2')?.textContent?.trim().startsWith('Change server:'));
            const value = (label) => dialog?.querySelector(`[aria-label="${label}"]`)?.value;
            return {
              open: !!dialog,
              imapHost: value('IMAP host'), imapPort: value('IMAP port'), security: value('Security'),
              smtpHost: value('SMTP host'), smtpPort: value('SMTP port'),
              passwordPresent: !!value('Password'),
              errors: [...(dialog?.querySelectorAll('.text-mail-danger') || [])]
                .map((item) => item.textContent.trim()),
              buttons: [...(dialog?.querySelectorAll('button') || [])]
                .map((item) => ({ text: item.textContent.trim(), disabled: item.disabled })).filter((item) => item.text),
            };
          });
          return refusalView.errors.some((message) => message.includes('SMTP:'));
        }, { timeout: 35_000, interval: 250, timeoutMsg: 'Invalid SMTP endpoint was not rejected in Change server' });
      } catch (error) {
        const actual = (await nativeAccounts()).find((account) => account.id === accountId);
        throw new Error(`${error.message}; observed ${JSON.stringify({ ...refusalView,
          native: actual && { imapHost: actual.imapHost, imapPort: actual.imapPort,
            smtpHost: actual.smtpHost, smtpPort: actual.smtpPort },
          credentialChanged: credentialEntry(accountId) !== beforeCredential })}`);
      }
      const [afterRefusal] = (await nativeAccounts()).filter((account) => account.id === accountId);
      expect(afterRefusal.imapPort).toBe(before.imapPort);
      expect(afterRefusal.smtpPort).toBe(before.smtpPort);
      expect(credentialEntry(accountId)).toBe(beforeCredential);
      expect(credentialEntry(otherId)).toBe(otherCredential);

      proxy.retarget(next.smtpPort);
      await setServerField('SMTP port', proxy.port);
      await verify();
      await browser.waitUntil(async () => {
        const [saved] = (await nativeAccounts()).filter((account) => account.id === accountId);
        return saved?.imapPort === next.port && saved?.smtpPort === proxy.port;
      }, { timeout: 60_000, interval: 250, timeoutMsg: 'Native Change server did not publish the new endpoint' });
      const [saved] = (await nativeAccounts()).filter((account) => account.id === accountId);
      expect(saved.imapHost).toBe(next.host);
      expect(saved.smtpHost).toBe(next.host);
      expect(saved.imapSecurity).toBe('none');
      expect(saved.password).toBeUndefined();
      expect(credentialEntry(accountId)).toBeDefined();
      expect(credentialEntry(otherId)).toBe(otherCredential);
      await browser.waitUntil(() => browser.execute(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')]
          .find((item) => item.querySelector('h2')?.textContent?.trim().startsWith('Change server:'));
        return [...(dialog?.querySelectorAll('button') || [])]
          .some((item) => ['Skip', 'Done'].includes(item.textContent.trim()));
      }),
        { timeout: 10_000, interval: 250, timeoutMsg: 'Change server completion did not render' });
      await browser.execute(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')]
          .find((item) => item.querySelector('h2')?.textContent?.trim().startsWith('Change server:'));
        const buttons = [...(dialog?.querySelectorAll('button') || [])];
        buttons.find((item) => (item.textContent || '').trim() === 'Skip')?.click();
      });
      await browser.waitUntil(() => browser.execute(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')]
          .find((item) => item.querySelector('h2')?.textContent?.trim().startsWith('Change server:'));
        return [...(dialog?.querySelectorAll('button') || [])].some((item) => item.textContent.trim() === 'Done');
      }),
      { timeout: 30_000, interval: 250, timeoutMsg: 'Change server did not reach Done' });
      await browser.execute(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')]
          .find((item) => item.querySelector('h2')?.textContent?.trim().startsWith('Change server:'));
        [...(dialog?.querySelectorAll('button') || [])]
          .find((item) => (item.textContent || '').trim() === 'Done')?.click();
      });
      await closeSettings();
    });

    it('refuses removal during a real send, then erases only that account after settlement', async function () {
      const otherId = browser.mockAccounts[1].id;
      const otherTree = join(appDataDir(browser.testDataDir), 'Maildir', otherId);
      mkdirSync(otherTree, { recursive: true });
      writeFileSync(join(otherTree, '.s24-preserve'), 'keep the other account');
      const otherCredential = credentialEntry(otherId);
      const ownCredential = credentialEntry(accountId);
      // A preceding failed modal assertion can leave both dialogs open. The
      // compose shortcut belongs to the main window, never to Settings.
      await closeSettings();
      await closeSettings();
      restoreSent = await trackMailbox(browser.mockImap[1], 'Sent');
      const subscribed = await browser.executeAsync((done) => {
        window.__S24_APPEND_EVENTS__ = [];
        window.__TAURI__.event.listen('send-server-append-complete', (event) =>
          window.__S24_APPEND_EVENTS__.push(event.payload))
          .then((unlisten) => { window.__S24_APPEND_UNLISTEN__ = unlisten; done(true); }, () => done(false));
      });
      expect(subscribed).toBe(true);
      const activated = await browser.executeAsync((id, done) => {
        window.__MAIL_STORE__.getState().activateAccount(id, 'INBOX')
          .then(() => done(true), () => done(false));
      }, accountId);
      expect(activated).toBe(true);
      await browser.execute(() => {
        window.__SETTINGS_STORE__.getState().setComposeOpenMode('app');
        window.__SETTINGS_STORE__.getState().setSendDelay(0);
      });
      await openComposeFresh();
      expect(await setField('compose-from', `${accountId} ${email}`)).toBe(true);
      expect(await setField('compose-to', 'recipient@mock.test')).toBe(true);
      expect(await setField('compose-subject', 'S2.4 account retirement hold')).toBe(true);
      await typeInBody('The send must finish before account removal.');
      const entered = proxy.arm(email);
      try {
        expect(await clickSend()).toBe(true);
        await bounded(entered, 30_000, 'disposable SMTP MAIL FROM');
        const present = receiptRows(accountId);
        expect(present.some((row) => row.state === 'present' && row.identity.accountId === accountId)).toBe(true);
        expect((await outboxItems()).some((item) => item.status === 'sending')).toBe(true);

        expect(await openRemoveConfirmation(email)).toBe(true);
        await confirmRemoval(email);
        await browser.waitUntil(() => browser.execute(() => {
          const page = document.querySelector('[data-testid="settings-page"]');
          return !!page?.querySelector('[role="alert"]')
            && page.querySelector('[role="alert"]').textContent.includes('This account is busy');
        }), { timeout: 15_000, interval: 250, timeoutMsg: 'Actual active send did not produce Busy in removal UI' });
        expect((await nativeAccounts()).some((account) => account.id === accountId)).toBe(true);
        expect(await browser.execute((target, selector) => [...document.querySelectorAll(selector)]
          .some((row) => (row.innerText || '').includes(target)), email, SETTINGS_ROW_SELECTOR)).toBe(true);
        expect((await outboxItems()).some((item) => item.status === 'sending')).toBe(true);
        expect(receiptRows(accountId).some((row) => row.state === 'present' && row.identity.accountId === accountId)).toBe(true);
        expect(credentialEntry(accountId)).toBe(ownCredential);
        expect(existsSync(join(appDataDir(browser.testDataDir), 'Maildir', accountId, '.s24-target'))).toBe(true);
        expect(credentialEntry(otherId)).toBe(otherCredential);
        expect(readFileSync(join(otherTree, '.s24-preserve'), 'utf8')).toBe('keep the other account');
      } finally { proxy.release(); }

      let append;
      await browser.waitUntil(async () => {
        append = await browser.execute((id) => (window.__S24_APPEND_EVENTS__ || [])
          .find((event) => event.vaultAccountId === id), accountId);
        return !!append;
      }, { timeout: 60_000, interval: 250, timeoutMsg: 'Actual Sent APPEND completion event did not arrive' });
      expect(append.ok).toBe(true);
      expect(append.stagedUid).toBeGreaterThan(0);
      await browser.waitUntil(() => {
        const rows = receiptRows(accountId);
        const settled = rows.some((row) => row.identity.uid === append.stagedUid && row.state === 'cleaned');
        const cur = join(appDataDir(browser.testDataDir), 'Maildir', accountId, 'Sent', 'cur');
        const staged = existsSync(cur) && readdirSync(cur).some((name) =>
          name.startsWith(`${append.stagedUid}:`) || name.startsWith(`${append.stagedUid};`));
        return settled && !staged;
      }, { timeout: 30_000, interval: 250, timeoutMsg: 'Compose receipt and staged copy did not settle after APPEND' });
      await browser.waitUntil(async () => !(await outboxItems()).some((item) => item.status === 'sending'),
        { timeout: 15_000, interval: 250, timeoutMsg: 'Outbox still sending after APPEND' });
      expect((await outboxItems()).some((item) => item.status === 'error')).toBe(false);

      const retryClick = await confirmRemoval(email);
      try {
        await browser.waitUntil(async () => !(await nativeAccounts()).some((account) => account.id === accountId),
          { timeout: 45_000, interval: 250, timeoutMsg: 'Native account list retained account after UI retry' });
      } catch (error) {
        const ui = await browser.execute((id, address) => {
          const page = document.querySelector('[data-testid="settings-page"]');
          const question = [...(page?.querySelectorAll('p') || [])]
            .find((item) => item.textContent.includes('Are you sure you want to remove')
              && item.textContent.includes(address));
          const card = question?.parentElement;
          return {
            confirmationVisible: !!question && question.offsetHeight > 0,
            confirmButtons: [...(card?.querySelectorAll('button') || [])]
              .map((item) => ({ text: item.textContent.trim(), disabled: item.disabled })),
            alerts: [...(page?.querySelectorAll('[role="alert"]') || [])]
              .map((item) => item.textContent.trim()),
            selectedRow: [...(page?.querySelectorAll('button[aria-pressed]') || [])]
              .find((item) => item.textContent.includes(address))?.getAttribute('aria-pressed'),
            inStore: window.__MAIL_STORE__.getState().accounts.some((account) => account.id === id),
          };
        }, accountId, email);
        throw new Error(`${error.message}; observed ${JSON.stringify({ retryClick, ui,
          nativePresent: (await nativeAccounts()).some((account) => account.id === accountId),
          credentialPresent: credentialEntry(accountId) !== undefined,
          treePresent: existsSync(join(appDataDir(browser.testDataDir), 'Maildir', accountId)),
          receipts: receiptRows(accountId).map((row) => ({ state: row.state, uid: row.identity.uid })),
          outbox: await outboxItems() })}`);
      }
      await browser.waitUntil(() => browser.execute((id, address) => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        return !(sidebar?.textContent || '').includes(address)
          && !window.__MAIL_STORE__.getState().accounts.some((account) => account.id === id);
      }, accountId, email), { timeout: 15_000, interval: 250, timeoutMsg: 'UI retained completed account after native deletion' });
      expect(credentialEntry(accountId)).toBeUndefined();
      expect(existsSync(join(appDataDir(browser.testDataDir), 'Maildir', accountId))).toBe(false);
      expect(receiptRows(accountId)).toHaveLength(0);
      expect((await nativeAccounts()).some((account) => account.id === otherId)).toBe(true);
      expect(credentialEntry(otherId)).toBe(otherCredential);
      expect(readFileSync(join(otherTree, '.s24-preserve'), 'utf8')).toBe('keep the other account');
      await closeSettings();

      const present = await browser.execute((target) => {
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (!sidebar) return false;
        for (const el of sidebar.querySelectorAll('[title], span, div')) {
          const t = (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
          if (t.includes(target)) return true;
        }
        return false;
      }, email);

      expect(present).toBe(false);
    });
  });

  describe('Verify accounts in sidebar', function () {
    it('should show both test accounts in the sidebar', async function () {
      await browser.pause(2000);

      const accountsVisible = await browser.execute((email1, email2) => {
        const sidebar = document.querySelector('[data-testid="sidebar"]') || document.querySelector('aside') || document.querySelector('nav');
        if (!sidebar) return { email1: false, email2: false };

        const text = sidebar.innerText || '';
        // Accounts may show as email or as initials; look for email text or
        // title attributes containing the email
        const allEls = sidebar.querySelectorAll('[title], span, div');
        let found1 = false;
        let found2 = false;
        for (const el of allEls) {
          const t = (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
          if (t.includes(email1)) found1 = true;
          if (t.includes(email2)) found2 = true;
        }
        return { email1: found1, email2: found2 };
      }, browser.testEnv.TEST_EMAIL, browser.testEnv.TEST_EMAIL2);

      expect(accountsVisible.email1).toBe(true);
      expect(accountsVisible.email2).toBe(true);
    });
  });
});
