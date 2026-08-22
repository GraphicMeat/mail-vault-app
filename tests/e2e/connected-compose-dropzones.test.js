/**
 * E2E: Connected Compose Drop Zones — where a dropped file actually lands.
 *
 * Three targets, three different outcomes, and the difference between them IS
 * the feature:
 *   - the editor            → image files are inlined at the drop position,
 *                             non-images are attached
 *   - the attach strip      → everything attaches, images included
 *   - anywhere else on the modal (header, To row) → attaches (fallback)
 *
 * A native Finder drag cannot be driven through WebDriver, so the DataTransfer
 * is built inside the page (composeHelpers `dropFiles`/`dragFilesOver`/
 * `pasteFiles`). That exercises every handler under test. The native half is
 * one config line (tauri.conf.json `dragDropEnabled: false`) and is not
 * provable from here.
 *
 * The last two cases go all the way to disk. The harness has NO SMTP server
 * (mockImap points smtpHost at the mock IMAP port), so a real Send builds the
 * MIME, stages a `.eml` under `Maildir/<accountId>/Sent/cur/`, and only then
 * fails on SMTP. That staged file is the one end-to-end proof of what compose
 * hands to the wire — the assertion that an inline picture leaves as a
 * `cid:`-referenced MIME part and not as a `data:` URI (Gmail and Outlook.com
 * strip those, so a data URI reaches the recipient as nothing at all).
 *
 * framer-motion exits never finish under the occluded E2E window, so nothing
 * here asserts "the element is gone" after an animation — the drop zones are
 * plain conditional renders and the modal unmounts outright on close/minimize.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  MODAL,
  EDITOR,
  pngFile,
  pdfFile,
  dragFilesOver,
  dragLeave,
  dropFiles,
  pasteFiles,
  editorHtml,
  editorImages,
  typeInBody,
  attachments,
  attachViaInput,
  setField,
  fieldValue,
  modalOpen,
  modalAttr,
  testidPresent,
  testidText,
  clickButtonTitle,
  bubbles,
  clickBubble,
  closeComposeHard,
  openComposeFresh,
  listSent,
  clickSend,
  readStagedEml,
  flatten,
  waitForOutboxError,
} from './composeHelpers.js';

const HINT = 'compose-inline-dropzone-hint';
const STRIP = 'compose-attach-dropzone';
const STRIP_SEL = `[data-testid="${STRIP}"]`;
const HEADER = `${MODAL} h2`;

describe('Connected Compose Drop Zones', function () {
  this.timeout(120_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  // ── waits ────────────────────────────────────────────────────────────────
  // Every wait re-reads the state AFTER the timeout before throwing:
  // `timeoutMsg` is built when the options object is constructed, so a
  // snapshot interpolated into it shows the state before the wait, not the
  // state that failed.

  async function waitForImages(count, what) {
    try {
      await browser.waitUntil(async () => (await editorImages()).length === count, {
        timeout: 15_000,
        interval: 250,
        timeoutMsg: `editor never held ${count} inline image(s) after ${what}`,
      });
    } catch {
      throw new Error(
        `RichTextEditor never inlined ${count} image(s) after ${what} — ` +
        `handleDrop/handlePaste did not insert them. Editor images now: ` +
        `${JSON.stringify(await editorImages())}`,
      );
    }
  }

  async function waitForAttachments(names, what) {
    try {
      await browser.waitUntil(async () => {
        const rows = await attachments();
        return rows.length === names.length && names.every((n) => rows.includes(n));
      }, {
        timeout: 15_000,
        interval: 250,
        timeoutMsg: `attachment rows never became ${JSON.stringify(names)} after ${what}`,
      });
    } catch {
      throw new Error(
        `ComposeModal never attached ${JSON.stringify(names)} after ${what} — ` +
        `the file never reached the attachment handler. Rows now: ` +
        `${JSON.stringify(await attachments())}`,
      );
    }
  }

  async function waitForZones(what) {
    try {
      await browser.waitUntil(
        async () => (await testidPresent(HINT)) && (await testidPresent(STRIP)),
        { timeout: 10_000, interval: 200, timeoutMsg: `drop zones never appeared while ${what}` },
      );
    } catch {
      throw new Error(
        `ComposeModal never showed both drop zones while ${what} — the modal's ` +
        `dragenter/dragover handler never armed them (hint=${await testidPresent(HINT)}, ` +
        `strip=${await testidPresent(STRIP)}, data-dragging=${await modalAttr('data-dragging')})`,
      );
    }
  }

  async function waitForNoZones(what) {
    try {
      await browser.waitUntil(
        async () => !(await testidPresent(HINT)) && !(await testidPresent(STRIP)),
        { timeout: 10_000, interval: 200, timeoutMsg: `drop zones never went away after ${what}` },
      );
    } catch {
      throw new Error(
        `ComposeModal left a drop zone on screen after ${what} — the drag depth ` +
        `never returned to 0 (hint=${await testidPresent(HINT)}, strip=${await testidPresent(STRIP)}, ` +
        `data-dragging=${await modalAttr('data-dragging')})`,
      );
    }
    // The attribute is the app's own record of the drag; the zones are only
    // what it renders from it.
    expect(await modalAttr('data-dragging')).toBe('false');
  }

  // ── the staged .eml on disk ──────────────────────────────────────────────
  // sentDir/listSent/readStagedEml/flatten/waitForOutboxError live in
  // composeHelpers.js — connected-compose-from-identities asserts on the same
  // staged file, and one copy of the "no SMTP here" knowledge is enough.

  /**
   * Send from account[0] (luke@mock.test) and hand back the staged MIME.
   *
   * From is set FIRST on purpose: changing the account re-runs ComposeModal's
   * init effect, which rewrites `body` — do it after the drop and the inline
   * image is wiped out of the editor before Send ever reads it.
   */
  async function composeAndSend({ subject, drop = [], attach = [] }) {
    const account = browser.mockAccounts[0];
    const before = new Set(listSent(account.id));

    await openComposeFresh();

    const fromKey = `${account.id} ${account.email}`;
    const fromSet = await setField('compose-from', fromKey);
    if (!fromSet) throw new Error('compose-from select is missing — cannot pin the sending account');
    if ((await fieldValue('compose-from')) !== fromKey) {
      throw new Error(
        `compose-from did not settle on ${account.email} (${account.id}); it reads ` +
        `${await fieldValue('compose-from')} — the staged .eml would land under another account`,
      );
    }

    if (drop.length) {
      await dropFiles(EDITOR, drop);
      await waitForImages(drop.length, 'the pre-send drop on the editor');
    }
    if (attach.length) {
      await attachViaInput(attach);
      await waitForAttachments(attach.map((f) => f.name), 'attaching through the paperclip input');
    }

    await setField('compose-to', account.email);
    await setField('compose-subject', subject);
    await setField('compose-delay', 0);

    expect(await clickSend()).toBe(true);
    await browser.pause(400);

    // The form validates before it ever builds a MIME, and a rejected submit
    // looks exactly like a staging failure from the disk side.
    const formError = await testidText('compose-error');
    if (formError) throw new Error(`Send was rejected by the compose form: "${formError}"`);

    const raw = await readStagedEml(account.id, before, subject);
    await waitForOutboxError(subject);
    return flatten(raw);
  }

  // ── drag state ───────────────────────────────────────────────────────────

  it('shows no drop zones and data-dragging=false on a fresh compose', async function () {
    await openComposeFresh();

    expect(await testidPresent(HINT)).toBe(false);
    expect(await testidPresent(STRIP)).toBe(false);
    expect(await modalAttr('data-dragging')).toBe('false');
  });

  it('arms both drop zones while a file is dragged over the modal', async function () {
    await openComposeFresh();

    const drag = await dragFilesOver(HEADER, [pngFile()]);
    expect(drag.found).toBe(true);
    // dragover has to be cancelled or WebKit refuses the drop and navigates the
    // webview to the dropped file instead — the app disappears behind a PNG.
    expect(drag.accepted).toBe(true);

    await waitForZones('a file is dragged over the modal header');
    expect(await modalAttr('data-dragging')).toBe('true');
  });

  it('hides both drop zones again when the drag leaves the modal', async function () {
    await openComposeFresh();

    expect((await dragFilesOver(HEADER, [pngFile()])).found).toBe(true);
    await waitForZones('a file is dragged over the modal header');

    await dragLeave(HEADER, [pngFile()]);
    await waitForNoZones('the drag left the modal (depth back to 0)');
  });

  // ── the editor ───────────────────────────────────────────────────────────

  it('inlines a PNG dropped on the editor and attaches nothing', async function () {
    await openComposeFresh();

    await dropFiles(EDITOR, [pngFile('dropped.png')]);
    await waitForImages(1, 'dropping a PNG on the editor');

    const [img] = await editorImages();
    // The src is the base64 payload itself — the send-time extractor is what
    // turns it into a cid: part later (asserted at the bottom of this file).
    expect(img.src.startsWith('data:image/png')).toBe(true);
    // alt carries the filename because the extractor uses it as the MIME part name.
    expect(img.alt).toBe('dropped.png');

    // An image that also attached would leave the recipient with the picture twice.
    expect(await attachments()).toEqual([]);
    expect(await testidPresent('compose-attachments')).toBe(false);

    await waitForNoZones('the drop landed');
  });

  it('inserts each dropped image at the position it was dropped on', async function () {
    await openComposeFresh();
    await typeInBody('hello');

    // Points are taken from the paragraph box, not the editor box: the editor's
    // padding can resolve to no position at all, and ProseMirror's fallback
    // there is the current selection — which after the first insert sits BEFORE
    // "hello" and would make this assertion pass for the wrong reason.
    const line = await browser.execute((sel) => {
      const p = document.querySelector(`${sel} p`) || document.querySelector(sel);
      const r = p.getBoundingClientRect();
      return {
        start: { x: Math.round(r.left + 1), y: Math.round(r.top + r.height / 2) },
        end: { x: Math.round(r.right - 2), y: Math.round(r.top + r.height / 2) },
      };
    }, EDITOR);

    await dropFiles(EDITOR, [pngFile('first.png')], line.start);
    await waitForImages(1, 'dropping a PNG at the start of the line');

    await dropFiles(EDITOR, [pngFile('second.png')], line.end);
    await waitForImages(2, 'dropping a second PNG at the end of the line');

    const html = await editorHtml();
    const iFirst = html.indexOf('first.png');
    const iHello = html.indexOf('hello');
    const iSecond = html.indexOf('second.png');

    // All three have to be there before the ordering means anything.
    expect(iFirst).toBeGreaterThan(-1);
    expect(iHello).toBeGreaterThan(-1);
    expect(iSecond).toBeGreaterThan(-1);
    // Dropped before the text → inserted before the text; dropped after → after.
    expect(iFirst).toBeLessThan(iHello);
    expect(iSecond).toBeGreaterThan(iHello);
  });

  it('attaches a PDF dropped on the editor instead of inlining it', async function () {
    await openComposeFresh();

    await dropFiles(EDITOR, [pdfFile('notes.pdf')]);
    await waitForAttachments(['notes.pdf'], 'dropping a PDF on the editor');

    expect(await editorImages()).toEqual([]);
    expect(await testidText('compose-attachments')).toContain('1 Attachment(s)');
    await waitForNoZones('the drop landed');
  });

  it('splits a mixed drop on the editor: image inline, document attached', async function () {
    await openComposeFresh();

    await dropFiles(EDITOR, [pngFile('mixed.png'), pdfFile('mixed.pdf')]);
    await waitForImages(1, 'dropping a PNG and a PDF together on the editor');
    await waitForAttachments(['mixed.pdf'], 'dropping a PNG and a PDF together on the editor');

    const [img] = await editorImages();
    expect(img.alt).toBe('mixed.png');
    // The PNG must not appear on both surfaces.
    expect(await attachments()).toEqual(['mixed.pdf']);
  });

  // ── the attach strip and the modal fallback ──────────────────────────────

  it('attaches an image dropped on the attach strip instead of inlining it', async function () {
    await openComposeFresh();

    // The strip only exists while a drag is in progress.
    expect((await dragFilesOver(HEADER, [pngFile('strip.png')])).found).toBe(true);
    await waitForZones('a file is dragged over the modal header');

    const dropped = await dropFiles(STRIP_SEL, [pngFile('strip.png')]);
    expect(dropped.found).toBe(true);

    await waitForAttachments(['strip.png'], 'dropping a PNG on the attach strip');
    // The strip is the explicit "attach this, do not embed it" gesture.
    expect(await editorImages()).toEqual([]);
    await waitForNoZones('the strip drop landed');
  });

  it('attaches a file dropped on the modal header (the modal fallback)', async function () {
    await openComposeFresh();

    const dropped = await dropFiles(HEADER, [pdfFile('header.pdf')]);
    expect(dropped.found).toBe(true);

    await waitForAttachments(['header.pdf'], 'dropping a PDF on the modal header');
    expect(await editorImages()).toEqual([]);
    await waitForNoZones('the header drop landed');
  });

  // ── paste ────────────────────────────────────────────────────────────────

  it('inlines an image pasted into the editor', async function () {
    await openComposeFresh();

    const pasted = await pasteFiles([pngFile('pasted.png')]);
    expect(pasted.found).toBe(true);

    await waitForImages(1, 'pasting a PNG into the editor');
    const [img] = await editorImages();
    expect(img.src.startsWith('data:image/png')).toBe(true);
    expect(img.alt).toBe('pasted.png');
    expect(await attachments()).toEqual([]);
  });

  // ── survives a round trip through a bubble ───────────────────────────────

  it('keeps an inline image across minimize and restore', async function () {
    await openComposeFresh();

    await dropFiles(EDITOR, [pngFile('kept.png')]);
    await waitForImages(1, 'dropping a PNG on the editor');

    const subject = `Inline keep ${Date.now()}`;
    expect(await setField('compose-subject', subject)).toBe(true);

    expect(await clickButtonTitle('Minimize')).toBe(true);
    try {
      await browser.waitUntil(async () => (await bubbles()).some((lines) => lines.some((l) => l.includes(subject))), {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: 'no compose bubble carried the subject after minimize',
      });
    } catch {
      throw new Error(
        `Minimize did not produce a draft bubble for "${subject}" — the draft was ` +
        `dropped instead of saved. Bubbles: ${JSON.stringify(await bubbles())}`,
      );
    }

    expect(await clickBubble(0)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 10_000,
      interval: 250,
      timeoutMsg: 'clicking the draft bubble never reopened the compose modal',
    });

    // The draft body is HTML with a data: URI in it; the Image extension has to
    // parse it back out (allowBase64), or the picture is silently lost.
    await waitForImages(1, 'restoring the draft from its bubble');
    const [img] = await editorImages();
    expect(img.alt).toBe('kept.png');
    expect(img.src.startsWith('data:image/png')).toBe(true);
  });

  // ── what actually leaves: the staged .eml ────────────────────────────────

  it('stages the inline image as a cid: part, never a data: URI', async function () {
    // Staging is fast, but the SMTP failure that follows it is not — it runs
    // against a port that speaks IMAP.
    this.timeout(200_000);

    const subject = `Inline cid ${Date.now()}`;
    const raw = await composeAndSend({
      subject,
      drop: [pngFile('inline.png')],
      attach: [pdfFile('report.pdf')],
    });

    // The picture travels with the body, not beside it.
    expect(raw).toContain('multipart/related');
    expect(/Content-ID:\s*<[^>]+@mailvault\.inline>/i.test(raw)).toBe(true);
    expect(/Content-Disposition:\s*inline/i.test(raw)).toBe(true);
    // The HTML has to point at the part…
    expect(raw).toContain('cid:');
    // …and must not still carry the payload Gmail and Outlook.com strip.
    expect(raw).not.toContain('data:image');

    // A real attachment alongside an inline image means both structures, and
    // mixed has to be the outer one or the attachment ends up inside the body.
    const iMixed = raw.indexOf('multipart/mixed');
    const iRelated = raw.indexOf('multipart/related');
    expect(iMixed).toBeGreaterThan(-1);
    expect(iMixed).toBeLessThan(iRelated);
  });

  it('stages a plain attachment as multipart/mixed with no related part', async function () {
    this.timeout(200_000);

    const subject = `Plain mixed ${Date.now()}`;
    const raw = await composeAndSend({ subject, attach: [pdfFile('plain.pdf')] });

    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('plain.pdf');
    // Nothing is inline here, so wrapping the body in multipart/related would
    // be structure the message does not need.
    expect(raw).not.toContain('multipart/related');
    expect(raw.toLowerCase()).not.toContain('@mailvault.inline');
  });
});
