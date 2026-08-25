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
  clickButtonTitle,
  clickButtonText,
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
