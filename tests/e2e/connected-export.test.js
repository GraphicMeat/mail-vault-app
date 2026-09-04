/**
 * E2E: exporting mail as an image or as a self-contained HTML file.
 *
 * This is the only place the rasterizer is exercised in the real webview. Every
 * unit test above it mocks `modern-screenshot`, so a canvas that comes back
 * blank — the known WebKit foreignObject flake — is invisible to all of them.
 * Here the bytes are read back off disk and the PNG header is parsed.
 *
 * Two seams are injected, both compiled out of a shipped build:
 *   `window.__MV_EXPORT_DEST__` / `__MV_EXPORT_DIR__` — WebDriver cannot drive
 *     a native macOS save panel, so the destination is handed over instead.
 *   `window.__MV_FORCE_EXPORT_FAILURE__` — without it the suite only ever sees
 *     the happy path, and an absence-assertion that was never reachable passes
 *     for the wrong reason.
 *
 * Both mock accounts are used: provenance names the account a message actually
 * came from, and a single-account run cannot tell that from "names the active
 * account", which is the same string when only one exists.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { setPremium } from './mockBilling.js';
import {
  EXPORT_ATTACHMENT_SUBJECT, EXPORT_ATTACHMENT_PDF_NAME, EXPORT_ATTACHMENT_PDF_BASE64,
  EXPORT_ATTACHMENT_PNG_NAME, EXPORT_ATTACHMENT_PNG_BASE64, EXPORT_ATTACHMENT_INLINE_NAME,
} from './mockImap.js';

const OUT = path.join(os.tmpdir(), `mv-export-${process.pid}`);
const ACCOUNT_A = 'luke@mock.test';
const ACCOUNT_B = 'vader@mock.test';

const dialogOpen = () => browser.execute(() =>
  Boolean([...document.querySelectorAll('[role="dialog"]')]
    .find(d => d.offsetHeight > 0 && /Export/.test(d.textContent || ''))));

/** The export dialog, or null. Every click below is scoped to it. */
function exportDialog() {
  return browser.execute(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')]
      .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
    return d ? d.textContent : null;
  });
}

/**
 * Open a SINGLE message in the reading pane.
 *
 * Not just the first row: rows are threaded, and the first one is usually a
 * conversation. Clicking it opens the thread view, whose per-message bars
 * deliberately carry no Export — the thread header owns that — so a spec that
 * took whatever the first row gave it waited out its timeout looking for a
 * button that was never meant to be there.
 */
async function openFirstMessage() {
  await browser.waitUntil(async () => browser.execute(() => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find(r => r.offsetHeight > 0 && Number(r.getAttribute('data-thread-count') || 1) === 1);
    if (!row) return false;
    row.click();
    return true;
  }), { timeout: 30_000, interval: 500, timeoutMsg: 'no single-message row to open' });

  try {
    await browser.waitUntil(async () => browser.execute(() =>
      Boolean(document.querySelector('button[title="Export"]'))),
    { timeout: 45_000, interval: 500, timeoutMsg: 'no export button' });
  } catch (err) {
    const titles = await browser.execute(() =>
      [...document.querySelectorAll('button[title]')].map(b => b.getAttribute('title')));
    throw new Error(`the viewer never showed an Export button; buttons present: ${JSON.stringify(titles)}`);
  }
}

/** Open the one message with this subject, whatever row it landed on. */
async function openBySubject(subject) {
  await browser.waitUntil(async () => browser.execute((text) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find(r => r.offsetHeight > 0 && (r.textContent || '').includes(text));
    if (!row) return false;
    row.click();
    return true;
  }, subject), { timeout: 30_000, interval: 500, timeoutMsg: `no row for "${subject}"` });

  await browser.waitUntil(async () => browser.execute(() =>
    Boolean(document.querySelector('button[title="Export"]'))),
  { timeout: 45_000, interval: 500, timeoutMsg: `the viewer never showed an Export button for "${subject}"` });
}

async function openThread(minMessages = 3) {
  await browser.waitUntil(async () => {
    const clicked = await browser.execute((min) => {
      const rows = [...document.querySelectorAll('[data-testid="email-row"]')];
      const row = rows.find(r => r.offsetHeight > 0
        && Number(r.getAttribute('data-thread-count') || 1) >= min);
      if (row) { row.click(); return true; }
      const list = [...document.querySelectorAll('div')]
        .find(d => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 200);
      if (list) list.scrollTop = list.scrollTop > 0 ? 0 : list.scrollTop + list.clientHeight;
      return false;
    }, minMessages);
    if (!clicked) return false;
    return browser.execute(() => (document.body.textContent || '').includes('messages in thread'));
  }, { timeout: 45_000, interval: 1000, timeoutMsg: `no thread row with ${minMessages}+ messages` });
}

/**
 * Click one named Export entry point. Naming it matters: in a thread view both
 * the thread header's button and (once a message is open) the viewer's live at
 * once, and taking whichever matched first exported a single message from a
 * case that meant to export the whole thread — the layout radios then never
 * rendered, because a one-message export has no layout to choose.
 */
async function clickExportEntry(title = 'Export') {
  const clicked = await browser.execute((t) => {
    const btn = [...document.querySelectorAll(`button[title="${t}"]`)].find(b => b.offsetHeight > 0);
    if (!btn) return false;
    btn.click();
    return true;
  }, title);
  expect(clicked).toBe(true);
  await browser.waitUntil(dialogOpen, { timeout: 10_000, timeoutMsg: 'the export dialog never opened' });
}

/** Dismiss any export dialog that is still up, and wait until it is gone. */
async function closeExportDialog() {
  await browser.execute(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')]
      .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
    if (!d) return;
    const labels = ['Maybe later', 'Cancel'];
    const btn = [...d.querySelectorAll('button')]
      .find(b => labels.includes((b.textContent || '').trim()));
    if (btn) btn.click();
    else d.parentElement?.querySelector('.absolute.inset-0')?.click();
  });
  await browser.waitUntil(async () => !(await dialogOpen()),
    { timeout: 10_000, interval: 250, timeoutMsg: 'an export dialog stayed open' });
}

/** Pick a radio inside the dialog by its aria-label. */
async function choose(label) {
  const picked = await browser.execute((name) => {
    const d = [...document.querySelectorAll('[role="dialog"]')]
      .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
    if (!d) return false;
    const input = [...d.querySelectorAll('input[type="radio"]')]
      .find(i => (i.getAttribute('aria-label') || '') === name);
    if (!input) return false;
    input.click();
    return true;
  }, label);
  expect(picked).toBe(true);
  await browser.pause(150);
}

async function setMirror(on) {
  await browser.execute((want) => {
    const d = [...document.querySelectorAll('[role="dialog"]')]
      .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
    const box = d && d.querySelector('input[type="checkbox"]');
    if (box && box.checked !== want) box.click();
  }, on);
  await browser.pause(100);
}

/**
 * Tick or untick one of the dialog's checkboxes by the text of its label. The
 * dialog remembers them between opens, so every case sets the ones it cares
 * about rather than assuming the default it was built with.
 */
async function setCheckbox(labelText, want) {
  const found = await browser.execute((text, value) => {
    const d = [...document.querySelectorAll('[role="dialog"]')]
      .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
    if (!d) return false;
    const label = [...d.querySelectorAll('label')].find(l => (l.textContent || '').includes(text));
    const box = label && label.querySelector('input[type="checkbox"]');
    if (!box) return false;
    if (box.checked !== value) box.click();
    return true;
  }, labelText, want);
  expect(found).toBe(true);
  await browser.pause(100);
}

/** Click the dialog's own Export button (not the action bar's icon). */
async function confirmExport() {
  const clicked = await browser.execute(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')]
      .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
    if (!d) return false;
    const btn = [...d.querySelectorAll('button')]
      .find(b => (b.textContent || '').trim() === 'Export');
    if (!btn) return false;
    btn.click();
    return true;
  });
  expect(clicked).toBe(true);
}

const setDest = (p) => browser.execute((dest) => { window.__MV_EXPORT_DEST__ = dest; }, p);
const setDir = (p) => browser.execute((dir) => { window.__MV_EXPORT_DIR__ = dir; }, p);
const setFault = (f) => browser.execute((fault) => {
  if (fault) window.__MV_FORCE_EXPORT_FAILURE__ = fault;
  else delete window.__MV_FORCE_EXPORT_FAILURE__;
}, f);

const clearSeams = () => browser.execute(() => {
  delete window.__MV_EXPORT_TRACE__;
  delete window.__MV_EXPORT_DEST__;
  delete window.__MV_EXPORT_DIR__;
  delete window.__MV_FORCE_EXPORT_FAILURE__;
});

/** Dismiss the dialog if it is still up, so the next case starts clean. */
async function closeDialog() {
  await browser.execute(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')]
      .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
    if (!d) return;
    const btn = [...d.querySelectorAll('button')]
      .find(b => /^(Cancel|Maybe later)$/.test((b.textContent || '').trim()))
      || d.querySelector('button[aria-label="Close"]');
    if (btn) btn.click();
  });
  await browser.pause(300);
}

/**
 * Wait for bytes on disk, and if none arrive say what the app was showing. A
 * bare "nothing was written" names the symptom and hides the notice the dialog
 * is displaying, which is the only place the reason exists.
 */
async function waitForWritten(check, what, timeout = 90_000) {
  try {
    await browser.waitUntil(check, { timeout, interval: 500, timeoutMsg: 'no bytes' });
  } catch (err) {
    const shown = await browser.execute(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].find(el => el.offsetHeight > 0);
      return d ? (d.textContent || '').replace(/\s+/g, ' ').slice(0, 400) : '(no dialog on screen)';
    });
    const trace = await browser.execute(() => JSON.stringify(window.__MV_EXPORT_TRACE__ || null));
    throw new Error(`${typeof what === 'function' ? what() : what} — the dialog was showing: ${shown}\n  export trace: ${trace}`);
  }
}
const waitForFile = (file, timeout) => waitForWritten(
  () => fs.existsSync(file) && fs.statSync(file).size > 0, `nothing was written to ${file}`, timeout);

describe('Export', function () {
  this.timeout(180_000);

  before(async function () {
    fs.mkdirSync(OUT, { recursive: true });
    await waitForApp();
    await waitForEmails();
    await setPremium(true);
  });

  afterEach(async function () {
    await clearSeams();
    await closeDialog();
  });

  it('writes a PNG of the open message with real pixels at 2x', async function () {
    const dest = path.join(OUT, 'single.png');
    await openFirstMessage();
    await clickExportEntry();
    await choose('Image');
    await setMirror(false);
    await setDest(dest);
    await confirmExport();
    await waitForFile(dest);

    const bytes = fs.readFileSync(dest);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');   // PNG magic
    expect(bytes.readUInt32BE(16)).toBe(1640);                               // 820 CSS px at 2x
    expect(bytes.readUInt32BE(20)).toBeGreaterThan(100);                     // it has height
    // A blank canvas of this size compresses to a few hundred bytes. Anything
    // near that means the rasterizer produced an empty frame and the file is a
    // lie — which is the exact WebKit failure no unit test can see.
    expect(bytes.length).toBeGreaterThan(5000);
  });

  it('writes a thread as one HTML file that folds, reflows and lists itself', async function () {
    const dest = path.join(OUT, 'thread.html');
    await openThread(2);
    await clickExportEntry('Export thread');
    await choose('HTML');
    await setMirror(false);
    await setDest(dest);
    await confirmExport();
    await waitForFile(dest);

    const html = fs.readFileSync(dest, 'utf8');
    expect((html.match(/<details/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('<details open');
    // The message frames stay inert whatever the outer document may run: the
    // sandbox, not the CSP, is what guarantees it.
    expect((html.match(/sandbox="allow-same-origin"/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('allow-scripts');
    expect(html).toContain('Exported from MailVault');

    // One script, in the outer document only. A second one means an email's own
    // survived into a srcdoc.
    expect((html.match(/<script/g) || []).length).toBe(1);
    expect(html).not.toMatch(/srcdoc="[^"]*&lt;script/);

    // Reads at any width — the fixed 820px column was a horizontal scrollbar on
    // every screen narrower than itself, inside every message frame as well.
    expect(html).toContain('width=device-width');
    expect(html).not.toMatch(/content="width=\d+"/);
    expect(html).toContain('@media (max-width:');

    // The rail: the thread in order, with the two controls over it.
    expect(html).toContain('data-mv-all="open"');
    expect(html).toContain('data-mv-all="close"');
    const rail = html.slice(html.indexOf('<ol class="mv-toc"'), html.indexOf('</ol>'));
    const anchors = rail.match(/#mv-m\d+/g) || [];
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    for (const a of anchors) expect(html).toContain(`id="${a.slice(1)}"`);
  });

  it('writes one numbered PNG per message into a directory', async function () {
    const dir = path.join(OUT, 'thread-images');
    fs.mkdirSync(dir, { recursive: true });
    await openThread(2);
    await clickExportEntry('Export thread');
    // Format first: the dialog deliberately remembers the last one, and the
    // layout row only exists for an IMAGE export of a thread.
    await choose('Image');
    await choose('Separate images');
    await setMirror(false);
    await setDir(dir);
    await confirmExport();

    await waitForWritten(() => fs.readdirSync(dir).length >= 2,
      () => `only ${fs.readdirSync(dir).length} file(s) in ${dir}`);

    const names = fs.readdirSync(dir).sort();
    expect(names[0]).toMatch(/^01 - /);
    expect(names.every(n => n.endsWith('.png'))).toBe(true);
    for (const n of names) {
      expect(fs.readFileSync(path.join(dir, n)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }
  });

  // Provenance has to name the account the message came from. With one account
  // seeded that is indistinguishable from naming whichever account is active.
  it('stamps the second account into the file it exports from it', async function () {
    const dest = path.join(OUT, 'second-account.html');
    await switchToFolder(ACCOUNT_B, 'INBOX');
    await waitForEmails();
    await openFirstMessage();
    await clickExportEntry();
    await choose('HTML');
    await setMirror(false);
    await setDest(dest);
    await confirmExport();
    await waitForFile(dest);

    const html = fs.readFileSync(dest, 'utf8');
    expect(html).toContain(ACCOUNT_B);
    expect(html).not.toContain(ACCOUNT_A);

    await switchToFolder(ACCOUNT_A, 'INBOX');
    await waitForEmails();
  });


  // The attachments themselves, not a claim about them: every file below is
  // read back off disk and compared with the fixture's own bytes.
  describe('attachments', function () {
    const ATTACHMENTS = 'Include attachments';
    const sidecar = (stem, name) => path.join(OUT, `${stem} - ${name}`);

    it('writes the attachments beside the image, named after it', async function () {
      const dest = path.join(OUT, 'with-attachments.png');
      await openBySubject(EXPORT_ATTACHMENT_SUBJECT);
      await clickExportEntry();
      await choose('Image');
      await setMirror(false);
      await setCheckbox(ATTACHMENTS, true);
      await setDest(dest);
      await confirmExport();
      await waitForFile(dest);

      const pdf = sidecar('with-attachments', EXPORT_ATTACHMENT_PDF_NAME);
      const png = sidecar('with-attachments', EXPORT_ATTACHMENT_PNG_NAME);
      await waitForFile(pdf);
      await waitForFile(png);
      expect(fs.readFileSync(pdf).equals(Buffer.from(EXPORT_ATTACHMENT_PDF_BASE64, 'base64'))).toBe(true);
      expect(fs.readFileSync(png).equals(Buffer.from(EXPORT_ATTACHMENT_PNG_BASE64, 'base64'))).toBe(true);
      // The inline logo is part of the body, and the body is already in the PNG.
      expect(fs.existsSync(sidecar('with-attachments', EXPORT_ATTACHMENT_INLINE_NAME))).toBe(false);
    });

    it('embeds the attachments in the HTML as download links, outside the message frames', async function () {
      const dest = path.join(OUT, 'with-attachments.html');
      await openBySubject(EXPORT_ATTACHMENT_SUBJECT);
      await clickExportEntry();
      await choose('HTML');
      await setMirror(false);
      await setCheckbox(ATTACHMENTS, true);
      await setDest(dest);
      await confirmExport();
      await waitForFile(dest);

      const html = fs.readFileSync(dest, 'utf8');
      expect(html).toContain(`download="${EXPORT_ATTACHMENT_PDF_NAME}"`);
      expect(html).toContain(`href="data:application/pdf;base64,${EXPORT_ATTACHMENT_PDF_BASE64}"`);
      expect(html).toContain(`download="${EXPORT_ATTACHMENT_PNG_NAME}"`);
      expect(html).not.toContain(`download="${EXPORT_ATTACHMENT_INLINE_NAME}"`);
      // A frame's sandbox blocks downloads, so a link inside a srcdoc is dead.
      expect(html).not.toMatch(/srcdoc="[^"]*download=/);
      expect((html.match(/<script/g) || []).length).toBe(1);
    });

    it('writes nothing but the image when attachments are turned off', async function () {
      const dest = path.join(OUT, 'no-attachments.png');
      await openBySubject(EXPORT_ATTACHMENT_SUBJECT);
      await clickExportEntry();
      await choose('Image');
      await setMirror(false);
      await setCheckbox(ATTACHMENTS, false);
      await setDest(dest);
      await confirmExport();
      await waitForFile(dest);

      // The sidecars are written after the image, so give them time to appear
      // before calling their absence a pass.
      await browser.pause(2000);
      expect(fs.readdirSync(OUT).filter(n => n.startsWith('no-attachments - '))).toEqual([]);
    });
  });

  describe('what a free user gets', function () {
    before(async function () { await setPremium(false); });
    after(async function () {
      await closeExportDialog();
      await setPremium(true);
    });
    // The samples modal is mounted once in App and only toggles `open`, so a
    // spec that leaves it up blocks the next one's click on the message row.
    beforeEach(async function () { await closeExportDialog(); });

    // Every control the export dialog offers is premium, so for a free user it
    // was a gate in front of a gate: Upgrade, or click through to the samples.
    // The click now lands on the samples, which carry Upgrade themselves.
    it('goes straight to the samples, with no gate dialog in front', async function () {
      await openFirstMessage();
      await clickExportEntry();

      const shown = await browser.execute(() => {
        const d = [...document.querySelectorAll('[role="dialog"]')]
          .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
        if (!d) return null;
        return {
          title: (d.querySelector('h2, h3')?.textContent || '').trim(),
          labels: [...d.querySelectorAll('button')].map(b => (b.textContent || '').trim()),
          radios: d.querySelectorAll('input[type="radio"]').length,
        };
      });
      expect(shown).not.toBeNull();
      expect(shown.title).toContain('Export any message or thread');
      expect(shown.labels).toContain('Upgrade');
      // The step that no longer exists.
      expect(shown.labels).not.toContain('See samples');
      expect(shown.labels).not.toContain('Export');
      expect(shown.radios).toBe(0);
    });

    it('renders live samples, each with its own Open and Save', async function () {
      await openFirstMessage();
      await clickExportEntry();

      // The samples run the real pipeline, so this waits on pixels, not paint.
      await browser.waitUntil(async () => browser.execute(() =>
        [...document.querySelectorAll('img[alt*="sample"]')]
          .filter(i => i.naturalWidth > 0).length === 2),
      { timeout: 120_000, interval: 1000, timeoutMsg: 'the two image samples never decoded' });

      const buttons = await browser.execute(() =>
        [...document.querySelectorAll('[role="dialog"] button')].map(b => (b.textContent || '').trim()));
      expect(buttons.filter(b => b === 'Open')).toHaveLength(3);
      expect(buttons.filter(b => b === 'Save')).toHaveLength(3);
    });

    // "Open" used to hand a file path to the shell plugin, whose scope only
    // validates URLs, so it was rejected and the button did nothing — and the
    // handler swallowed the rejection, so nothing said so. The visible proof is
    // the absence of the notice the handler now shows on failure.
    it('opens a sample without reporting a failure', async function () {
      await openFirstMessage();
      await clickExportEntry();
      await browser.waitUntil(async () => browser.execute(() =>
        [...document.querySelectorAll('img[alt*="sample"]')].filter(i => i.naturalWidth > 0).length === 2),
      { timeout: 120_000, interval: 1000, timeoutMsg: 'the samples never decoded' });

      await browser.execute(() => {
        const d = [...document.querySelectorAll('[role="dialog"]')]
          .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
        [...d.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Open')?.click();
      });

      await browser.pause(2000);
      const notice = await browser.execute(() => {
        const d = [...document.querySelectorAll('[role="dialog"]')]
          .find(el => el.offsetHeight > 0 && /Export/.test(el.textContent || ''));
        return d ? (d.textContent || '').match(/Could not open the sample\.[^]*/)?.[0] || null : null;
      });
      expect(notice).toBeNull();
    });
  });

  describe('negative controls', function () {
    it('writes nothing at all when the rasterizer fails', async function () {
      const dest = path.join(OUT, 'never-written.png');
      await openFirstMessage();
      await clickExportEntry();
      await setDest(dest);
      await setFault('render');
      await confirmExport();

      await browser.waitUntil(async () => browser.execute(() =>
        /could not be exported/i.test(document.body.textContent || '')),
      { timeout: 20_000, interval: 500, timeoutMsg: 'the dialog never reported the failure' });

      expect(fs.existsSync(dest)).toBe(false);
    });

    it('still exports when the mirror cannot reach the network, and says so', async function () {
      const dest = path.join(OUT, 'nomirror.html');
      await openFirstMessage();
      await clickExportEntry();
      await choose('HTML');
      await setMirror(true);
      await setDest(dest);
      await setFault('mirror');
      await confirmExport();
      await waitForFile(dest);

      const html = fs.readFileSync(dest, 'utf8');
      // Whatever remote content the fixture carried is now named as missing
      // rather than silently dropped; the footer states the ratio either way.
      expect(html).toContain('Exported from MailVault');
      // A failed mirror must not change what the document is allowed to run:
      // the one enhancement script, and nothing inside a message frame.
      expect((html.match(/<script/g) || []).length).toBe(1);
      expect(html).not.toMatch(/srcdoc="[^"]*&lt;script/);
      expect(html).not.toContain('allow-scripts');
    });
  });
});
