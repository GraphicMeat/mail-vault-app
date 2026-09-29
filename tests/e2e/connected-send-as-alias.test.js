/**
 * E2E: Send-as alias — the outgoing From address is decoupled from the login.
 *
 * Reported by a Fastmail user who logs in as ABC@ but needs mail to leave as
 * DEF@, without a Reply-To header.
 *
 * The MIME the app hands to SMTP is what these cases assert, via the same
 * `smtp_build_mime` command the compose flow uses to stage the local .eml —
 * that is where the From header is decided, so it is the real proof. The verify
 * flow's failure path addresses `SEND_REFUSED_TO`, which the harness's mock
 * SMTP server answers 550.
 *
 * Aliases live in Settings > Accounts > Aliases: the cases there add, name and
 * default an alias through the section's own controls (`data-testid` hooks),
 * then build the MIME the way compose would send from that default.
 */

import {
  waitForApp,
  waitForEmails,
  openSettings,
  closeSettings,
  clickSettingsNav,
  openCompose,
  pressKey,
} from './helpers.js';
import { SEND_REFUSED_TO } from './mockImap.js';
import { closeComposeHard } from './composeHelpers.js';

const ALIAS = 'alias@mock.test';
const OTHER_DOMAIN_ALIAS = 'hello@graphicmeat.com';

describe('Connected Send-As Alias', function () {
  this.timeout(180_000);

  /**
   * `browser.execute()` serializes the return value before a Promise settles,
   * so a Tauri invoke has to go through the execute/async endpoint.
   */
  function invoke(cmd, args) {
    return browser.executeAsync((c, a, done) => {
      window.__TAURI__.core.invoke(c, a)
        .then((r) => done({ ok: true, value: r }))
        .catch((e) => done({ ok: false, error: String((e && e.message) || e) }));
    }, cmd, args);
  }

  const firstAccount = () => browser.execute(() => {
    const a = window.__MAIL_STORE__.getState().accounts[0];
    return a ? JSON.parse(JSON.stringify(a)) : null;
  });

  const setSendAs = (accountId, address) => browser.execute((id, addr) => {
    window.__SETTINGS_STORE__.getState().setSendAsAddress(id, addr);
  }, accountId, address);

  const readSendAs = (accountId) => browser.execute((id) =>
    window.__SETTINGS_STORE__.getState().getSendAsAddress(id), accountId);

  // The daemon's alias lookup (`aliases.discover`) reads the From of this cache.
  const SEEDED = 'previously-used@mock.test';

  /**
   * Seed the Sent header cache directly: alias discovery reads the cached
   * headers, and waiting for a Sent sync would make the assertion depend on
   * prefetch timing.
   *
   * Task 2.7: `save_email_cache` moved into the daemon (`DAEMON_OWNED`) — the
   * raw `window.__TAURI__.core.invoke('save_email_cache', ...)` this file's
   * own `invoke` helper does no longer reaches a registered Tauri command,
   * so this one call site routes through `daemon_rpc` instead. `invoke`
   * itself stays unchanged. `smtp_build_mime` below (`buildHeaders`) needed
   * the same treatment once Task 5.5 moved it too.
   */
  const seedSentCache = () => invoke('daemon_rpc', { method: 'save_email_cache', params: {
    accountId: account.id,
    mailbox: 'Sent',
    data: JSON.stringify({
      accountId: account.id,
      mailbox: 'Sent',
      totalEmails: 1,
      lastSynced: Date.now(),
      emails: [{
        uid: 90001,
        subject: 'Earlier message',
        from: { address: SEEDED, name: 'Me' },
        to: [{ address: 'friend@example.com', name: '' }],
        cc: [],
        bcc: [],
        date: '2026-08-01T10:00:00.000Z',
        flags: ['\\Seen'],
      }],
    }),
  } });

  /**
   * Decode the staged MIME and pull out its header block.
   *
   * Task 5.5: `smtp_build_mime` moved into the daemon (`DAEMON_OWNED`) — same
   * treatment as `seedSentCache`'s `save_email_cache` above, routed through
   * `daemon_rpc` instead of a raw Tauri command that no longer exists.
   */
  async function buildHeaders(account, extra = {}) {
    const res = await invoke('daemon_rpc', { method: 'smtp_build_mime', params: {
      account: { ...account, ...extra },
      email: {
        to: 'someone@example.com',
        subject: 'Send-as check',
        text: 'body',
      },
    } });
    if (!res.ok) throw new Error(`smtp_build_mime failed: ${res.error}`);
    const raw = await browser.execute((b64) => atob(b64), res.value.rawBase64);
    const end = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
    return { headers: end > 0 ? raw.slice(0, end) : raw, messageId: res.value.messageId };
  }

  const headerLine = (headers, name) =>
    headers.split(/\r?\n/).find(l => l.toLowerCase().startsWith(name.toLowerCase() + ':')) || '';

  let account;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    account = await firstAccount();
    expect(account).not.toBe(null);
  });

  afterEach(async function () {
    await clearAliases(account.id);
  });

  describe('outgoing MIME', function () {
    it('puts the send-as address in From while the login stays untouched', async function () {
      const { headers } = await buildHeaders(account, { fromEmail: ALIAS });

      const from = headerLine(headers, 'From');
      // Mock accounts carry no display name (name === address), so From is the bare
      // address: a name that is just the address is RFC 2047-encoded and Purelymail
      // refuses the header (501 5.1.7).
      expect(from).toBe(`From: ${ALIAS}`);
      // The login address must not leak into any header — the whole point is
      // that the recipient never sees it.
      expect(headers.toLowerCase()).not.toContain(account.email.toLowerCase());
      // The reporter explicitly does not want a Reply-To. Adding one would
      // "work" and be the wrong fix.
      expect(headerLine(headers, 'Reply-To')).toBe('');
    });

    it('falls back to the login address when no override is set', async function () {
      const { headers } = await buildHeaders(account);
      expect(headerLine(headers, 'From')).toBe(`From: ${account.email}`);
    });

    it('treats a blank override as no override', async function () {
      const { headers } = await buildHeaders(account, { fromEmail: '   ' });
      expect(headerLine(headers, 'From')).toBe(`From: ${account.email}`);
    });

    it('follows the From domain for Message-ID', async function () {
      // Receivers' DMARC/spam heuristics read the From domain, so a Message-ID
      // stamped with the login domain is a cross-domain mismatch.
      const { headers } = await buildHeaders(account, { fromEmail: OTHER_DOMAIN_ALIAS });
      const msgId = headerLine(headers, 'Message-ID');
      // Bracketed per RFC 5322 §3.6.4 — the closing `>` is part of the assert
      // because lettre passes the value through verbatim and will happily emit
      // a malformed header if we hand it one.
      expect(msgId).toContain('@graphicmeat.com>');
      expect(msgId).not.toContain(account.email.split('@')[1]);
    });

    it('returns the Message-ID in the same form the header carries', async function () {
      // The compose flow puts this value on the optimistic Sent entry and later
      // dedupes it against the server's copy, whose `messageId` comes from
      // `parse_header` — which keeps the angle brackets. Normalising here (in
      // either direction) makes the optimistic row unmatchable and it never
      // clears. Byte-equality with the header is the contract.
      const { headers, messageId } = await buildHeaders(account);
      const headerValue = headerLine(headers, 'Message-ID').replace(/^Message-ID:\s*/i, '');
      expect(headerValue).not.toBe('');
      expect(messageId).toBe(headerValue);
    });
  });

  const ALIAS_NAME = 'Front Desk';

  /**
   * Aliases persist in settings, and the sibling compose specs count the From
   * options: every case leaves the account with no aliases, nothing dismissed
   * and the login as its default From. `removeAlias` alone would leave the
   * address on the dismissed list, which discovery then skips.
   */
  const clearAliases = (accountId) => browser.execute((id) => {
    const state = window.__SETTINGS_STORE__.getState();
    window.__SETTINGS_STORE__.setState({
      aliases: { ...state.aliases, [id]: [] },
      dismissedAliases: { ...state.dismissedAliases, [id]: [] },
      sendAsAddresses: { ...state.sendAsAddresses, [id]: '' },
    });
  }, accountId);

  const readAliases = (accountId) => browser.execute((id) =>
    JSON.parse(JSON.stringify(window.__SETTINGS_STORE__.getState().aliases?.[id] || [])), accountId);

  const rowSelector = (address) => `[data-testid="alias-row"][data-address="${address}"]`;

  /** Set an input's value the way React hears typing. */
  const typeInto = (selector, value) => browser.execute((sel, v) => {
    const input = document.querySelector(sel);
    if (!input) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, selector, value);

  const click = (selector) => browser.execute((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.disabled) return false;
    el.click();
    return true;
  }, selector);

  /** Settings > Accounts > Aliases, for the first account. */
  async function openAliases() {
    await openSettings();
    await clickSettingsNav('Accounts');
    expect(await clickSettingsNav('Aliases')).toBe(true);
    await browser.waitUntil(() => browser.execute((login) =>
      document.querySelector('[data-testid="alias-row"][data-login="true"]')?.getAttribute('data-address') === login,
    account.email), { timeout: 5000, interval: 100, timeoutMsg: `Aliases did not open on ${account.email}` });
  }

  /** Type an address into the add row and press Add. */
  async function addAliasByHand(address) {
    expect(await typeInto('[data-testid="alias-add-input"]', address)).toBe(true);
    await browser.waitUntil(() => click('[data-testid="alias-add-btn"]'), {
      timeout: 5000, interval: 100, timeoutMsg: 'Add stayed disabled after typing an address',
    });
  }

  describe('aliases section', function () {
    beforeEach(async function () {
      await clearAliases(account.id);
    });

    afterEach(async function () {
      await closeSettings();
      await clearAliases(account.id);
    });

    it('adds an alias, names it and makes it the default From, which the outgoing MIME carries', async function () {
      await openAliases();
      await addAliasByHand(ALIAS);
      await browser.waitUntil(() => browser.execute((sel) => !!document.querySelector(sel), rowSelector(ALIAS)), {
        timeout: 5000, interval: 100, timeoutMsg: 'the added alias never showed in the list',
      });
      // Opening the section also looks for aliases; only the typed one matters here.
      expect((await readAliases(account.id)).filter(a => a.address === ALIAS).map(a => a.source)).toEqual(['manual']);
      expect(await browser.execute(() => !!document.querySelector('[data-testid="aliases-empty"]'))).toBe(false);

      // The name autosaves a moment after typing stops.
      expect(await typeInto(`${rowSelector(ALIAS)} [data-testid="alias-name-input"]`, ALIAS_NAME)).toBe(true);
      await browser.waitUntil(async () => (await readAliases(account.id)).find(a => a.address === ALIAS)?.name === ALIAS_NAME, {
        timeout: 5000, interval: 200, timeoutMsg: 'the alias name was never saved',
      });

      expect(await click(`${rowSelector(ALIAS)} [data-testid="alias-default-radio"]`)).toBe(true);
      await browser.waitUntil(async () => (await readSendAs(account.id)) === ALIAS, {
        timeout: 5000, interval: 100, timeoutMsg: 'choosing the alias did not make it the default From',
      });
      expect(await browser.execute((sel) => document.querySelector(`${sel} [data-testid="alias-default-radio"]`)?.checked,
        rowSelector(account.email))).toBe(false);

      // What compose hands the sender for a message from the default From:
      // that address, under the alias's own name (composeSenderName).
      const pointer = await readSendAs(account.id);
      const name = (await readAliases(account.id)).find(a => a.address === pointer)?.name;
      const { headers } = await buildHeaders(account, { fromEmail: pointer, name });
      const from = headerLine(headers, 'From');
      expect(from).toContain(ALIAS_NAME);
      expect(from).toContain(`<${ALIAS}>`);
      expect(headers.toLowerCase()).not.toContain(account.email.toLowerCase());
    });

    it('says why an address cannot be added', async function () {
      await openAliases();
      await addAliasByHand(account.email.toUpperCase());
      await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="alias-add-error"]')), {
        timeout: 5000, interval: 100, timeoutMsg: 'adding the login address gave no reason',
      });
      expect((await readAliases(account.id)).some(a => a.address.toLowerCase() === account.email.toLowerCase())).toBe(false);
    });

    it('lists an address this mailbox has sent as, found in its own mail', async function () {
      // `aliases.discover` reads the From of the cached Sent headers. A
      // background Sent sync can rewrite that cache underneath us, so re-seed
      // and look again rather than wait on a value that cannot change.
      await openAliases();
      let found = false;
      for (let attempt = 0; attempt < 5 && !found; attempt++) {
        expect((await seedSentCache()).ok).toBe(true);
        await browser.waitUntil(() => click('[data-testid="aliases-refresh-btn"]'), {
          timeout: 20_000, interval: 250, timeoutMsg: 'Look for aliases stayed busy',
        });
        // Let the click render its spinner before waiting for it to go.
        await browser.pause(300);
        await browser.waitUntil(() => browser.execute(() =>
          document.querySelector('[data-testid="aliases-status"]')?.getAttribute('data-status') !== 'running'), {
          timeout: 30_000, interval: 250, timeoutMsg: 'the alias lookup never finished',
        });
        found = await browser.execute((sel) => !!document.querySelector(sel), rowSelector(SEEDED));
      }
      if (!found) throw new Error(`Aliases never listed ${SEEDED}; saw ${JSON.stringify(await readAliases(account.id))}`);

      expect(await browser.execute((sel) => document.querySelector(`${sel} [data-testid="alias-source-badge"]`)?.textContent,
        rowSelector(SEEDED))).toBe('Seen in your mail');
      // The mock account signs in with a password: no provider list to ask.
      expect(await browser.execute(() =>
        document.querySelector('[data-testid="aliases-status"]')?.getAttribute('data-status'))).toBe('unsupported');
      // The login is listed once, as the login.
      expect(await browser.execute((login) =>
        document.querySelectorAll(`[data-testid="alias-row"][data-address="${login}"]`).length, account.email)).toBe(1);
      // Not asserted here: a suggestion from mail delivered to an alias. The
      // daemon reads `Delivered-To` from the Inbox .eml files in the vault,
      // and seeding one there has no cheap route through this harness; the
      // component spec (AliasesSection.test.jsx) covers suggestions.
    });

    it('reports the server error from Verify instead of claiming success', async function () {
      // Addressed to the one recipient the mock SMTP server refuses, so the
      // submission must fail: the assertion is that the failure surfaces in
      // the modal rather than being swallowed or reported as verified.
      await openAliases();
      await addAliasByHand(ALIAS);
      await browser.waitUntil(() => click(`${rowSelector(ALIAS)} [data-testid="alias-verify-btn"]`), {
        timeout: 5000, interval: 100, timeoutMsg: 'the alias row has no Verify button',
      });
      await browser.pause(400);

      const modalState = await browser.execute(() => {
        const modal = document.querySelector('[data-testid="send-as-verify-modal"]');
        if (!modal) return null;
        return {
          recipient: modal.querySelector('[data-testid="send-as-verify-recipient"]')?.value || '',
          text: modal.textContent || '',
        };
      });
      expect(modalState).not.toBe(null);
      // Defaults to the user's own mailbox, the safest place for a test message.
      expect(modalState.recipient).toBe(account.email);
      expect(modalState.text).toContain(ALIAS);

      // Re-address it at the refused recipient: any other address is delivered
      // now, and a delivered test message would verify instead of failing.
      const readdressed = await browser.execute((to) => {
        const el = document.querySelector('[data-testid="send-as-verify-recipient"]');
        if (!el) return false;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, to);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value === to;
      }, SEND_REFUSED_TO);
      expect(readdressed).toBe(true);

      await browser.execute(() =>
        document.querySelector('[data-testid="send-as-verify-send"]')?.click());

      const result = () => browser.execute(() => {
        const el = document.querySelector('[data-testid="send-as-verify-result"]');
        return el ? { status: el.getAttribute('data-status'), text: el.textContent.trim() } : null;
      });

      await browser.waitUntil(async () => (await result()) !== null, {
        timeout: 90_000,
        interval: 500,
        timeoutMsg: 'verify never reported a result',
      });
      const outcome = await result();
      expect(outcome.status).toBe('error');
      expect(outcome.text.length).toBeGreaterThan(0);

      await browser.execute(() => {
        const modal = document.querySelector('[data-testid="send-as-verify-modal"]');
        modal?.querySelector('button[aria-label="Close"]')?.click();
      });
      await browser.waitUntil(() => browser.execute(() =>
        !document.querySelector('[data-testid="send-as-verify-modal"]')), {
        timeout: 5000, interval: 100, timeoutMsg: 'Verify dialog did not close',
      });
    });
  });

  describe('compose', function () {
    beforeEach(async () => {
      // The compose shortcut deliberately ignores typing in a focused input.
      await browser.execute(() => document.activeElement?.blur());
    });
    afterEach(async () => { await closeComposeHard(); });

    /** The From `<select>`: every option plus which one is selected. */
    const fromSelect = () => browser.execute(() => {
      const el = document.querySelector('[data-testid="compose-from"]');
      if (!el) return null;
      return {
        selectedIndex: el.selectedIndex,
        options: [...el.options].map(o => ({ value: o.value, text: o.text.trim() })),
      };
    });

    const selectFrom = (value) => browser.execute((v) => {
      const el = document.querySelector('[data-testid="compose-from"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);

    async function closeCompose() {
      await pressKey('Escape');
      await browser.pause(300);
      await browser.execute(() => {
        for (const btn of document.querySelectorAll('button')) {
          if ((btn.textContent || '').trim() === 'Discard' && btn.offsetHeight > 0) btn.click();
        }
        for (const bubble of document.querySelectorAll('[data-testid="compose-bubble"]')) {
          bubble.querySelector('button')?.click();
        }
      });
      await browser.pause(300);
    }

    it('shows the send-as address in the From row', async function () {
      await setSendAs(account.id, ALIAS);
      await openCompose();
      await browser.pause(400);

      const fromText = await browser.execute(() => {
        const select = document.querySelector('[data-testid="compose-modal"] select');
        if (!select) return null;
        const opt = select.options[select.selectedIndex];
        return opt ? opt.textContent.trim() : null;
      });
      expect(fromText).not.toBe(null);
      expect(fromText).toContain(ALIAS);
      expect(fromText).not.toContain(account.email);

      await closeCompose();
    });

    it('offers the login address under the alias so one message can leave from either', async function () {
      await setSendAs(account.id, ALIAS);
      await openCompose();
      await browser.pause(400);

      const from = await fromSelect();
      expect(from).not.toBe(null);
      expect(from.options[from.selectedIndex].text).toBe(ALIAS);
      // The override leads, the login follows — both belong to this account, so
      // one message can leave as either without touching settings.
      expect(from.options.map(o => o.text).slice(0, 2)).toEqual([ALIAS, account.email]);
      // Every option value is "<account id> <address>"; the two above carry THIS
      // account's id, so picking the login never switches the sending account.
      expect(from.options.slice(0, 2).every(o => o.value.startsWith(`${account.id} `))).toBe(true);

      await selectFrom(`${account.id} ${account.email}`);
      await browser.pause(200);
      const after = await fromSelect();
      expect(after.options[after.selectedIndex].text).toBe(account.email);

      await closeCompose();
    });

    it('links from the From row to Settings > Accounts > Aliases', async function () {
      await openCompose();
      await browser.waitUntil(() => click('[data-testid="compose-add-address"]'), {
        timeout: 5000, interval: 100, timeoutMsg: 'the From row has no Add address link',
      });
      await browser.waitUntil(() => browser.execute(() => {
        const root = document.querySelector('[data-testid="settings-page"][role="dialog"]');
        return !!root && [...root.querySelectorAll('[role="tab"][aria-selected="true"]')]
          .some(tab => tab.textContent.trim() === 'Aliases');
      }), { timeout: 5000, interval: 100, timeoutMsg: 'Add address did not open Settings > Accounts > Aliases' });
      expect(await browser.execute(() =>
        document.querySelector('[data-testid="alias-row"][data-login="true"]')?.getAttribute('data-address'))).toBe(account.email);
      await closeSettings();
    });
  });
});
