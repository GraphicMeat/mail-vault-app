/**
 * E2E: Connected Compose Reply Modes — what Reply / Reply All / Forward
 * prefill, where the original message ends up, and what carries across a
 * minimize.
 *
 * The selected email is SEEDED into the store rather than clicked in the list:
 * the mock fixtures carry no Cc and no attachments, and both are exactly what
 * the Reply-All filter and the Forward attachment carry-over need to be proved
 * against. `selectionStore` is a facade over `__MAIL_STORE__`, so writing
 * `selectedEmail` straight into the store is the same state the keyboard
 * actions in App.jsx read (`useMailStore.getState().selectedEmail`).
 *
 * The seeded email's `_accountId` is account 0, which is also what ComposeModal
 * picks as the compose account (`replyTo._accountId || activeAccountId`) — so
 * the "drop my own address" filtering is deterministic regardless of which
 * account happens to be active.
 *
 * Harness facts this leans on:
 *   - Character keys reach the webview, but only when focus is NOT in an input
 *     or contentEditable — every mode is opened after an explicit blur.
 *   - framer-motion exits never finish under the occluded E2E window, so cases
 *     assert the state they moved to.
 *   - `expect(value, 'message')` throws in this runner (one argument only).
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  closeComposeHard,
  setField,
  fieldValue,
  editorText,
  attachments,
  removeAttachment,
  modalOpen,
  modalCount,
  modalTitle,
  testidPresent,
  testidText,
  clickButtonTitle,
  bubbles,
  clickBubble,
  mailStoreSet,
  settingsCall,
} from './composeHelpers.js';

describe('Connected Compose Reply Modes', function () {
  this.timeout(120_000);

  const SIG_OFF = { html: '', text: '', enabled: false };
  const SUBJECT = 'Quarterly numbers';
  const SENDER = 'ann@example.com';
  const OTHER_TO = 'bob@example.com';
  const OTHER_CC = 'carol@example.com';

  /** The seeded original. Built in `before`, once the mock accounts are known. */
  let EMAIL = null;
  let accountOne = null;

  /** Click any element by data-testid (the quoted toggle is a plain button). */
  async function clickTestid(testid) {
    const ok = await browser.execute((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el || el.offsetHeight === 0) return false;
      el.click();
      return true;
    }, testid);
    await browser.pause(250);
    return ok;
  }

  /**
   * Seed `email` as the selection and open compose in the mode bound to `key`
   * ('r' | 'a' | 'f'). The store write is repeated right before the keypress:
   * the viewer can replace `selectedEmail` asynchronously while a body fetch
   * settles, and the shortcut reads the store at press time.
   */
  async function openMode(email, key) {
    await closeComposeHard();
    const selection = { selectedEmail: email, selectedEmailId: email.uid, selectedThread: null };
    await mailStoreSet(selection);
    await browser.execute(() => document.activeElement?.blur());
    await mailStoreSet(selection);
    await browser.keys(key);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: `Compose did not open on "${key}" — the App keyboard action found no selectedEmail in the store, or the key never reached the webview`,
    });
    await browser.pause(300);
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    accountOne = browser.mockAccounts[0];
    EMAIL = {
      uid: 424242,
      subject: SUBJECT,
      from: { name: 'Ann Sender', address: SENDER },
      to: [{ address: accountOne.email }, { address: OTHER_TO }],
      cc: [{ address: OTHER_CC }, { address: accountOne.email }],
      replyTo: [],
      date: '2026-08-01T10:00:00.000Z',
      messageId: '<orig-424242@example.com>',
      text: 'Original plain body',
      html: '<p>Original <b>html</b> body</p>',
      attachments: [{
        filename: 'deck.pdf', contentType: 'application/pdf', size: 3, content: 'JVBE',
      }],
      flags: ['\\Seen'],
      _accountId: accountOne.id,
    };
  });

  afterEach(async function () {
    await closeComposeHard();
    // Leave the selection empty: a seeded email that outlives its spec makes
    // every later "r"/"f" press open a compose nobody asked for.
    await mailStoreSet({ selectedEmail: null, selectedEmailId: null, selectedThread: null });
    for (const a of browser.mockAccounts || []) {
      await settingsCall('setSignature', a.id, SIG_OFF);
    }
  });

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  it('prefills a Reply and keeps the original behind a collapsible toggle', async function () {
    await openMode(EMAIL, 'r');

    expect(await modalTitle()).toBe('Reply');
    expect(await fieldValue('compose-to')).toBe(SENDER);
    expect(await fieldValue('compose-subject')).toBe(`Re: ${SUBJECT}`);
    // A plain reply goes to the sender only — nobody is carried into Cc.
    expect(await fieldValue('compose-cc')).toBe('');

    // The original is quoted OUTSIDE the editor, collapsed by default, so the
    // user types into an empty body.
    expect(await testidPresent('compose-quoted-toggle')).toBe(true);
    expect(await testidText('compose-quoted-toggle')).toBe('Show original message');
    expect(await testidPresent('compose-quoted')).toBe(false);
    expect((await editorText()) || '').not.toContain('Original Message');

    expect(await clickTestid('compose-quoted-toggle')).toBe(true);
    await browser.waitUntil(() => testidPresent('compose-quoted'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The quoted original did not expand when its toggle was clicked',
    });
    const quoted = await testidText('compose-quoted');
    expect(quoted).toContain('Original Message');
    expect(quoted).toContain('Ann Sender');
    expect(quoted).toContain(SUBJECT);
    // The original body itself, not just its headers.
    expect(quoted).toContain('Original html body');
    expect(await testidText('compose-quoted-toggle')).toBe('Hide original message');

    expect(await clickTestid('compose-quoted-toggle')).toBe(true);
    await browser.waitUntil(async () => !(await testidPresent('compose-quoted')), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The quoted original did not collapse again on a second toggle click',
    });
    expect(await testidText('compose-quoted-toggle')).toBe('Show original message');
  });

  it('keeps a single "Re:" when replying to a subject that already has one', async function () {
    await openMode({ ...EMAIL, subject: `Re: ${SUBJECT}` }, 'r');
    expect(await fieldValue('compose-subject')).toBe(`Re: ${SUBJECT}`);
  });

  // -------------------------------------------------------------------------
  // Reply All
  // -------------------------------------------------------------------------

  it('fills To and Cc on Reply All and drops the account\'s own address', async function () {
    await openMode(EMAIL, 'a');

    expect(await modalTitle()).toBe('Reply All');

    const to = await fieldValue('compose-to');
    expect(to).toContain(SENDER);
    expect(to).toContain(OTHER_TO);
    // Replying to yourself is the classic Reply-All bug — the compose account's
    // own address must be filtered out of both rows.
    expect(to).not.toContain(accountOne.email);

    const cc = await fieldValue('compose-cc');
    expect(cc).toContain(OTHER_CC);
    expect(cc).not.toContain(accountOne.email);

    expect(await fieldValue('compose-subject')).toBe(`Re: ${SUBJECT}`);
  });

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  it('prefills a Forward with the original inline and carries its attachment', async function () {
    await openMode(EMAIL, 'f');

    expect(await modalTitle()).toBe('Forward');
    expect(await fieldValue('compose-subject')).toBe(`Fwd: ${SUBJECT}`);
    // A forward has no recipient yet — that is the one thing the user must add.
    expect(await fieldValue('compose-to')).toBe('');

    // Unlike a reply, the original is part of the editable body, so there is no
    // collapsed-quote toggle to expand.
    const body = (await editorText()) || '';
    expect(body).toContain('Original Message');
    expect(body).toContain('Original html body');
    expect(await testidPresent('compose-quoted-toggle')).toBe(false);

    expect(await attachments()).toContain('deck.pdf');
    expect(await testidText('compose-attachments')).toContain('1 Attachment(s)');
  });

  it('closes an untouched Forward without asking to discard', async function () {
    await openMode(EMAIL, 'f');
    await browser.waitUntil(async () => (await attachments()).includes('deck.pdf'), {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: 'The forwarded original\'s attachment never appeared, so the "not user content" case would prove nothing',
    });

    expect(await clickButtonTitle('Close')).toBe(true);
    // Neither the quoted original nor an attachment carried over from the
    // forwarded message counts as something the user typed.
    expect(await testidPresent('compose-discard-dialog')).toBe(false);
    await browser.waitUntil(async () => (await modalCount()) === 0, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'Close on an untouched Forward did not close it — hasUserContent counted the carried-over quote or attachment as user content',
    });
    expect((await bubbles()).length).toBe(0);
  });

  it('removes an attachment carried over from the forwarded original', async function () {
    await openMode(EMAIL, 'f');
    await browser.waitUntil(async () => (await attachments()).includes('deck.pdf'), {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: 'The forwarded original\'s attachment never appeared',
    });

    expect(await removeAttachment('deck.pdf')).toBe(true);
    await browser.waitUntil(async () => (await attachments()).length === 0, {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'Removing the carried-over attachment left its row in place',
    });
  });

  // -------------------------------------------------------------------------
  // Signature + minimize
  // -------------------------------------------------------------------------

  it('opens a Reply with the account signature already in the body', async function () {
    await settingsCall('setSignature', accountOne.id, {
      html: '<p>Sig One</p>', text: 'Sig One', enabled: true,
    });

    await openMode(EMAIL, 'r');
    const body = (await editorText()) || '';
    expect(body).toContain('Sig One');
    expect(body).toContain('--');
    // The signature goes in the editable body; the original stays quoted.
    expect(body).not.toContain('Original Message');
  });

  it('labels a minimized Reply and brings the quoted original back on restore', async function () {
    await openMode(EMAIL, 'r');
    // Type something so the restore has a user edit to carry too.
    await setField('compose-subject', `Re: ${SUBJECT}`);

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await browser.waitUntil(async () => (await bubbles()).length === 1, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'Minimizing the reply did not produce a draft bubble',
    });

    // The avatar renders a single initial as its own text line — drop it and
    // the two remaining lines are the subject and the recipient.
    const lines = (await bubbles())[0].filter((l) => l.length > 1);
    expect(lines[0]).toBe(`Re: ${SUBJECT}`);
    expect(lines[1]).toBe(SENDER);

    expect(await clickBubble(0)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'Clicking the reply bubble did not restore the compose window',
    });
    expect(await fieldValue('compose-to')).toBe(SENDER);
    expect(await fieldValue('compose-subject')).toBe(`Re: ${SUBJECT}`);
    // The quoted original travels with the draft: losing it on restore would
    // silently strip the conversation out of the reply.
    expect(await testidPresent('compose-quoted-toggle')).toBe(true);
    expect(await clickTestid('compose-quoted-toggle')).toBe(true);
    await browser.waitUntil(() => testidPresent('compose-quoted'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The restored draft had a quoted toggle but no quoted original behind it',
    });
    expect(await testidText('compose-quoted')).toContain('Original html body');
  });
});
