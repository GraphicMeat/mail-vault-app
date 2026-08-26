/**
 * E2E Test: a mailto: link in a message body opens compose
 *
 * An address printed in someone's email was dead text here. Every link handler
 * on the body iframe (EmailViewer, ThreadView, FullViewEmailModal,
 * ChatBubbleView) returned early on `mailto:` — so the click did nothing at
 * all, and the address had to be copied out by hand to write back.
 *
 * It now opens a compose window prefilled from the URI (utils/mailto.js). Two
 * things have to hold beyond "a window appeared": the click must not navigate
 * the frame or reach the OS mail client, and an untouched prefill must close
 * without claiming the user has unsaved work.
 *
 * Fixture: the HTML message in luke's INBOX (mockImap.js `htmlQuotedMessage`)
 * carries a mailto: with a cc and a subject. The suite seeds three accounts,
 * so the From row is a real choice — the prefill must leave from the account
 * whose mail is on screen, not from whichever one sorts first.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  HTML_QUOTED_SUBJECT, MAILTO_LINK_ID, MAILTO_TO, MAILTO_CC, MAILTO_SUBJECT,
} from './mockImap.js';
import {
  MODAL, modalOpen, modalCount, fieldValue, editorText, closeComposeHard,
} from './composeHelpers.js';

const LUKE = 'luke@mock.test';

/** Click the mailto: anchor inside the message iframe. */
const clickMailtoLink = (linkId) => browser.execute((id) => {
  const doc = document.querySelector('iframe[sandbox]')?.contentDocument;
  const link = doc?.getElementById(id);
  if (!link) return { clicked: false, reason: doc ? 'link missing' : 'no iframe document' };
  link.click();
  return { clicked: true };
}, linkId);

/** Proof the frame is still showing the message it was showing. */
const frameStillOnMessage = (linkId) => browser.execute((id) => {
  const iframe = document.querySelector('iframe[sandbox]');
  const doc = iframe?.contentDocument;
  return {
    hasIframe: !!iframe,
    linkStillThere: !!doc?.getElementById(id),
    // A navigation would replace the srcdoc document; the marker heading is
    // part of the body this fixture renders.
    bodyLength: doc?.body ? doc.body.innerText.length : -1,
  };
}, linkId);

const discardDialogShown = () => browser.execute(() =>
  !!document.querySelector('[data-testid="compose-discard-dialog"]'));

describe('A mailto: link opens compose', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await closeComposeHard();

    // The one HTML message in the suite; match on subject, not row order.
    const clicked = await browser.execute((subject) => {
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        if ((row.textContent || '').includes(subject) && row.offsetHeight > 0) {
          row.click();
          return true;
        }
      }
      return false;
    }, HTML_QUOTED_SUBJECT);
    expect(clicked).toBe(true);

    // The handler lives on the frame's document, so it exists only once the
    // frame has loaded one.
    await browser.waitUntil(async () => (await frameStillOnMessage(MAILTO_LINK_ID)).linkStillThere, {
      timeout: 30_000,
      interval: 400,
      timeoutMsg: 'The message iframe never rendered the mailto: link',
    });
  });

  after(async function () {
    await closeComposeHard();
  });

  it('opens one compose window prefilled from the URI', async function () {
    const click = await clickMailtoLink(MAILTO_LINK_ID);
    expect(click.clicked).toBe(true);

    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: 'Clicking the mailto: link opened no compose window',
    });

    // One click is one window. Two would autosave over each other's draft.
    expect(await modalCount()).toBe(1);
    expect(await fieldValue('compose-to')).toBe(MAILTO_TO);
    expect(await fieldValue('compose-cc')).toBe(MAILTO_CC);
    expect(await fieldValue('compose-subject')).toBe(MAILTO_SUBJECT);
  });

  it('leaves the message on screen — the click never navigates the frame', async function () {
    // Without the compose check this passes at HEAD, where the click does
    // nothing at all: "the frame did not navigate" is also true of a dead link.
    expect(await modalOpen()).toBe(true);
    const frame = await frameStillOnMessage(MAILTO_LINK_ID);
    expect(frame.hasIframe).toBe(true);
    expect(frame.linkStillThere).toBe(true);
    expect(frame.bodyLength).toBeGreaterThan(0);
  });

  it('leaves from the account whose message carried the link', async function () {
    // Three accounts are seeded, so the From row is a real choice and a
    // default of "whichever account sorts first" would be visible here.
    const lukeId = (browser.mockAccounts || []).find((a) => a.email === LUKE)?.id;
    expect(lukeId).toBeTruthy();
    const from = await fieldValue('compose-from');
    // `"<accountId> <address>"` — the select's option key.
    expect(from).not.toBe(null);
    expect(from.startsWith(lukeId)).toBe(true);
  });

  it('writes nothing into the body but the signature slot', async function () {
    // The fixture's mailto: carries no `body=`, so the editor is the user's to
    // fill — a prefilled quote here would be this feature inventing content.
    const text = await editorText();
    expect(text).not.toBe(null);
    expect(text).not.toContain(MAILTO_SUBJECT);
  });

  it('closes untouched without claiming there are unsaved changes', async function () {
    // A prefill is a fresh compose, not a restored draft: its own content is
    // its baseline. Read against an empty baseline it looked dirty, and every
    // mailto: click ended in a discard confirmation the user never earned.
    // Positive control: with no window open, "no discard dialog" and "no modal"
    // are both true for the wrong reason.
    expect(await modalCount()).toBe(1);

    await browser.execute((sel) => {
      document.querySelector(sel)?.querySelector('button[title="Close"]')?.click();
    }, MODAL);
    await browser.pause(400);

    expect(await discardDialogShown()).toBe(false);
    expect(await modalCount()).toBe(0);
  });
});
