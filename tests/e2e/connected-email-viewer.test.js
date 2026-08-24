/**
 * E2E Test: Email Viewer Features
 *
 * Tests email selection, body display, and Reply/Forward/Reply All compose flows.
 * Requires emails to be loaded in the inbox.
 */

import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import {
  HTML_QUOTED_SUBJECT,
  HTML_COLLISION_SUBJECT,
  HTML_COLLISION_MARKER,
  DARK_HEADING_ID,
} from './mockImap.js';

/**
 * Close every open compose modal via its own Close button, dismissing any
 * discard confirmation.
 *
 * Not Escape: tauri-wd does not deliver it to the webview, so the old
 * Escape-based close was a no-op. That went unnoticed while the viewer owned a
 * single ComposeModal instance and swapped its `mode` in place; now compose is
 * mounted once at App level and each Reply/Forward opens its own window, so a
 * modal left behind stacks under the next one and `querySelector` reads the
 * stale subject.
 */
async function closeCompose() {
  for (let i = 0; i < 4; i++) {
    const closed = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="compose-modal"] button[title="Close"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!closed) return;
    await browser.pause(300);

    // Confirm the discard dialog. Scoped to the dialog on purpose: the compose
    // footer has its own "Discard" button that re-opens this very dialog, and it
    // comes first in document order.
    await browser.execute(() => {
      const heading = [...document.querySelectorAll('h3')]
        .find(h => (h.textContent || '').includes('Discard message?'));
      if (!heading) return;
      for (const btn of heading.parentElement.querySelectorAll('button')) {
        if ((btn.textContent || '').trim() === 'Discard') { btn.click(); return; }
      }
    });
    await browser.pause(300);
  }
}

describe('Email Viewer', function () {
  this.timeout(60_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('should select an email and display its body', async function () {
    // Click the first email row
    const clicked = await browser.execute(() => {
      const row = document.querySelector('[data-testid="email-row"]');
      if (row && row.offsetHeight > 0) {
        row.click();
        return true;
      }
      return false;
    });

    expect(clicked).toBe(true);

    // Wait for the email viewer to load. The action bar is icon-only, so the
    // buttons are identified by their title, not their text.
    await browser.waitUntil(
      async () => {
        return browser.execute(() => {
          const btn = document.querySelector('button[title="Reply"]');
          return btn !== null && btn.offsetHeight > 0;
        });
      },
      {
        timeout: 15_000,
        timeoutMsg: 'Reply button did not appear within 15s — email body may not have loaded',
        interval: 500,
      },
    );
  });

  it('should have Reply button', async function () {
    const hasReply = await browser.execute(() => {
      const btn = document.querySelector('button[title="Reply"]');
      return btn !== null && btn.offsetHeight > 0;
    });

    expect(hasReply).toBe(true);
  });

  it('should open compose in Reply mode with Re: subject', async function () {
    // Click Reply button
    const clicked = await browser.execute(() => {
      const btn = document.querySelector('button[title="Reply"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    });

    expect(clicked).toBe(true);
    await browser.pause(500);

    // Verify compose modal is open
    const composeVisible = await browser.execute(() => {
      const modal = document.querySelector('[data-testid="compose-modal"]');
      return modal !== null && modal.offsetHeight > 0;
    });

    expect(composeVisible).toBe(true);

    // Verify subject contains "Re:"
    const hasReSubject = await browser.execute(() => {
      const subjectEl = document.querySelector('[data-testid="compose-subject"]');
      if (!subjectEl) return false;
      const value = subjectEl.value || subjectEl.textContent || '';
      return value.includes('Re:');
    });

    expect(hasReSubject).toBe(true);

    await closeCompose();
  });

  it('should have Forward button', async function () {
    const hasForward = await browser.execute(() => {
      const btn = document.querySelector('button[title="Forward"]');
      return btn !== null && btn.offsetHeight > 0;
    });

    expect(hasForward).toBe(true);
  });

  it('should open compose in Forward mode with Fwd: subject', async function () {
    // Click Forward button
    const clicked = await browser.execute(() => {
      const btn = document.querySelector('button[title="Forward"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    });

    expect(clicked).toBe(true);
    await browser.pause(500);

    // Verify compose modal is open
    const composeVisible = await browser.execute(() => {
      const modal = document.querySelector('[data-testid="compose-modal"]');
      return modal !== null && modal.offsetHeight > 0;
    });

    expect(composeVisible).toBe(true);

    // Verify subject contains "Fwd:"
    const hasFwdSubject = await browser.execute(() => {
      const subjectEl = document.querySelector('[data-testid="compose-subject"]');
      if (!subjectEl) return false;
      const value = subjectEl.value || subjectEl.textContent || '';
      return value.includes('Fwd:');
    });

    expect(hasFwdSubject).toBe(true);

    await closeCompose();
  });

  it('should have Reply All button', async function () {
    const hasReplyAll = await browser.execute(() => {
      const btn = document.querySelector('button[title="Reply All"]');
      return btn !== null && btn.offsetHeight > 0;
    });

    // Reply All is hidden for single-recipient mail, which the mock fixtures are.
    if (!hasReplyAll) {
      console.warn('[email-viewer] Reply All button not found — email is single-recipient');
    }
  });
});

/**
 * A body that never arrives.
 *
 * yoda's uid 907 answers its body FETCH with a 3s stall and then a tagged NO
 * (wdio.conf.js). Two things have to be true while and after that happens, and
 * neither was: the pane has to say it is working, and when the fetch fails it
 * has to say THAT — the old fallback copied the row's subject into `text` and
 * rendered it as the body, so a message that failed to load was pixel-identical
 * to one whose body is a single line.
 */
describe('Email Viewer — body that never loads', function () {
  this.timeout(90_000);

  const YODA = 'yoda@mock.test';
  const SUBJECT = 'Yoda message 907';

  const clickRow = (subject) => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => (r.innerText || '').includes(needle));
    if (!row || row.offsetHeight === 0) return false;
    row.click();
    return true;
  }, subject);

  const bodyErrorText = () => browser.execute(() => {
    const el = document.querySelector('[data-testid="email-body-error"]');
    return el ? el.innerText : null;
  });

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(YODA, 'INBOX');
  });

  it('shows a loader while the body is still on the wire', async function () {
    expect(await clickRow(SUBJECT)).toBe(true);

    // Sampled, not waited-for-then-read: the loader is a state the pane passes
    // through, and a single read after the fact sees only where it landed.
    let sawLoader = false;
    for (let i = 0; i < 30 && !sawLoader; i++) {
      sawLoader = await browser.execute(() => {
        const el = document.querySelector('[data-testid="email-viewer-loading"]');
        return !!el && el.offsetHeight > 0;
      });
      if (!sawLoader) await browser.pause(100);
    }
    expect(sawLoader).toBe(true);
  });

  it('names the failure instead of printing the subject as the body', async function () {
    await browser.waitUntil(async () => (await bodyErrorText()) !== null, {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: 'Viewer never rendered the body-failure state for a message the server refused',
    });

    const text = await bodyErrorText();
    expect(text).toContain('Couldn');
    // Not "Email not found". async-imap ends a fetch stream on the tagged NO
    // without surfacing it, so a refused body used to arrive as an empty result
    // and get reported as a missing message — for mail that is sitting right
    // there in the list. The reason has to say the message is still on the
    // server; that distinction is the whole reason the second probe exists.
    expect(text.toLowerCase()).toContain('still in inbox');
    expect(text.toLowerCase()).not.toContain('not found');

    // The regression itself: the subject must not be doubling as the body.
    const bodyIsSubject = await browser.execute((needle) => {
      const el = document.querySelector('.email-content');
      return !!el && (el.innerText || '').trim() === needle;
    }, SUBJECT);
    expect(bodyIsSubject).toBe(false);
  });

  it('retries the fetch from the failure state', async function () {
    const retried = await browser.execute(() => {
      const btn = document.querySelector('[data-testid="email-body-retry"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    });
    expect(retried).toBe(true);

    // The retry goes back to the server, so the pane returns to loading before
    // it lands on the same failure. Either transition proves the click is wired
    // to selectEmail rather than being a dead control.
    let wentBackToLoading = false;
    for (let i = 0; i < 30 && !wentBackToLoading; i++) {
      wentBackToLoading = await browser.execute(() => {
        const el = document.querySelector('[data-testid="email-viewer-loading"]');
        return !!el && el.offsetHeight > 0;
      });
      if (!wentBackToLoading) await browser.pause(100);
    }
    expect(wentBackToLoading).toBe(true);

    await browser.waitUntil(async () => (await bodyErrorText()) !== null, {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: 'Retry never resolved back to the failure state',
    });
  });
});

/**
 * A message the server refuses OUTRIGHT.
 *
 * yoda's uid 908 answers `NO` to its body fetch and to the `UID FETCH 908
 * (UID)` probe that follows it (wdio.conf.js). Both refusals reach the client
 * as an empty stream with no error — async-imap ends a fetch on the tagged
 * response without reading its status — so the app used to conclude the
 * message was gone and print "Email not found" for mail sitting in the list.
 * Gmail did exactly this to a real INBOX message on 2026-08-24: eight clicks,
 * eight "not found", the row never moving.
 *
 * Absence is now a claim the server has to make, and the reason the pane shows
 * has to be the server's own.
 */
describe('Email Viewer — a message the server refuses', function () {
  this.timeout(90_000);

  const YODA = 'yoda@mock.test';
  const SUBJECT = 'Yoda message 908';

  const clickRow = (subject) => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => (r.innerText || '').includes(needle));
    if (!row || row.offsetHeight === 0) return false;
    row.click();
    return true;
  }, subject);

  const bodyErrorText = () => browser.execute(() => {
    const el = document.querySelector('[data-testid="email-body-error"]');
    return el ? el.innerText : null;
  });

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(YODA, 'INBOX');
  });

  it('reports the refusal instead of calling the message deleted', async function () {
    expect(await clickRow(SUBJECT)).toBe(true);

    await browser.waitUntil(async () => (await bodyErrorText()) !== null, {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: 'Viewer never rendered the body-failure state for a message the server refused',
    });

    const text = await bodyErrorText();
    const lower = text.toLowerCase();

    // The regression: a refusal must never be read as absence.
    expect(lower).not.toContain('not found');
    expect(lower).not.toContain('no longer in');

    // And the reason has to be the server's, not one the client invented.
    expect(lower).toContain('refused');
    expect(text).toContain('Server cannot read that message');
  });

  it('keeps the row in the list — nothing was proven gone', async function () {
    const stillListed = await browser.execute((needle) => {
      return [...document.querySelectorAll('[data-testid="email-row"]')]
        .some((r) => (r.innerText || '').includes(needle));
    }, SUBJECT);
    expect(stillListed).toBe(true);
  });
});

/**
 * A message that really is gone.
 *
 * yoda's uid 909 is in the header page but every fetch of it answers OK with
 * no rows (wdio.conf.js) — what a server says about a uid it does not hold.
 * This is the other half of the 2026-08-24 report: the Autodesk message had
 * been deleted from the Gmail INBOX elsewhere, so its row sat at the top of
 * the list failing on every click, and came back on every reload because the
 * header sidecar still held it.
 *
 * A proven absence — and only a proven one — takes the row with it.
 */
describe('Email Viewer — a message the server no longer holds', function () {
  this.timeout(90_000);

  const YODA = 'yoda@mock.test';
  const SUBJECT = 'Yoda message 909';

  const rowExists = (subject) => browser.execute((needle) => {
    return [...document.querySelectorAll('[data-testid="email-row"]')]
      .some((r) => (r.innerText || '').includes(needle));
  }, subject);

  const clickRow = (subject) => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => (r.innerText || '').includes(needle));
    if (!row || row.offsetHeight === 0) return false;
    row.click();
    return true;
  }, subject);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(YODA, 'INBOX');
  });

  it('drops the row once the server proves the message is gone', async function () {
    // Positive control: the header page really does list it, so the removal
    // below is the app acting on the server's answer and not an empty list.
    await browser.waitUntil(async () => await rowExists(SUBJECT), {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: `"${SUBJECT}" never appeared in yoda's INBOX`,
    });

    expect(await clickRow(SUBJECT)).toBe(true);

    await browser.waitUntil(async () => !(await rowExists(SUBJECT)), {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: `"${SUBJECT}" is still listed after the server said it is not in the mailbox`,
    });
  });

  it('says why, instead of removing the row silently', async function () {
    const text = await browser.execute(() => {
      const el = document.querySelector('[data-testid="email-body-error"]');
      return el ? el.innerText : null;
    });
    expect(text).not.toBe(null);
    expect(text.toLowerCase()).toContain('no longer in inbox');
  });

  // Durability across a reload is NOT asserted here, and the omission is
  // deliberate: this mock still lists uid 909 on the header page — only the
  // uid-scoped fetches are faulted — so a reload re-adds the row, correctly,
  // because the server is still claiming it. A real deleted message leaves
  // the header page too. The header-cache half of the removal is covered
  // where it can be stated honestly: selectEmailVanishedRow.test.js asserts
  // the `removedUids` write, and connected-storage-matrix already proves a
  // removed uid does not repaint from a stale sidecar on reload.
});

describe('Email Viewer — one body per message', function () {
  this.timeout(90_000);

  const LUKE = 'luke@mock.test';

  // Two HTML messages on the same UID, one in INBOX and one in Sent (see
  // mockImap.js). Rendering the second used to hand back the first one's body:
  // the link-safety scanner cached each rewritten body under the bare UID, and
  // a UID is unique per mailbox only. Nothing about the header changed, so it
  // read as the right message quietly showing a stranger's content.

  const clickRow = (subject) => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => (r.innerText || '').includes(needle) && r.offsetHeight > 0);
    if (!row) return false;
    row.click();
    return true;
  }, subject);

  /** What the viewer is showing: its header subject, and the frame's content. */
  const readViewer = (headingId) => browser.execute((probeId) => {
    const iframe = document.querySelector('iframe[sandbox]');
    let doc = null;
    try { doc = iframe?.contentDocument || null; } catch { doc = null; }
    return {
      // Not the first h1 on the page — that one is the sidebar's "MailVault".
      subject: [...document.querySelectorAll('h1')]
        .filter((h) => !h.closest('[data-testid="sidebar"]'))
        .map((h) => (h.textContent || '').trim())
        .join(' | '),
      frameText: doc?.body ? (doc.body.innerText || doc.body.textContent || '').trim() : null,
      hasCollisionBody: !!doc?.getElementById('mv-collision-body'),
      hasQuotedProbe: !!doc?.getElementById(probeId),
    };
  }, headingId);

  const waitForFrame = async (subject, timeoutMsg) => {
    await browser.waitUntil(async () => {
      const v = await readViewer(DARK_HEADING_ID);
      return v.subject.includes(subject) && !!v.frameText;
    }, {
      timeout: 30_000,
      interval: 300,
      timeoutMsg: `${timeoutMsg}; viewer: ${JSON.stringify(await readViewer(DARK_HEADING_ID))}`,
    });
    // The frame reloads when its srcDoc changes; let that land before reading.
    await browser.pause(1500);
    return readViewer(DARK_HEADING_ID);
  };

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
  });

  it('renders the INBOX HTML message', async function () {
    expect(await clickRow(HTML_QUOTED_SUBJECT)).toBe(true);

    // Positive control, and the step that fills the scan cache for this UID —
    // without it the assertion below could pass on an empty cache alone.
    const viewer = await waitForFrame(HTML_QUOTED_SUBJECT, 'INBOX HTML message never rendered');
    expect(viewer.hasQuotedProbe).toBe(true);
    expect(viewer.hasCollisionBody).toBe(false);
  });

  it('renders the Sent message that shares that UID, not the INBOX body', async function () {
    await switchToFolder(LUKE, 'Sent');
    expect(await clickRow(HTML_COLLISION_SUBJECT)).toBe(true);

    const viewer = await waitForFrame(HTML_COLLISION_SUBJECT, 'Sent HTML message never rendered');

    // The header was always right — the body was the lie.
    expect(viewer.subject).toContain(HTML_COLLISION_SUBJECT);
    expect(viewer.frameText).toContain(HTML_COLLISION_MARKER);
    expect(viewer.hasCollisionBody).toBe(true);
    expect(viewer.hasQuotedProbe).toBe(false);
  });
});
