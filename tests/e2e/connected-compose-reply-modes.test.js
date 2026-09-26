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
  quotedText,
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

  /** Click any element by data-testid (the context toggle is a plain button). */
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
    // The last-sent identity is global settings state: a case that seeds one
    // has to put it back, or every later compose in this run opens on it.
    // Same for the reading context: its toggle is remembered for the next reply.
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ lastComposeIdentity: null, composeContextVisible: true }));
    for (const a of browser.mockAccounts || []) {
      await settingsCall('setSignature', a.id, SIG_OFF);
    }
  });

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  /** Whether the reply's reading context is open, by its toggle's own state. */
  const contextShown = () => browser.execute(() =>
    document.querySelector('[data-testid="compose-context-toggle"]')?.getAttribute('aria-expanded') ?? null);

  it('prefills a Reply and keeps the original beside it behind a toggle', async function () {
    await openMode(EMAIL, 'r');

    expect(await modalTitle()).toBe('Reply');
    expect(await fieldValue('compose-to')).toBe(SENDER);
    expect(await fieldValue('compose-subject')).toBe(`Re: ${SUBJECT}`);
    // A plain reply goes to the sender only — nobody is carried into Cc.
    expect(await fieldValue('compose-cc')).toBe('');

    // The original is quoted OUTSIDE the editor, in a reading context shown
    // beside it by default, so the user types into an empty body.
    expect(await contextShown()).toBe('true');
    expect((await editorText()) || '').not.toContain('Original Message');
    await browser.waitUntil(async () => ((await quotedText()) || '').includes('Original html body'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The reading context never showed the original body',
    });
    const quoted = await quotedText();
    expect(quoted).toContain('Original Message');
    expect(quoted).toContain('Ann Sender');
    expect(quoted).toContain(SUBJECT);
    // The original body itself, not just its headers.
    expect(quoted).toContain('Original html body');

    expect(await clickTestid('compose-context-toggle')).toBe(true);
    await browser.waitUntil(async () => !(await testidPresent('compose-quoted')), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The reading context did not hide when its toggle was clicked',
    });
    expect(await contextShown()).toBe('false');

    expect(await clickTestid('compose-context-toggle')).toBe(true);
    await browser.waitUntil(() => testidPresent('compose-quoted'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The reading context did not come back on a second toggle click',
    });
    expect(await contextShown()).toBe('true');
  });

  it('keeps a single "Re:" when replying to a subject that already has one', async function () {
    await openMode({ ...EMAIL, subject: `Re: ${SUBJECT}` }, 'r');
    expect(await fieldValue('compose-subject')).toBe(`Re: ${SUBJECT}`);
  });

  // -------------------------------------------------------------------------
  // Which mailbox the reply leaves from
  // -------------------------------------------------------------------------
  // Reported 2026-08-26: replied inside a thread and the From row read another
  // mailbox — the one that had SENT last. Both cases below seed that identity
  // on the OTHER account, which is what used to win.

  it('a reply with no provenance leaves from the account being read', async function () {
    // No `_accountId` on purpose: that is what a body fetched from the server
    // looks like, and the row click that asked for it forwards a bare uid.
    const other = browser.mockAccounts[1];
    const { _accountId, ...noProvenance } = EMAIL;
    await browser.execute((id, addr) => {
      window.__SETTINGS_STORE__.setState({ lastComposeIdentity: { accountId: id, address: addr } });
    }, other.id, other.email);

    await openMode(noProvenance, 'r');

    expect(await fieldValue('compose-from')).toBe(`${accountOne.id} ${accountOne.email}`);
  });

  it('a forward leaves from the mailbox the message is in, not the one that sent last', async function () {
    const other = browser.mockAccounts[1];
    await browser.execute((id, addr) => {
      window.__SETTINGS_STORE__.setState({ lastComposeIdentity: { accountId: id, address: addr } });
    }, accountOne.id, accountOne.email);

    await openMode({ ...EMAIL, _accountId: other.id }, 'f');

    expect(await fieldValue('compose-from')).toBe(`${other.id} ${other.email}`);
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

    // Unlike a reply, the original is part of the editable body.
    const body = (await editorText()) || '';
    expect(body).toContain('Original Message');
    expect(body).toContain('Original html body');

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
    await browser.waitUntil(() => testidPresent('compose-quoted'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The restored draft came back without its reading context',
    });
    await browser.waitUntil(async () => ((await quotedText()) || '').includes('Original html body'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The restored draft\'s quoted original never showed its body',
    });
  });

  // -------------------------------------------------------------------------
  // Someone else's markup
  // -------------------------------------------------------------------------
  // The compose window is the app's own webview: withGlobalTauri puts the IPC
  // bridge on its window and the CSP allows inline handlers. The payload only
  // records whether it ran and whether the bridge was in reach. A data: image
  // that fails to decode fires onerror without a network request.

  const RAN = 'window.__mvQuoteRan = typeof top.__TAURI__';
  const BROKEN_IMG = `<img src="data:image/png;base64,AAAA" onerror="${RAN}">`;

  /** What ran from the quote, in the app window and inside the quote's own frame. */
  const quoteRan = () => browser.execute(() => {
    const frame = document.querySelector('[data-testid="compose-quoted"] iframe');
    return { app: window.__mvQuoteRan ?? null, frame: frame?.contentWindow?.__mvQuoteRan ?? null };
  });

  async function expandQuote() {
    // A reply opens with its reading context shown.
    await browser.waitUntil(() => testidPresent('compose-quoted'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The reply opened without its quoted original beside it',
    });
    // Long enough for a broken image to fail and a handler to fire.
    await browser.pause(1500);
  }

  it('runs nothing from an HTML original a Reply shows', async function () {
    await browser.execute(() => { delete window.__mvQuoteRan; });
    await openMode({
      ...EMAIL,
      from: { name: `${BROKEN_IMG}Ann Sender`, address: SENDER },
      html: `<p>Original html body</p>${BROKEN_IMG}`,
    }, 'r');

    await expandQuote();
    expect(await quoteRan()).toEqual({ app: null, frame: null });

    // It did render: the body, and the sender's name as the characters it holds.
    await browser.waitUntil(async () => ((await quotedText()) || '').includes('Original html body'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The quoted original never showed its body, so "nothing ran" proves nothing',
    });
    expect(await quotedText()).toContain(`From: ${BROKEN_IMG}Ann Sender <${SENDER}>`);
  });

  it('quotes a plain-text original as the characters it holds', async function () {
    await browser.execute(() => { delete window.__mvQuoteRan; });
    const line = `On Monday, Ann Sender <${SENDER}> wrote:`;
    await openMode({ ...EMAIL, html: '', text: `${line}\n${BROKEN_IMG}` }, 'r');

    await expandQuote();
    expect(await quoteRan()).toEqual({ app: null, frame: null });

    await browser.waitUntil(async () => ((await quotedText()) || '').includes(line), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The plain-text original never showed its "wrote:" line with the address in it',
    });
    expect(await quotedText()).toContain(BROKEN_IMG);
  });

  // A guard, green before the fix too: a Forward puts the original into the
  // editor, where only TipTap's schema stands between its markup and the app
  // window (Image keeps src/alt/title, Link refuses javascript:).
  it('runs nothing from an HTML original a Forward carries into the editor', async function () {
    await browser.execute(() => { delete window.__mvQuoteRan; });
    await openMode({
      ...EMAIL,
      from: { name: `${BROKEN_IMG}Ann Sender`, address: SENDER },
      html: `<p>Original html body</p>${BROKEN_IMG}<p><a href="javascript:${RAN}">details</a></p>`,
    }, 'f');

    await browser.waitUntil(async () => ((await editorText()) || '').includes('Original html body'), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: 'The forwarded original never reached the editor, so "nothing ran" proves nothing',
    });
    await browser.pause(1500);
    expect(await browser.execute(() => window.__mvQuoteRan ?? null)).toBe(null);
    expect(await browser.execute(() =>
      document.querySelectorAll('.ProseMirror [onerror], .ProseMirror a[href^="javascript:"]').length)).toBe(0);
  });
});
