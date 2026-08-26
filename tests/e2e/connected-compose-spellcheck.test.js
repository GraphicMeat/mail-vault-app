/**
 * E2E: the compose toolbar's spellcheck toggle.
 *
 * The button is the visible half; the half that matters is the attribute the
 * engine actually reads. Every case below asserts `el.spellcheck` — the IDL
 * getter, which walks up the tree — rather than the attribute we wrote. The
 * toggle puts `spellcheck` on the editor's wrapper and relies on the
 * contenteditable inheriting it, so reading the attribute back off the wrapper
 * would prove only that React rendered a prop, not that the editable is
 * actually checked or not checked.
 *
 * Two accounts, because the pref is deliberately NOT per-account: a choice made
 * in luke's compose window has to still hold in vader's, and be undoable from
 * there. A per-window toggle would pass every single-account case here.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import {
  MODAL,
  setField,
  fieldValue,
  typeInBody,
  clickToolbar,
  toolbarState,
  closeComposeHard,
  openComposeFresh,
  settingsCall,
} from './composeHelpers.js';

describe('Connected Compose Spellcheck', function () {
  this.timeout(180_000);

  let luke;
  let vader;

  /** The effective state of the editable — inheritance included. */
  const bodySpellcheck = () => browser.execute((sel) => {
    const el = document.querySelector(`${sel} .ProseMirror`);
    return el ? el.spellcheck : null;
  }, MODAL);

  const subjectSpellcheck = () => browser.execute(() =>
    document.querySelector('[data-testid="compose-subject"]')?.spellcheck ?? null);

  const buttonTitle = () => browser.execute((sel) =>
    [...document.querySelectorAll(`${sel} button[title]`)]
      .find((b) => b.getAttribute('title').startsWith('Spellcheck'))?.getAttribute('title') ?? null, MODAL);

  const storedPref = () => browser.execute(() =>
    window.__SETTINGS_STORE__.getState().spellcheckEnabled);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    [luke, vader] = browser.mockAccounts || [];
    expect(luke?.id).toBeDefined();
    expect(vader?.id).toBeDefined();
  });

  afterEach(async function () {
    await closeComposeHard();
    // Global settings state: a case that turns it off has to put it back, or
    // every later compose spec in this single-app run types unchecked.
    await settingsCall('setSpellcheckEnabled', true);
  });

  after(async function () {
    await switchToFolder(luke.email, 'INBOX');
  });

  it('starts on, and says what the click will do', async function () {
    await openComposeFresh();

    expect(await bodySpellcheck()).toBe(true);
    expect(await storedPref()).toBe(true);

    // The button is lit while checking is on — the same "active" vocabulary the
    // mark buttons next to it use.
    expect((await toolbarState('Spellcheck')).active).toBe(true);
    expect(await buttonTitle()).toBe('Spellcheck on — click to turn off');
  });

  it('turns checking off for the body and the subject in one press', async function () {
    await openComposeFresh();
    await typeInBody('Ths sentnce is deliberatly wrng.');

    const hit = await clickToolbar('Spellcheck');
    expect(hit.found).toBe(true);

    expect(await bodySpellcheck()).toBe(false);
    // The subject is text the user types too — a toggle that leaves it
    // squiggled has only moved the complaint one field up.
    expect(await subjectSpellcheck()).toBe(false);
    expect((await toolbarState('Spellcheck')).active).toBe(false);
    expect(await buttonTitle()).toBe('Spellcheck off — click to turn on');
  });

  it('turns it back on from the same window', async function () {
    await openComposeFresh();
    await clickToolbar('Spellcheck');
    expect(await bodySpellcheck()).toBe(false);

    await clickToolbar('Spellcheck');
    expect(await bodySpellcheck()).toBe(true);
    expect(await storedPref()).toBe(true);
  });

  it('outlives the compose window that made the choice', async function () {
    await openComposeFresh();
    await clickToolbar('Spellcheck');
    expect(await bodySpellcheck()).toBe(false);

    await closeComposeHard();
    await openComposeFresh();

    // A window-local toggle would come back on here.
    expect(await bodySpellcheck()).toBe(false);
    expect((await toolbarState('Spellcheck')).active).toBe(false);
  });

  it('holds across accounts, and is undoable from the other one', async function () {
    // Turn it off while composing as luke.
    await switchToFolder(luke.email, 'INBOX');
    await openComposeFresh();
    await setField('compose-from', `${luke.id} ${luke.email}`);
    await clickToolbar('Spellcheck');
    expect(await bodySpellcheck()).toBe(false);
    await closeComposeHard();

    // Compose as vader instead: different account, same pref.
    await switchToFolder(vader.email, 'INBOX');
    await openComposeFresh();
    await setField('compose-from', `${vader.id} ${vader.email}`);
    expect(await fieldValue('compose-from')).toBe(`${vader.id} ${vader.email}`);
    expect(await bodySpellcheck()).toBe(false);

    // And undoing it from vader's window frees luke's next message too — the
    // pref belongs to the person, not to whichever mailbox is in front.
    await clickToolbar('Spellcheck');
    expect(await bodySpellcheck()).toBe(true);
    await closeComposeHard();

    await switchToFolder(luke.email, 'INBOX');
    await openComposeFresh();
    expect(await bodySpellcheck()).toBe(true);
  });
});
