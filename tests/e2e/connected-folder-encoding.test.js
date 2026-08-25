/**
 * E2E: a folder whose name arrives in IMAP modified UTF-7 reads as its real
 * name, and still selects by its wire name.
 *
 * Reported by bson73 (discussion #1) against v2.10.2: "The program changes
 * 'Bokelmühle' to 'Bokelmu&Awg-hle,' and this happens everywhere in the
 * folders." `&Awg-` is base64 "Awg" → U+0308 COMBINING DIAERESIS — his server
 * stores the name decomposed, so the escape covers only the accent. Nothing in
 * the app decoded RFC 3501 §5.1.3, so the wire name went straight to the
 * screen.
 *
 * Both halves are asserted here, because a fix that decodes too eagerly is
 * worse than the bug: the escaped form is the mailbox's identity — it is what
 * SELECT takes and what the Maildir directory on disk is named. So:
 *   - the sidebar and the list header must show "Bokelmühle";
 *   - the store's activeMailbox must still be "Bokelmu&Awg-hle", and the
 *     folder must actually load its mail, which only happens if SELECT got the
 *     encoded name.
 */

import { waitForApp, switchToFolder, clickSidebarItem, sidebarHasFolder, folderHeaderText, visibleRowSubjects } from './helpers.js';

const ACCOUNT = 'yoda@mock.test';
const WIRE_NAME = 'Bokelmu&Awg-hle';
const REAL_NAME = 'Bokelmühle';

const sidebarText = () => browser.execute(() =>
  document.querySelector('[data-testid="sidebar"]')?.innerText || '');

const activeMailbox = () => browser.execute(() =>
  window.__MAIL_STORE__?.getState?.().activeMailbox ?? null);

describe('Connected Folders — modified UTF-7 names', function () {
  before(async () => {
    await waitForApp();
    // Land on the account first; its INBOX is plain ASCII, so this proves the
    // account switch without depending on the name under test.
    await switchToFolder(ACCOUNT, 'INBOX');
  });

  it('shows the decoded name in the sidebar, not the escaped one', async () => {
    await browser.waitUntil(() => sidebarHasFolder(REAL_NAME), {
      timeout: 20_000, interval: 300,
      timeoutMsg: `Sidebar never listed "${REAL_NAME}" — it reads:\n${await sidebarText()}`,
    });
    expect(await sidebarText()).not.toContain(WIRE_NAME);
    expect(await sidebarText()).not.toContain('&Awg-');
  });

  it('opens the folder by its wire name and shows the decoded one', async () => {
    expect(await clickSidebarItem(REAL_NAME)).toBe(true);

    await browser.waitUntil(async () => (await folderHeaderText()) === REAL_NAME, {
      timeout: 20_000, interval: 300,
      timeoutMsg: `List header never showed "${REAL_NAME}" (it says "${await folderHeaderText()}")`,
    });

    // The identity half: decoding is for the screen only. If this ever equals
    // REAL_NAME, SELECT and every Maildir path built from it are wrong.
    await browser.waitUntil(async () => (await activeMailbox()) === WIRE_NAME, {
      timeout: 20_000, interval: 300,
      timeoutMsg: `Store's activeMailbox is ${JSON.stringify(await activeMailbox())}, expected the wire name ${JSON.stringify(WIRE_NAME)}`,
    });

    // And the folder has to actually load — a SELECT sent with a decoded name
    // gets NONEXISTENT back and renders an empty folder.
    await browser.waitUntil(async () => (await visibleRowSubjects()).some(r => r.includes('Yoda umlaut')), {
      timeout: 30_000, interval: 500,
      timeoutMsg: `"${REAL_NAME}" never rendered its mail — rows: ${JSON.stringify(await visibleRowSubjects())}`,
    });
  });

  it('leaves no escape sequence anywhere on screen', async () => {
    // The header, the row list, the sidebar and any toast are all on this page
    // while the folder is open — one read covers every surface the folder name
    // reaches in this view.
    expect(await browser.execute(() => document.body.innerText || '')).not.toContain('&Awg-');
  });
});
