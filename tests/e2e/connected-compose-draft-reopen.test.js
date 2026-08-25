/**
 * E2E: a draft in the Drafts folder reopens in compose, not in the reader.
 *
 * Why it exists: autosave (connected-compose-autosave.test.js) made the vault,
 * not the window, the thing that holds an unfinished message — but a message
 * you can only READ back is not a draft. Before this, a draft that outlived its
 * session opened in the EmailViewer: the text was there, and there was no way
 * to carry on writing it.
 *
 * The other half of the contract is that continuing a draft continues THAT
 * draft. A reopen that allocated a fresh uid would leave the old row sitting in
 * Drafts next to the new one, and the folder would fill up with one copy per
 * time the user came back to the same message.
 *
 * Harness facts these lean on (see composeHelpers.js):
 *   - `browser.testDataDir` is the app's real HOME, so the Maildir under it is
 *     the same one the app writes.
 *   - There is no way inside the app to leave a draft in the vault with no
 *     window owning it — closing is a discard. `snapshotDraft` + `restoreDraft`
 *     put the app's OWN bytes and index entry back after the window is gone,
 *     which is the state a restart leaves behind.
 */

import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';
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
  clickButtonTitle,
  modalOpen,
  modalCount,
  bubbles,
  listDrafts,
  readDrafts,
  localIndex,
  waitForLocalDraft,
  snapshotDraft,
  restoreDraft,
  flatten,
} from './composeHelpers.js';

const clickRow = (subject) => browser.execute((needle) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find((r) => (r.innerText || '').includes(needle));
  if (!row || row.offsetHeight === 0) return false;
  row.click();
  return true;
}, subject);

const selection = () => browser.execute(() => {
  const s = window.__MAIL_STORE__.getState();
  return { selectedEmailId: s.selectedEmailId ?? null, hasEmail: !!s.selectedEmail };
});

describe('Connected Compose Draft Reopen — a draft row goes back into compose', function () {
  this.timeout(180_000);

  let account;
  let other;

  const draftSubjects = (accountId) => localIndex(accountId, 'Drafts').map((e) => e.subject);

  /** Type a draft, let it autosave, then leave it in the vault with no window. */
  async function orphanedDraft(subject, { to, body, accountId, fromKey, files } = {}) {
    await closeComposeHard();
    await browser.execute(() => document.activeElement?.blur());
    await openComposeFresh();
    if (fromKey) {
      if (!(await setField('compose-from', fromKey))) throw new Error(`No From option "${fromKey}"`);
    }
    const id = accountId || account.id;
    if (to) await setField('compose-to', to);
    await setField('compose-subject', subject);
    if (body) await typeInBody(body);
    if (files) expect(await attachViaInput(files)).toBe(true);
    await waitForLocalDraft(id, subject);

    const snapshot = snapshotDraft(id, subject);
    // Closing is a discard, which is what takes the vault copy with it — the
    // point here is to be rid of the WINDOW.
    await closeComposeHard();
    await browser.waitUntil(
      async () => !readDrafts(id).some((t) => flatten(t).includes(subject)),
      { timeout: 15_000, interval: 300, timeoutMsg: `Discarding "${subject}" left its draft in the vault` },
    );

    await restoreDraft(id, snapshot);
    return snapshot;
  }

  /** Open `subject` from the account's Drafts folder and wait for the window. */
  async function openDraftRow(email, subject) {
    const owner = (browser.mockAccounts || []).find((a) => a.email === email);
    await switchToFolder(email, 'Drafts', { requireRows: false });
    await browser.waitUntil(
      async () => (await visibleRowSubjects()).some((r) => r.includes(subject)),
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: `The re-seeded draft "${subject}" never rendered as a row in Drafts — ` +
          `index holds ${JSON.stringify(draftSubjects(owner.id))}`,
      },
    );
    expect(await clickRow(subject)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 20_000,
      interval: 300,
      timeoutMsg: `Clicking the draft row for "${subject}" did not open compose — ` +
        `it went to the viewer instead, which is the bug this spec exists for`,
    });
    // A compose window mounts empty and is filled in by its init effect, so
    // "a window is open" is not yet "this draft is in it". Anything that reads
    // or writes a field before that has to wait for the fill — a spec that
    // typed into the window first watched the effect overwrite what it typed.
    await browser.waitUntil(async () => (await fieldValue('compose-subject')) === subject, {
      timeout: 20_000,
      interval: 200,
      timeoutMsg: `Compose opened but never loaded draft "${subject}" — the subject ` +
        `field holds ${JSON.stringify(await fieldValue('compose-subject'))}`,
    });
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    account = (browser.mockAccounts || [])[0];
    other = (browser.mockAccounts || [])[1];
    if (!account) throw new Error('No mock account seeded — browser.mockAccounts is empty');
    if (!other) throw new Error('This spec needs a second seeded account');
    await switchToFolder(account.email, 'INBOX');
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  it('puts the whole message back in the editor', async function () {
    const SUBJECT = 'Reopen me where I left off';
    await orphanedDraft(SUBJECT, {
      to: 'recipient@example.com',
      body: 'The sentence I never finished',
    });
    await openDraftRow(account.email, SUBJECT);

    // Every field, not just the subject the row happens to show: a reopen that
    // loses the recipients or the body is a draft the user has to retype.
    expect(await fieldValue('compose-subject')).toBe(SUBJECT);
    expect(await fieldValue('compose-to')).toContain('recipient@example.com');
    expect(await editorText()).toContain('The sentence I never finished');
  });

  it('does not hand the draft to the reader on the way', async function () {
    const SUBJECT = 'Not a message to read';
    await orphanedDraft(SUBJECT, { to: 'nobody@example.com', body: 'Still writing this' });
    await switchToFolder(account.email, 'INBOX');
    await browser.execute(() => {
      window.__MAIL_STORE__.setState({ selectedEmail: null, selectedEmailId: null, selectedThread: null });
    });

    await openDraftRow(account.email, SUBJECT);

    // The viewer is not "also" opened behind the compose window: selecting a
    // draft is not selecting a message, and leaving it selected would mark it
    // read, prefetch its neighbours, and offer Reply on a message never sent.
    expect(await selection()).toEqual({ selectedEmailId: null, hasEmail: false });
  });

  it('keeps editing the SAME vault draft instead of starting a second one', async function () {
    const SUBJECT = 'One draft, continued';
    await orphanedDraft(SUBJECT, { to: 'recipient@example.com', body: 'First half' });
    const before = listDrafts(account.id).length;
    await openDraftRow(account.email, SUBJECT);

    const FINISHED = 'Finished it on the second sitting';
    await setField('compose-subject', FINISHED);
    await waitForLocalDraft(account.id, FINISHED);

    // The reopened window adopted the draft's uid and mailbox, so its autosave
    // REPLACED the draft. A fresh uid would leave both rows in the folder and
    // the user with two copies of one message.
    expect(listDrafts(account.id).length).toBe(before);
    expect(draftSubjects(account.id)).toContain(FINISHED);
    expect(draftSubjects(account.id)).not.toContain(SUBJECT);
    // Deliberately not a superstring of the old subject: this reads raw .eml
    // text, and a continued subject that contains the old one matches itself.
    expect(readDrafts(account.id).some((t) => flatten(t).includes(SUBJECT))).toBe(false);
  });

  it('carries the threading headers a reply draft was written with', async function () {
    const SUBJECT = 'Re: keeping the thread';
    await orphanedDraft(SUBJECT, { to: 'recipient@example.com', body: 'Answering below' });
    const entry = localIndex(account.id, 'Drafts').find((e) => e.subject === SUBJECT);
    // A fresh compose has no parent, so seed the headers a reply draft would
    // have had — the index is the only place they survive the vault parse.
    await restoreDraft(account.id, {
      rawBase64: snapshotDraft(account.id, SUBJECT).rawBase64,
      entry: {
        ...entry,
        in_reply_to: '<parent@mock.test>',
        references: '<root@mock.test> <parent@mock.test>',
      },
    });

    await openDraftRow(account.email, SUBJECT);
    await setField('compose-subject', 'Re: keeping the thread, continued');
    await waitForLocalDraft(account.id, 'Re: keeping the thread, continued');

    // Lose these and continuing a reply starts a new thread on the other end.
    const saved = localIndex(account.id, 'Drafts')
      .find((e) => e.subject === 'Re: keeping the thread, continued');
    expect(saved.in_reply_to).toBe('<parent@mock.test>');
    expect(saved.references).toBe('<root@mock.test> <parent@mock.test>');
  });

  it('brings the attached file back with the draft', async function () {
    const SUBJECT = 'Draft with something attached';
    await orphanedDraft(SUBJECT, {
      to: 'recipient@example.com',
      body: 'The file is the point',
      files: [pdfFile('notes.pdf')],
    });
    await openDraftRow(account.email, SUBJECT);

    // Metadata alone is not enough — the bytes have to come back too, or the
    // draft silently sends without its file. The proof that they did is the
    // autosave below: it re-encodes the whole message from what the window
    // holds, so the attachment survives into the .eml only if it was restored.
    expect(await attachments()).toEqual(['notes.pdf']);

    await setField('compose-subject', 'Attachment still here');
    await waitForLocalDraft(account.id, 'Attachment still here');
    const saved = localIndex(account.id, 'Drafts').find((e) => e.subject === 'Attachment still here');
    expect(saved.has_attachments).toBe(true);
    expect(flatten(readDrafts(account.id).find((t) => t.includes('Attachment still here'))))
      .toContain('notes.pdf');
  });

  it('reopens another account\'s draft as that account', async function () {
    const SUBJECT = 'Written from the other account';
    await orphanedDraft(SUBJECT, {
      to: 'recipient@example.com',
      body: 'This one belongs elsewhere',
      accountId: other.id,
      fromKey: `${other.id} ${other.email}`,
    });

    await openDraftRow(other.email, SUBJECT);

    // The draft carries its own account, not whichever one happens to be on
    // screen: reopening it under the wrong identity would send it from the
    // wrong address and move the vault copy to the wrong Drafts folder.
    expect(await fieldValue('compose-from')).toBe(`${other.id} ${other.email}`);

    await setField('compose-subject', 'Written from the other account, still');
    await waitForLocalDraft(other.id, 'Written from the other account, still');
    expect(draftSubjects(other.id)).not.toContain(SUBJECT);
    expect(draftSubjects(account.id)).not.toContain('Written from the other account, still');
  });

  it('brings a minimized draft forward rather than opening a second window on it', async function () {
    const SUBJECT = 'Already open in a bubble';
    await closeComposeHard();
    await switchToFolder(account.email, 'INBOX');
    const before = listDrafts(account.id).length;
    await openComposeFresh();
    await setField('compose-to', 'recipient@example.com');
    await setField('compose-subject', SUBJECT);
    await typeInBody('Minimized, not gone');
    await waitForLocalDraft(account.id, SUBJECT);

    expect(await clickButtonTitle('Minimize')).toBe(true);
    await browser.waitUntil(async () => (await bubbles()).length === 1, {
      timeout: 15_000, interval: 200, timeoutMsg: 'Minimize did not produce a draft bubble',
    });

    await switchToFolder(account.email, 'Drafts', { requireRows: false });
    await browser.waitUntil(
      async () => (await visibleRowSubjects()).some((r) => r.includes(SUBJECT)),
      { timeout: 30_000, interval: 500, timeoutMsg: 'The minimized draft never showed as a row' },
    );
    expect(await clickRow(SUBJECT)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 20_000, interval: 300, timeoutMsg: 'Clicking the row did not bring the draft back',
    });
    await browser.waitUntil(async () => (await editorText() || '').includes('Minimized, not gone'), {
      timeout: 20_000, interval: 200,
      timeoutMsg: 'The restored window never showed the draft it was minimized with',
    });

    // Two windows autosaving one vault uid interleave their writes and one
    // side's text is lost, so the row has to reach the window that already
    // owns the draft.
    expect(await modalCount()).toBe(1);
    expect(await editorText()).toContain('Minimized, not gone');
    expect(listDrafts(account.id).length).toBe(before + 1);
  });

  it('still opens an ordinary message in the reader', async function () {
    await closeComposeHard();
    await switchToFolder(account.email, 'INBOX');
    if (!(await visibleRowSubjects()).length) throw new Error('INBOX rendered no rows to click');

    const clicked = await browser.execute(() => {
      const row = document.querySelector('[data-testid="email-row"]');
      if (!row || row.offsetHeight === 0) return false;
      row.click();
      return true;
    });
    expect(clicked).toBe(true);

    // The draft check is gated on a flag no server message carries, so nothing
    // about reading mail changed. This is the guard that says so.
    await browser.waitUntil(async () => (await selection()).selectedEmailId !== null, {
      timeout: 20_000,
      interval: 300,
      timeoutMsg: 'Clicking an ordinary INBOX row selected nothing — the draft interception took a message that is not a draft',
    });
    expect(await modalOpen()).toBe(false);
  });
});
