/**
 * E2E: a message the user started writing is saved to the account's Drafts
 * folder while they type — locally, in the vault, 0.3s after typing stops.
 *
 * Why it exists: a compose window is the only place in the app where content
 * lives in RAM alone. Anything that unmounts it (a stray dismissal, a reload,
 * a crash) used to take the draft with it. The autosave makes the vault, not
 * the window, the thing that holds the message.
 *
 * "Locally" is the whole contract for now — nothing here APPENDs to the
 * server's Drafts mailbox, so the assertions read the vault on disk and the
 * Drafts list the app renders from it.
 *
 * Harness facts these lean on (see composeHelpers.js):
 *   - `browser.testDataDir` is the app's real HOME, so the Maildir under it is
 *     the same one the app writes.
 *   - The mock account's Drafts mailbox is empty and carries `\Drafts`, so
 *     every row that shows up there is one this spec put there.
 */

import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';
import {
  openComposeFresh,
  closeComposeHard,
  setField,
  typeInBody,
  attachViaInput,
  attachments,
  pdfFile,
  clickButtonTitle,
  clickButtonText,
  clickBubble,
  closeBubble,
  clickSend,
  waitForOutboxError,
  mailStoreSet,
  modalOpen,
  bubbles,
  listDrafts,
  readDrafts,
  localIndex,
  waitForLocalDraft,
  flatten,
} from './composeHelpers.js';

const DISCARD_DIALOG = '[data-testid="compose-discard-dialog"]';

describe('Connected Compose Autosave — drafts land in the vault', function () {
  this.timeout(120_000);

  let account;

  const draftSubjects = () => localIndex(account.id, 'Drafts').map((e) => e.subject);

  async function freshCompose() {
    await browser.execute(() => document.activeElement?.blur());
    await openComposeFresh();
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    account = (browser.mockAccounts || [])[0];
    if (!account) throw new Error('No mock account seeded — browser.mockAccounts is empty');
    // Compose defaults to the active account: pin it so the vault path this
    // spec reads is the one the draft is written to.
    await switchToFolder(account.email, 'INBOX');
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  it('writes nothing while the compose is still empty', async function () {
    const before = listDrafts(account.id).length;
    await freshCompose();
    await browser.pause(1500);

    // An untouched window is not a draft. Only content the user entered is.
    expect(listDrafts(account.id).length).toBe(before);
  });

  it('saves what the user typed into the account Drafts vault', async function () {
    await freshCompose();
    await setField('compose-to', 'recipient@example.com');
    await setField('compose-subject', 'Autosaved while typing');
    await typeInBody('Half a sentence that must survive');

    const raw = await waitForLocalDraft(account.id, 'Autosaved while typing');
    const text = flatten(raw);
    // The whole message is on disk, not just its subject.
    expect(text).toContain('recipient@example.com');
    expect(text).toContain('Half a sentence that must survive');
    expect(text.toLowerCase()).toContain(account.email.toLowerCase());

    // And it is indexed as a locally-created draft, which is what keeps a
    // delete from being replayed against a server that never had it.
    const entry = localIndex(account.id, 'Drafts').find((e) => e.subject === 'Autosaved while typing');
    expect(!!entry).toBe(true);
    expect(entry.source).toBe('local_draft');
    expect(entry.flags).toContain('draft');
  });

  it('saves a draft that has no recipient yet', async function () {
    await freshCompose();
    await setField('compose-subject', 'No recipient yet');
    await typeInBody('Written before the address was');

    // The common case: the body comes first. The send-side MIME builder
    // refuses a message with no recipient, so a draft that waits for an
    // address would never be saved at all.
    const raw = flatten(await waitForLocalDraft(account.id, 'No recipient yet'));
    expect(raw).toContain('Written before the address was');
    // And no placeholder recipient was invented to get it written.
    const headers = raw.split(/\r?\n\r?\n/)[0].toLowerCase();
    expect(headers.includes('\nto:')).toBe(false);
    expect(headers.startsWith('to:')).toBe(false);
  });

  it('keeps updating the same draft instead of stacking up copies', async function () {
    await freshCompose();
    await setField('compose-to', 'recipient@example.com');
    await setField('compose-subject', 'First autosave pass');
    await waitForLocalDraft(account.id, 'First autosave pass');
    const afterFirst = listDrafts(account.id).length;

    await setField('compose-subject', 'Second autosave pass');
    await waitForLocalDraft(account.id, 'Second autosave pass');

    // One compose window is one draft: the rewrite replaces the .eml and its
    // index entry rather than leaving a copy per keystroke pause.
    expect(listDrafts(account.id).length).toBe(afterFirst);
    expect(draftSubjects()).toContain('Second autosave pass');
    expect(draftSubjects()).not.toContain('First autosave pass');
    expect(readDrafts(account.id).some((t) => flatten(t).includes('First autosave pass'))).toBe(false);
  });

  it('moves the draft to the other account when From changes', async function () {
    const other = (browser.mockAccounts || [])[1];
    if (!other) throw new Error('This case needs a second seeded account');

    await freshCompose();
    await setField('compose-subject', 'Draft follows the account');
    await waitForLocalDraft(account.id, 'Draft follows the account');

    expect(await setField('compose-from', `${other.id} ${other.email}`)).toBe(true);
    await setField('compose-subject', 'Draft follows the account, now elsewhere');

    // The draft belongs to whichever account the message is being sent from —
    // it is written to that account's Drafts and left nowhere else.
    await waitForLocalDraft(other.id, 'Draft follows the account, now elsewhere');
    await browser.waitUntil(
      async () => !readDrafts(account.id).some((t) => flatten(t).includes('Draft follows the account')),
      {
        timeout: 15_000,
        interval: 300,
        timeoutMsg: 'Changing the From account left a copy of the draft in the old account\'s Drafts',
      },
    );
  });

  it('shows the autosaved draft in the Drafts folder', async function () {
    await freshCompose();
    await setField('compose-to', 'reader@example.com');
    await setField('compose-subject', 'Draft visible in the folder');
    await waitForLocalDraft(account.id, 'Draft visible in the folder');

    // Minimize rather than close: closing is a discard, and a discarded draft
    // is supposed to leave the folder.
    expect(await clickButtonTitle('Minimize')).toBe(true);
    await browser.waitUntil(async () => (await bubbles()).length === 1, {
      timeout: 15_000, interval: 200, timeoutMsg: 'Minimize did not produce a draft bubble',
    });

    await switchToFolder(account.email, 'Drafts', { requireRows: false });
    await browser.waitUntil(
      async () => (await visibleRowSubjects()).some((r) => r.includes('Draft visible in the folder')),
      {
        timeout: 20_000,
        interval: 500,
        timeoutMsg: 'The autosaved draft never appeared as a row in the Drafts folder',
      },
    );
  });

  it('still has the draft after the app window is thrown away', async function () {
    await freshCompose();
    await setField('compose-to', 'survivor@example.com');
    await setField('compose-subject', 'Draft outlives the window');
    await typeInBody('Text that only the vault will have');
    await waitForLocalDraft(account.id, 'Draft outlives the window');

    // Nothing is closed, minimized or saved by hand: the window is destroyed
    // with the message still open in it. That is what a crash, a quit, or a
    // reload looks like from the draft's point of view, and it is the case the
    // whole feature exists for — every in-memory copy goes at once.
    await browser.execute(() => window.location.reload());
    await waitForApp();
    await waitForEmails();

    await switchToFolder(account.email, 'Drafts', { requireRows: false });
    await browser.waitUntil(
      async () => (await visibleRowSubjects()).some((r) => r.includes('Draft outlives the window')),
      {
        timeout: 20_000,
        interval: 500,
        timeoutMsg: 'The draft did not come back after the window was reloaded — it lived only in the compose window after all',
      },
    );
    // And it is the message, not just a row: the body is on disk too.
    expect(readDrafts(account.id).some((t) => flatten(t).includes('Text that only the vault will have'))).toBe(true);
  });

  it('keeps one draft across minimize and restore', async function () {
    await freshCompose();
    await setField('compose-to', 'roundtrip@example.com');
    await setField('compose-subject', 'Draft before the bubble');
    await waitForLocalDraft(account.id, 'Draft before the bubble');
    const before = listDrafts(account.id).length;

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await browser.waitUntil(async () => (await bubbles()).length === 1, {
      timeout: 15_000, interval: 200, timeoutMsg: 'Minimize did not produce a draft bubble',
    });
    expect(await clickBubble(0)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000, interval: 200, timeoutMsg: 'The bubble did not restore the compose window',
    });

    await setField('compose-subject', 'Draft after the bubble');
    await waitForLocalDraft(account.id, 'Draft after the bubble');

    // The restored window is still editing the SAME vault draft: the uid it was
    // given travels through the unmount. Allocating a new one here would leave
    // the pre-minimize version behind as a second, stale row.
    expect(listDrafts(account.id).length).toBe(before);
    expect(draftSubjects()).toContain('Draft after the bubble');
    expect(draftSubjects()).not.toContain('Draft before the bubble');
  });

  it('takes the draft out of the vault when its bubble is dismissed', async function () {
    await freshCompose();
    await setField('compose-to', 'gone@example.com');
    await setField('compose-subject', 'Bubble X discards this');
    await waitForLocalDraft(account.id, 'Bubble X discards this');

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await browser.waitUntil(async () => (await bubbles()).length === 1, {
      timeout: 15_000, interval: 200, timeoutMsg: 'Minimize did not produce a draft bubble',
    });

    // The X on a bubble is a discard, same as the one in the window — and it is
    // the only discard that happens with the compose window already unmounted.
    expect(await closeBubble(0)).toBe(true);
    await browser.waitUntil(
      async () => !draftSubjects().includes('Bubble X discards this'),
      {
        timeout: 15_000,
        interval: 300,
        timeoutMsg: 'Dismissing the bubble left its draft behind in the vault',
      },
    );
    expect(readDrafts(account.id).some((t) => flatten(t).includes('Bubble X discards this'))).toBe(false);
  });

  it('saves an attached file into the draft, not just its name', async function () {
    await freshCompose();
    await setField('compose-to', 'attach@example.com');
    await setField('compose-subject', 'Draft with an attachment');
    expect(await attachViaInput([pdfFile()])).toBe(true);
    await browser.waitUntil(async () => (await attachments()).includes('notes.pdf'), {
      timeout: 15_000, interval: 300, timeoutMsg: 'The attachment never landed in the compose window',
    });

    // Waited on the FILE, not the subject: the subject is saved a pause earlier,
    // so a wait on it can return the pre-attachment version of the same draft.
    const raw = flatten(await waitForLocalDraft(account.id, 'notes.pdf'));
    // The file is IN the saved message — a draft that lists an attachment it
    // cannot produce is the same lie as a row with no body behind it.
    expect(raw).toContain('Draft with an attachment');
    // The bytes themselves, not a base64 prefix: this stub is pure ASCII, so
    // lettre files it as 7bit rather than base64.
    expect(raw).toContain('%PDF-1.4');
    const entry = localIndex(account.id, 'Drafts').find((e) => e.subject === 'Draft with an attachment');
    expect(entry?.has_attachments).toBe(true);
  });

  it('saves a reply draft with the quoted original and its threading headers', async function () {
    const original = {
      uid: 515151,
      subject: 'Autosave reply source',
      from: { name: 'Ann Sender', address: 'ann@example.com' },
      to: [{ address: account.email }],
      cc: [],
      replyTo: [],
      date: '2026-08-01T10:00:00.000Z',
      messageId: '<autosave-orig-515151@example.com>',
      text: 'Original body being replied to',
      html: '<p>Original body being replied to</p>',
      flags: ['\\Seen'],
      _accountId: account.id,
    };
    await closeComposeHard();
    const selection = { selectedEmail: original, selectedEmailId: original.uid, selectedThread: null };
    await mailStoreSet(selection);
    await browser.execute(() => document.activeElement?.blur());
    await mailStoreSet(selection);
    await browser.keys('r');
    await browser.waitUntil(modalOpen, {
      timeout: 15_000, interval: 200, timeoutMsg: 'Reply did not open on "r"',
    });
    await typeInBody('My half of the reply');

    const raw = flatten(await waitForLocalDraft(account.id, 'Re: Autosave reply source'));
    expect(raw).toContain('My half of the reply');
    // A reply draft that loses the quote or the headers comes back as a new
    // conversation — the same way a reply used to fragment a thread.
    expect(raw).toContain('Original body being replied to');
    expect(raw).toContain('<autosave-orig-515151@example.com>');
    expect(raw.toLowerCase()).toContain('in-reply-to:');

    await mailStoreSet({ selectedEmail: null, selectedEmailId: null, selectedThread: null });
  });

  it('keeps the draft when the send fails', async function () {
    // A real SMTP attempt against a port that does not speak SMTP; one failure
    // is slower than the spec-level budget.
    this.timeout(240_000);

    await freshCompose();
    await setField('compose-to', 'nobody@example.com');
    await setField('compose-subject', 'Draft outlives a failed send');
    await setField('compose-delay', 0);
    await waitForLocalDraft(account.id, 'Draft outlives a failed send');

    expect(await clickSend()).toBe(true);
    await waitForOutboxError('Draft outlives a failed send');

    // The message never left, so it is still a draft. Deleting it here would
    // put the only copy in an outbox bubble the user can dismiss.
    expect(draftSubjects()).toContain('Draft outlives a failed send');
    expect(readDrafts(account.id).some((t) => flatten(t).includes('Draft outlives a failed send'))).toBe(true);
  });

  it('keeps two open messages as two separate drafts', async function () {
    await freshCompose();
    await setField('compose-subject', 'First window draft');
    await waitForLocalDraft(account.id, 'First window draft');

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await browser.waitUntil(async () => (await bubbles()).length === 1, {
      timeout: 15_000, interval: 200, timeoutMsg: 'Minimize did not produce a draft bubble',
    });
    await browser.execute(() => document.activeElement?.blur());
    await browser.keys('c');
    await browser.waitUntil(modalOpen, {
      timeout: 15_000, interval: 200, timeoutMsg: '"c" did not open a second compose window',
    });

    await setField('compose-subject', 'Second window draft');
    await waitForLocalDraft(account.id, 'Second window draft');

    // Two messages being written are two drafts.
    //
    // SCOPE — this is a CONTRACT test, not a discriminating one. The bug it
    // describes (a uid read straight off the clock hands both windows the same
    // one, and the second save overwrites the first draft's .eml and its index
    // entry) only bites when both first saves land inside the same second, and
    // the steps above reliably straddle a second boundary: verified on the mini
    // by reverting `newDraftUid` to the bare timestamp and rebuilding — this
    // spec stayed 15/15 green. What pins the fix is the unit test
    // `never hands the same uid to two windows` in
    // src/services/__tests__/localDrafts.test.js, which was red before it.
    // What this case is worth: it fails if two open windows ever stop being two
    // rows for any other reason.
    const subs = draftSubjects();
    expect(subs).toContain('First window draft');
    expect(subs).toContain('Second window draft');
    const uids = localIndex(account.id, 'Drafts')
      .filter((e) => (e.subject || '').endsWith('window draft'))
      .map((e) => e.uid);
    expect(new Set(uids).size).toBe(2);
  });

  it('writes the draft into the composing account and nowhere else', async function () {
    const other = (browser.mockAccounts || [])[1];
    if (!other) throw new Error('This case needs a second seeded account');

    await freshCompose();
    await setField('compose-to', 'someone@example.com');
    await setField('compose-subject', 'Only in the composing account');
    await waitForLocalDraft(account.id, 'Only in the composing account');

    // "On the same mailbox" is the whole contract: a draft belongs to the
    // account the message will leave from, and to no other account's vault.
    expect(readDrafts(other.id).some((t) => flatten(t).includes('Only in the composing account'))).toBe(false);
    expect(localIndex(other.id, 'Drafts').map((e) => e.subject))
      .not.toContain('Only in the composing account');
  });

  it('removes the draft from the vault when the message is discarded', async function () {
    await freshCompose();
    await setField('compose-to', 'nobody@example.com');
    await setField('compose-subject', 'Discarded draft goes away');
    await waitForLocalDraft(account.id, 'Discarded draft goes away');

    expect(await clickButtonTitle('Close')).toBe(true);
    await browser.waitUntil(
      () => browser.execute((sel) => !!document.querySelector(sel), DISCARD_DIALOG),
      { timeout: 10_000, interval: 200, timeoutMsg: 'The discard confirmation never appeared' },
    );
    expect(await clickButtonText('Discard', DISCARD_DIALOG)).toBe(true);

    // Discard means gone: the vault copy is the draft, so it has to go too.
    await browser.waitUntil(
      async () => !draftSubjects().includes('Discarded draft goes away'),
      {
        timeout: 15_000,
        interval: 300,
        timeoutMsg: 'Discarding the message left its autosaved draft behind in the vault',
      },
    );
    expect(readDrafts(account.id).some((t) => flatten(t).includes('Discarded draft goes away'))).toBe(false);
    expect(await modalOpen()).toBe(false);
  });
});
