/**
 * E2E: Connected Compose Lifecycle — how a compose window ends. Close, the
 * discard dialog, backdrop click, Escape, minimize/restore, the draft bubble,
 * the send-delay select, and the outbox round trip after a failed send.
 *
 * Harness facts this leans on:
 *   - WebDriver's Escape never reaches the webview, so `pressEscape()` from
 *     composeHelpers dispatches a synthetic keydown on the focused element.
 *   - framer-motion exits never finish under the occluded E2E window, so every
 *     case asserts the positive state it moved to (a bubble appeared, the modal
 *     is open, the store says X) rather than an animated element's absence.
 *   - `expect(value, 'message')` throws in this runner (one argument only) —
 *     explanations are comments above their assertion.
 *   - There is no SMTP server: the mock account's smtpHost/smtpPort point at
 *     its IMAP mock, so a real send always ends in an outbox error. That is the
 *     behaviour under test here, not a limitation to work around.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  openComposeFresh,
  closeComposeHard,
  setField,
  fieldValue,
  typeInBody,
  editorText,
  attachViaInput,
  attachments,
  pdfFile,
  modalOpen,
  modalCount,
  testidPresent,
  testidText,
  clickButtonTitle,
  clickButtonText,
  clickBackdrop,
  pressEscape,
  bubbles,
  clickBubble,
  closeBubble,
  outboxItems,
  settingsCall,
} from './composeHelpers.js';

const DISCARD_DIALOG = '[data-testid="compose-discard-dialog"]';
const ERROR_BUBBLE = '[data-testid="outbox-bubble-error"]';

describe('Connected Compose Lifecycle', function () {
  this.timeout(120_000);

  /** 'c' only opens compose when focus is out of a text field. */
  async function freshCompose() {
    await browser.execute(() => document.activeElement?.blur());
    await openComposeFresh();
  }

  /** Fill a draft with enough user content to make it "dirty". */
  async function fillDraft({ to = 'someone@example.com', subject = 'Lifecycle draft' } = {}) {
    await setField('compose-to', to);
    await setField('compose-subject', subject);
  }

  const waitForDialog = () => browser.waitUntil(() => testidPresent('compose-discard-dialog'), {
    timeout: 10_000,
    interval: 200,
    timeoutMsg: 'The discard confirmation never appeared for a draft with user content',
  });

  const waitForClosed = (why) => browser.waitUntil(async () => (await modalCount()) === 0, {
    timeout: 15_000,
    interval: 200,
    timeoutMsg: why,
  });

  const waitForBubbles = (count, why) => browser.waitUntil(async () => (await bubbles()).length === count, {
    timeout: 15_000,
    interval: 200,
    timeoutMsg: why,
  });

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  afterEach(async function () {
    await closeComposeHard();
    // The delay select reads the global setting on open — put it back so the
    // next case starts from "Send now".
    await settingsCall('setSendDelay', 0);
  });

  // -------------------------------------------------------------------------
  // Close / discard
  // -------------------------------------------------------------------------

  it('closes an empty compose immediately, with no discard confirmation', async function () {
    await freshCompose();

    expect(await clickButtonTitle('Close')).toBe(true);
    // Nothing was typed, so there is nothing to confirm.
    expect(await testidPresent('compose-discard-dialog')).toBe(false);
    await waitForClosed('Close on an empty compose left the modal open');
    // Closed, not minimized.
    expect((await bubbles()).length).toBe(0);
  });

  it('asks before discarding a draft with content, and Cancel keeps it', async function () {
    await freshCompose();
    await fillDraft({ subject: 'Cancel keeps me' });

    expect(await clickButtonTitle('Close')).toBe(true);
    await waitForDialog();
    expect(await testidText('compose-discard-dialog')).toContain('Discard message?');

    expect(await clickButtonText('Cancel', DISCARD_DIALOG)).toBe(true);
    // Cancel returns to the same draft with everything still in it.
    expect(await modalOpen()).toBe(true);
    expect(await fieldValue('compose-subject')).toBe('Cancel keeps me');
    expect(await fieldValue('compose-to')).toBe('someone@example.com');
  });

  it('closes the compose when the discard dialog is confirmed', async function () {
    await freshCompose();
    await fillDraft({ subject: 'Discard me' });

    expect(await clickButtonTitle('Close')).toBe(true);
    await waitForDialog();

    expect(await clickButtonText('Discard', DISCARD_DIALOG)).toBe(true);
    await waitForClosed('Confirming Discard did not close the compose window');
    // Discard throws the draft away — it must not survive as a bubble.
    expect((await bubbles()).length).toBe(0);
  });

  it('opens the same discard dialog from the footer Discard button', async function () {
    await freshCompose();
    await fillDraft({ subject: 'Footer discard' });

    // The footer button is inside the modal; the dialog's own "Discard" is not,
    // so this default-scoped click can only hit the footer one.
    expect(await clickButtonText('Discard')).toBe(true);
    await waitForDialog();
    expect(await testidText('compose-discard-dialog')).toContain('Discard message?');
    expect(await modalOpen()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Backdrop / Escape
  // -------------------------------------------------------------------------

  it('minimizes to a bubble when the backdrop is clicked with content in the draft', async function () {
    await freshCompose();
    await fillDraft({ subject: 'Backdrop minimize' });

    await clickBackdrop();
    await waitForBubbles(1, 'A backdrop click on a draft with content did not minimize it to a bubble');
    // Clicking away is not a discard — it must never raise the confirmation.
    expect(await testidPresent('compose-discard-dialog')).toBe(false);
  });

  it('closes on a backdrop click when the draft is empty', async function () {
    await freshCompose();

    await clickBackdrop();
    await waitForClosed('A backdrop click on an empty compose did not close it');
    expect((await bubbles()).length).toBe(0);
  });

  it('mirrors the backdrop click on Escape: content minimizes to a bubble', async function () {
    await freshCompose();
    await fillDraft({ subject: 'Escape minimize' });

    await pressEscape();
    await waitForBubbles(1, 'Escape on a draft with content did not minimize it to a bubble');
    expect(await testidPresent('compose-discard-dialog')).toBe(false);
  });

  it('closes only the discard dialog on Escape and leaves the compose open', async function () {
    await freshCompose();
    await fillDraft({ subject: 'Escape keeps me' });

    expect(await clickButtonTitle('Close')).toBe(true);
    await waitForDialog();

    await pressEscape();
    // The compose survived the first Escape with its content intact.
    expect(await modalOpen()).toBe(true);
    expect(await fieldValue('compose-subject')).toBe('Escape keeps me');

    // Positive proof the dialog really went away: a second Escape now reaches
    // the modal's own handler and minimizes the draft. A dialog still open
    // would swallow that Escape too, and no bubble would appear.
    await pressEscape();
    await waitForBubbles(1, 'The second Escape did not minimize the compose — the discard dialog was still open, so Escape never reached the modal handler');
  });

  // -------------------------------------------------------------------------
  // Minimize / bubbles
  // -------------------------------------------------------------------------

  it('keeps subject, recipient and attachments across minimize and restore', async function () {
    await freshCompose();
    await fillDraft({ to: 'keep@example.com', subject: 'Minimize keeps state' });
    expect(await attachViaInput([pdfFile()])).toBe(true);
    await browser.waitUntil(async () => (await attachments()).includes('notes.pdf'), {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: 'The attachment never appeared after the hidden file input change — addFiles/FileReader did not land it',
    });
    expect(await testidText('compose-attachments')).toContain('1 Attachment(s)');

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await waitForBubbles(1, 'Minimize did not produce a draft bubble');

    expect(await clickBubble(0)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'Clicking the draft bubble did not restore the compose window',
    });
    // onSaveState carries the whole draft through the unmount, attachments
    // included — a restore that drops any of it is silent data loss.
    expect(await fieldValue('compose-to')).toBe('keep@example.com');
    expect(await fieldValue('compose-subject')).toBe('Minimize keeps state');
    expect(await attachments()).toContain('notes.pdf');
  });

  it('labels the bubble with subject and recipient, and its X discards that draft', async function () {
    await freshCompose();
    await fillDraft({ to: 'reader@example.com', subject: 'Bubble label' });

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await waitForBubbles(1, 'Minimize did not produce a draft bubble');

    // The avatar renders a single initial as its own text line — drop it and
    // the two remaining lines are the subject and the recipient.
    const lines = (await bubbles())[0].filter((l) => l.length > 1);
    expect(lines[0]).toBe('Bubble label');
    expect(lines[1]).toBe('reader@example.com');

    expect(await closeBubble(0)).toBe(true);
    await waitForBubbles(0, 'The bubble X did not remove the minimized draft');
    // Closing a bubble discards that draft — it must not spring back open.
    expect(await modalOpen()).toBe(false);
  });

  it('opens a second, empty compose on "c" while another one is minimized', async function () {
    await freshCompose();
    await setField('compose-subject', 'Stays minimized');

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await waitForBubbles(1, 'Minimize did not produce a draft bubble');

    await browser.execute(() => document.activeElement?.blur());
    await browser.keys('c');
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: '"c" did not open a second compose window while one was minimized',
    });
    // The new window is its own empty draft, and the minimized one keeps its
    // bubble instead of being restored into it.
    expect(await fieldValue('compose-subject')).toBe('');
    expect((await bubbles()).length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Send delay
  // -------------------------------------------------------------------------

  it('offers seven send-delay options and starts on the global value', async function () {
    await freshCompose();

    const delay = await browser.execute(() => {
      const el = document.querySelector('[data-testid="compose-delay"]');
      if (!el) return null;
      return {
        value: el.value,
        values: [...el.options].map((o) => o.value),
        labels: [...el.options].map((o) => o.text.trim()),
      };
    });
    expect(delay).not.toBe(null);
    expect(delay.values).toEqual(['0', '15', '30', '60', '120', '180', '300']);
    expect(delay.labels).toEqual([
      'Send now', '15s delay', '30s delay', '1m delay', '2m delay', '3m delay', '5m delay',
    ]);
    // The global delay is 0 here, so a fresh compose sends immediately.
    expect(delay.value).toBe('0');

    expect(await setField('compose-delay', 15)).toBe(true);
    expect(await fieldValue('compose-delay')).toBe('15');
  });

  it('picks up a changed global send delay on the next compose', async function () {
    await settingsCall('setSendDelay', 30);
    await freshCompose();
    // The per-compose override is untouched, so the select falls through to the
    // global setting. (afterEach puts it back to 0.)
    expect(await fieldValue('compose-delay')).toBe('30');
  });

  // -------------------------------------------------------------------------
  // Send → outbox
  // -------------------------------------------------------------------------

  it('sends with no delay, errors in the outbox, retries, and restores the draft on dismiss', async function () {
    // Two full SMTP attempts against a port that does not speak SMTP; the
    // spec-level 120s budget is not enough for both.
    this.timeout(240_000);

    await freshCompose();
    await fillDraft({ to: 'nobody@example.com', subject: 'Outbox round trip' });
    await typeInBody('OutboxBodyText');
    expect(await attachViaInput([pdfFile()])).toBe(true);
    await browser.waitUntil(async () => (await attachments()).includes('notes.pdf'), {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: 'The attachment never landed before Send',
    });
    // Delay 0 means the send skips the undo window and goes straight to the outbox.
    expect(await fieldValue('compose-delay')).toBe('0');

    expect(await clickButtonTitle('Send (Shift+Enter)')).toBe(true);
    await waitForClosed('Compose stayed open after Send — handleSend never reached queueSend/onClose');
    await browser.waitUntil(async () => (await outboxItems()).length === 1, {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: 'Send with delay 0 produced no outbox item — composeSlice._startOutbox never ran',
    });

    // The mock account's SMTP port is its IMAP mock, so the send must fail and
    // the item must stick as an error instead of disappearing.
    await browser.waitUntil(async () => (await outboxItems())[0]?.status === 'error', {
      timeout: 90_000,
      interval: 1000,
      timeoutMsg: 'The outbox item never reached status "error" — the SMTP failure was swallowed instead of surfacing on the bubble',
    });
    expect(await testidPresent('outbox-bubble-error')).toBe(true);

    // Retry flips the same item straight back to sending. Read the status in
    // the same execute as the click: the failure can land again inside a poll
    // interval, and a sampled read would miss the transition.
    const retried = await browser.execute((sel) => {
      const btn = document.querySelector(`${sel} button[title="Retry send"]`);
      if (!btn) return { clicked: false, statuses: [] };
      btn.click();
      return {
        clicked: true,
        statuses: (window.__MAIL_STORE__.getState().outboxItems || []).map((i) => i.status),
      };
    }, ERROR_BUBBLE);
    expect(retried.clicked).toBe(true);
    expect(retried.statuses).toEqual(['sending']);
    await browser.waitUntil(async () => (await outboxItems())[0]?.status === 'error', {
      timeout: 90_000,
      interval: 1000,
      timeoutMsg: 'The retried send never settled back to "error" — retryOutbox did not re-run the send',
    });

    // Dismiss is the documented way out: it drops the bubble and hands the
    // draft back, attachments included.
    expect(await clickButtonTitle('Dismiss and restore draft', ERROR_BUBBLE)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'Dismissing the errored outbox bubble did not reopen a compose window with the draft',
    });
    expect(await fieldValue('compose-to')).toBe('nobody@example.com');
    expect(await fieldValue('compose-subject')).toBe('Outbox round trip');
    expect((await editorText()) || '').toContain('OutboxBodyText');
    expect(await attachments()).toContain('notes.pdf');
    // The item left the outbox when it was restored into the editor.
    expect((await outboxItems()).length).toBe(0);
  });
});
