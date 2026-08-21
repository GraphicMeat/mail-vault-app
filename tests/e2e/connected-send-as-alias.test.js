/**
 * E2E: Send-as alias — the outgoing From address is decoupled from the login.
 *
 * Reported by a Fastmail user who logs in as ABC@ but needs mail to leave as
 * DEF@, without a Reply-To header.
 *
 * The harness has NO SMTP server (mockImap points smtpHost at the mock IMAP
 * port), so a real submission cannot be asserted end to end. The MIME the app
 * hands to SMTP is asserted instead, via the same `smtp_build_mime` command the
 * compose flow uses to stage the local .eml — that is where the From header is
 * decided, so it is the real proof. The verify flow's failure path is covered
 * against that same non-SMTP port.
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

  /** Decode the staged MIME and pull out its header block. */
  async function buildHeaders(account, extra = {}) {
    const res = await invoke('smtp_build_mime', {
      account: { ...account, ...extra },
      email: {
        to: 'someone@example.com',
        subject: 'Send-as check',
        text: 'body',
      },
    });
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
    await setSendAs(account.id, '');
  });

  describe('outgoing MIME', function () {
    it('puts the send-as address in From while the login stays untouched', async function () {
      const { headers } = await buildHeaders(account, { fromEmail: ALIAS });

      const from = headerLine(headers, 'From');
      expect(from).toContain(`<${ALIAS}>`);
      // The login address must not leak into any header — the whole point is
      // that the recipient never sees it.
      expect(headers.toLowerCase()).not.toContain(account.email.toLowerCase());
      // The reporter explicitly does not want a Reply-To. Adding one would
      // "work" and be the wrong fix.
      expect(headerLine(headers, 'Reply-To')).toBe('');
    });

    it('falls back to the login address when no override is set', async function () {
      const { headers } = await buildHeaders(account);
      expect(headerLine(headers, 'From')).toContain(`<${account.email}>`);
    });

    it('treats a blank override as no override', async function () {
      const { headers } = await buildHeaders(account, { fromEmail: '   ' });
      expect(headerLine(headers, 'From')).toContain(`<${account.email}>`);
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

  describe('settings field', function () {
    beforeEach(async function () {
      await openSettings();
      await clickSettingsNav('Accounts');
    });

    afterEach(async function () {
      await closeSettings();
    });

    it('persists what the user types and clears back to the login address', async function () {
      const typed = await browser.execute((value) => {
        const input = document.querySelector('[data-testid="send-as-input"]');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }, ALIAS);
      expect(typed).toBe(true);

      // Autosave is debounced at 400ms.
      await browser.waitUntil(async () => (await readSendAs(account.id)) === ALIAS, {
        timeout: 10_000,
        interval: 200,
        timeoutMsg: 'send-as address was never persisted',
      });

      // Reopening the tab must show the stored value, not an empty field.
      await clickSettingsNav('General');
      await clickSettingsNav('Accounts');
      const shown = await browser.execute(() =>
        document.querySelector('[data-testid="send-as-input"]')?.value || '');
      expect(shown).toBe(ALIAS);
    });

    it('disables Verify until the address is a plausible mailbox', async function () {
      const disabledFor = async (value) => {
        await browser.execute((v) => {
          const input = document.querySelector('[data-testid="send-as-input"]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, v);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, value);
        await browser.pause(150);
        return browser.execute(() =>
          document.querySelector('[data-testid="send-as-verify-btn"]')?.disabled);
      };

      expect(await disabledFor('')).toBe(true);
      expect(await disabledFor('not-an-address')).toBe(true);
      expect(await disabledFor(ALIAS)).toBe(false);
    });
  });

  describe('suggestions', function () {
    it('offers an address this mailbox has already sent as', async function () {
      // Seed the Sent header cache directly: alias discovery reads the cached
      // headers, and waiting for a Sent sync would make the assertion depend on
      // prefetch timing.
      const seeded = 'previously-used@mock.test';
      const seedSentCache = () => invoke('save_email_cache', {
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
            from: { address: seeded, name: 'Me' },
            to: [{ address: 'friend@example.com', name: '' }],
            cc: [],
            bcc: [],
            date: '2026-08-01T10:00:00.000Z',
            flags: ['\\Seen'],
          }],
        }),
      });
      expect((await seedSentCache()).ok).toBe(true);

      await openSettings();
      await clickSettingsNav('Accounts');

      const chips = () => browser.execute(() =>
        [...document.querySelectorAll('[data-testid="send-as-suggestions"] button')]
          .map(b => b.textContent.trim()));

      // The suggestion list is computed once per account selection, and a
      // background Sent sync can rewrite the cache underneath us — so re-seed
      // and re-enter the tab rather than polling a value that cannot change.
      let found = false;
      for (let attempt = 0; attempt < 5 && !found; attempt++) {
        found = (await chips()).includes(seeded);
        if (found) break;
        await seedSentCache();
        await clickSettingsNav('General');
        await clickSettingsNav('Accounts');
        await browser.pause(600);
        found = (await chips()).includes(seeded);
      }
      if (!found) {
        throw new Error(`send-as suggestions never offered ${seeded}; saw ${JSON.stringify(await chips())}`);
      }

      // Never suggest the login address — it is what the blank field already means.
      expect(await chips()).not.toContain(account.email);

      // Clicking a suggestion fills the field.
      await browser.execute((wanted) => {
        for (const b of document.querySelectorAll('[data-testid="send-as-suggestions"] button')) {
          if (b.textContent.trim() === wanted) { b.click(); return; }
        }
      }, seeded);
      await browser.pause(200);
      const value = await browser.execute(() =>
        document.querySelector('[data-testid="send-as-input"]')?.value || '');
      expect(value).toBe(seeded);

      await closeSettings();
    });
  });

  describe('verify button', function () {
    it('reports the server error instead of claiming success', async function () {
      // The mock port speaks IMAP, not SMTP, so submission must fail — the
      // assertion is that the failure surfaces in the modal rather than being
      // swallowed or silently reported as verified.
      await setSendAs(account.id, ALIAS);
      await openSettings();
      await clickSettingsNav('Accounts');

      await browser.execute(() =>
        document.querySelector('[data-testid="send-as-verify-btn"]')?.click());
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
      // Defaults to the user's own mailbox — the safest place for a test message.
      expect(modalState.recipient).toBe(account.email);
      expect(modalState.text).toContain(ALIAS);

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
        modal?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await browser.pause(200);
      await closeSettings();
    });
  });

  describe('compose', function () {
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
    });
  });
});
