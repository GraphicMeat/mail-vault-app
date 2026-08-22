/**
 * E2E: Connected Compose Fields — the From selector, the recipient/subject
 * inputs, contacts autocomplete + picker, the empty-recipient guard, and the
 * Enter / Shift+Enter split inside a text input.
 *
 * Deliberately NOT re-covered here:
 *   - "New Message" title, Cc/Bcc presence, minimize/maximize
 *     → connected-compose-extended.test.js
 *   - the From row under a send-as override → connected-send-as-alias.test.js
 *   - send delay + undo toast → connected-features.test.js
 *
 * Harness facts this leans on:
 *   - `expect(value, 'message')` throws in this runner (one argument only), so
 *     every explanation is a comment above its assertion.
 *   - The contacts autocomplete only renders while the input is *really*
 *     focused, so that case clicks the input with WebDriver first and only then
 *     sets the value (`setField` alone never focuses; `browser.keys` never
 *     types — under tauri-wd key events drive shortcuts, not text input).
 *   - The harness has no SMTP server, so the submit path is proved through the
 *     recipient guard instead of a real send.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  MODAL,
  openComposeFresh,
  closeComposeHard,
  setField,
  fieldValue,
  keyInField,
  editorText,
  modalOpen,
  modalCount,
  testidPresent,
  testidText,
  clickButtonTitle,
  bubbles,
  outboxItems,
  settingsCall,
} from './composeHelpers.js';

describe('Connected Compose Fields', function () {
  this.timeout(120_000);

  /**
   * 'c' only opens compose when focus is out of a text field — a previous case
   * may have left the caret in an input.
   */
  async function freshCompose() {
    await browser.execute(() => document.activeElement?.blur());
    await openComposeFresh();
  }

  /** The From `<select>`: its current value plus every option. */
  const fromSelect = () => browser.execute(() => {
    const el = document.querySelector('[data-testid="compose-from"]');
    if (!el) return null;
    return {
      value: el.value,
      options: [...el.options].map((o) => ({ value: o.value, text: o.text.trim() })),
    };
  });

  /**
   * Every visible button in the modal that carries an email address in a `<p>`
   * — the shape both the autocomplete dropdown and the contacts popover use for
   * a contact row. Nothing else inside compose renders an address that way, so
   * this finds a suggestion without depending on the field's DOM nesting.
   */
  const contactButtons = () => browser.execute((sel) =>
    [...(document.querySelector(sel)?.querySelectorAll('button') || [])]
      .filter((b) => b.offsetHeight > 0)
      .map((b) => {
        const texts = [...b.querySelectorAll('p')].map((p) => p.textContent.trim());
        const address = texts.find((t) => /^[^\s<>@]+@[^\s<>@]+$/.test(t));
        if (!address) return null;
        return { address, name: texts.find((t) => t !== address) || '' };
      })
      .filter(Boolean), MODAL);

  /**
   * Click a contact row. The autocomplete acts on mousedown (so the input keeps
   * focus) while the popover rows act on click — `viaMouseDown` picks the one
   * that matches the surface under test.
   */
  const pickContact = (address, viaMouseDown) => browser.execute((sel, addr, md) => {
    for (const b of document.querySelector(sel)?.querySelectorAll('button') || []) {
      if (![...b.querySelectorAll('p')].some((p) => p.textContent.trim() === addr)) continue;
      if (md) {
        b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      } else {
        b.click();
      }
      return true;
    }
    return false;
  }, MODAL, address, viaMouseDown);

  const SIG_OFF = { html: '', text: '', enabled: false };

  before(async function () {
    await waitForApp();
    // The contacts index is built from the loaded mailbox headers, so the list
    // has to be on screen before any autocomplete case runs.
    await waitForEmails();
  });

  afterEach(async function () {
    await closeComposeHard();
    // Signatures live in global settings: a case that enables one has to put it
    // back, or every later compose opens with a body it did not ask for.
    for (const a of browser.mockAccounts || []) {
      await settingsCall('setSignature', a.id, SIG_OFF);
    }
  });

  // -------------------------------------------------------------------------
  // From
  // -------------------------------------------------------------------------

  it('lists every account in the From selector and defaults to the active one', async function () {
    await freshCompose();

    const from = await fromSelect();
    // Three mock accounts are seeded, so the From row must render at all.
    expect(from).not.toBe(null);

    const emails = (browser.mockAccounts || []).map((a) => a.email);
    // `name === email` for the mock accounts, so the label is the bare address
    // — no "name <address>" form. Order comes from the account store, so
    // compare as sets.
    expect(from.options.map((o) => o.text).sort()).toEqual([...emails].sort());
    expect(from.options.map((o) => o.value).sort())
      .toEqual((browser.mockAccounts || []).map((a) => `${a.id} ${a.email}`).sort());

    const storeActive = await browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId);
    // The selector value is "<account id> <address>" — one account can offer
    // several addresses — and a new compose starts on the active account,
    // which is account 0 on a fresh spec file.
    expect(from.value.split(' ')[0]).toBe(storeActive);
    expect(from.value).toBe(`${browser.mockAccounts[0].id} ${browser.mockAccounts[0].email}`);
  });

  it('swaps the signature in and out when the From account changes', async function () {
    const accountOne = browser.mockAccounts[0];
    const accountTwo = browser.mockAccounts[1];
    await settingsCall('setSignature', accountTwo.id, {
      html: '<p>Sig Two</p>', text: 'Sig Two', enabled: true,
    });

    await freshCompose();
    // Account 1 has no signature, so the body opens empty.
    expect((await editorText()) || '').not.toContain('Sig Two');

    expect(await setField('compose-from', `${accountTwo.id} ${accountTwo.email}`)).toBe(true);
    await browser.waitUntil(async () => ((await editorText()) || '').includes('Sig Two'), {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: 'Switching From to the second account never inserted its signature — the ComposeModal init effect did not re-run on selectedAccountId',
    });
    // The signature is inserted behind the standard "--" separator.
    expect(await editorText()).toContain('--');

    expect(await setField('compose-from', `${accountOne.id} ${accountOne.email}`)).toBe(true);
    await browser.waitUntil(async () => !((await editorText()) || '').includes('Sig Two'), {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: 'Switching From back to the first account left the second account\'s signature in the body',
    });
  });

  // -------------------------------------------------------------------------
  // Plain fields
  // -------------------------------------------------------------------------

  it('accepts typed values in To, Cc, Bcc and Subject', async function () {
    await freshCompose();

    const values = {
      'compose-to': 'to@example.com',
      'compose-cc': 'cc@example.com',
      'compose-bcc': 'bcc@example.com',
      'compose-subject': 'Field round trip',
    };
    for (const [testid, value] of Object.entries(values)) {
      expect(await setField(testid, value)).toBe(true);
    }
    // Read them all back at the end: the four fields share one formData object,
    // so a later write clobbering an earlier one only shows up this way.
    for (const [testid, value] of Object.entries(values)) {
      expect(await fieldValue(testid)).toBe(value);
    }
  });

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  it('suggests a known sender in To and appends "Name <address>, " when one is picked', async function () {
    await freshCompose();

    // A real WebDriver click: the dropdown renders only while the input is
    // focused, and the focus listener is bound to the input element itself.
    // The value goes in through the React setter — under tauri-wd
    // `browser.keys` drives shortcuts but never produces text in a field.
    const to = await $('[data-testid="compose-to"]');
    await to.click();
    expect(await setField('compose-to', 'sender')).toBe(true);

    let matches = [];
    await browser.waitUntil(async () => {
      matches = await contactButtons();
      return matches.length > 0;
    }, {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: 'No contact suggestions for "sender" — the contacts index (src/utils/contactsIndex.js) produced no match from the loaded mailbox headers',
    });

    // The mock fixtures send from `Sender N <senderN@example.com>` and one
    // "Quoting Sender <quoted@example.com>" — "sender" matches both by name, and
    // the ranking between them is recency-based (it flipped between a solo run
    // and the full suite), so assert membership, not rank.
    const isFixtureSender = (m) => /^sender\d+@example\.com$/.test(m.address);
    expect(matches.some(isFixtureSender)).toBe(true);
    const pick = matches.find(isFixtureSender);
    expect(await pickContact(pick.address, true)).toBe(true);
    await browser.pause(300);

    const expected = pick.name ? `${pick.name} <${pick.address}>, ` : `${pick.address}, `;
    // Picking replaces the partial token and leaves the field ready for the
    // next recipient — hence the trailing comma+space.
    expect(await fieldValue('compose-to')).toBe(expected);
  });

  it('lists contacts in the To picker popover and appends the one that is picked', async function () {
    await freshCompose();

    expect(await clickButtonTitle('Pick TO from contacts')).toBe(true);

    let contacts = [];
    await browser.waitUntil(async () => {
      contacts = await contactButtons();
      return contacts.length > 0;
    }, {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: 'The TO contacts popover listed no contacts — the contacts index (src/utils/contactsIndex.js) is empty for the compose From account',
    });

    const pick = contacts[0];
    expect(await pickContact(pick.address, false)).toBe(true);
    await browser.pause(300);

    const expected = pick.name ? `${pick.name} <${pick.address}>, ` : `${pick.address}, `;
    expect(await fieldValue('compose-to')).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // Validation and the submit path
  // -------------------------------------------------------------------------

  it('refuses to send without a recipient and clears the error on the next edit', async function () {
    await freshCompose();

    expect(await clickButtonTitle('Send (Shift+Enter)')).toBe(true);
    await browser.waitUntil(() => testidPresent('compose-error'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'Send with an empty To showed no compose-error banner — the recipient guard in ComposeModal.handleSend never fired',
    });
    expect(await testidText('compose-error')).toContain('Please enter at least one recipient');
    // A rejected submit must not reach the outbox at all.
    expect((await outboxItems()).length).toBe(0);
    expect(await modalOpen()).toBe(true);

    await setField('compose-to', 'someone@example.com');
    // Any field change clears the banner — the error is not sticky.
    expect(await testidPresent('compose-error')).toBe(false);
  });

  it('does not submit the form on Enter inside the Subject input', async function () {
    await freshCompose();
    await setField('compose-subject', 'Enter must not send');
    await keyInField('compose-subject', 'Enter');

    // With To empty, a submit would surface the recipient error. No banner and
    // no outbox item means Enter never reached handleSend.
    expect(await testidPresent('compose-error')).toBe(false);
    expect((await outboxItems()).length).toBe(0);
    expect(await modalOpen()).toBe(true);
  });

  it('submits the form on Shift+Enter inside the Subject input', async function () {
    await freshCompose();
    await setField('compose-subject', 'Shift+Enter sends');
    await keyInField('compose-subject', 'Enter', { shiftKey: true });

    // No SMTP in the harness, so the empty To is what makes the submit path
    // visible: the guard only runs once handleSend is entered.
    await browser.waitUntil(() => testidPresent('compose-error'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'Shift+Enter in the Subject input never submitted — the form onKeyDown branch in ComposeModal did not call handleSend',
    });
    expect(await testidText('compose-error')).toContain('Please enter at least one recipient');
  });

  // -------------------------------------------------------------------------
  // Signature
  // -------------------------------------------------------------------------

  it('shows an enabled signature on open without making the draft dirty', async function () {
    const accountOne = browser.mockAccounts[0];
    await settingsCall('setSignature', accountOne.id, {
      html: '<p>Sig One</p>', text: 'Sig One', enabled: true,
    });

    await freshCompose();
    const body = (await editorText()) || '';
    expect(body).toContain('Sig One');
    expect(body).toContain('--');

    expect(await clickButtonTitle('Close')).toBe(true);
    // A signature the app inserted is not something the user wrote, so Close
    // must not stop to ask whether to discard it.
    expect(await testidPresent('compose-discard-dialog')).toBe(false);
    await browser.waitUntil(async () => (await modalCount()) === 0, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'Close on a signature-only compose did not close it — hasUserContent counted the signature as user content',
    });
    // Closed, not minimized.
    expect((await bubbles()).length).toBe(0);
  });
});
