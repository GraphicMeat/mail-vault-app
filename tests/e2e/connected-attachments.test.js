/**
 * E2E Test: Attachments — download, in-app preview, automatic download.
 *
 * The fixture is yoda's uid 910 (mockImap `attachmentMessage`): a PNG and a
 * PDF on one message, newest in the suite so it heads All Inboxes.
 *
 * Opened from All Inboxes on purpose. That is where the 2026-09-04 report
 * came from: the row read its bytes from the VIEW's mailbox — `UNIFIED`,
 * which is not a Maildir folder — and said "Failed to download" for every
 * attachment of every server-only message. A single-account run would have
 * passed with that bug in place.
 *
 * Cases:
 *   1. Download from All Inboxes lands the file (no "Failed to download")
 *   2. The image previews inside the app and decodes
 *   3. The PDF previews in a frame
 *   4. The "open externally" button hands the file to the system app without
 *      opening the in-app preview
 *   5. With the setting on, switching to the account caches its attachments
 *      without a click — the row opens "Click to open"
 *   6. An image shows itself in the tile, a PDF does not borrow one
 *   7. Save As is on the row, with a label no other button in it shares
 *   8. Download All writes a folder under ~/Downloads holding both files
 *   9. Dragging a row cancels the browser drag and starts a native one on
 *      the real path (WebDriver cannot perform the OS drag itself)
 */

import { isAbsolute } from 'node:path';
import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { ATTACHMENT_SUBJECT, ATTACHMENT_PNG, ATTACHMENT_PDF } from './mockImap.js';

const activate = (id) => browser.execute((accountId) => {
  window.__MAIL_STORE__.getState().activateAccount(accountId, 'INBOX');
}, id);

const activeAccountId = () => browser.execute(() => window.__MAIL_STORE__.getState().activeAccountId);

const rowRendered = (needle) => browser.execute((s) => [...document.querySelectorAll('[data-testid="email-row"]')]
  .some((r) => (r.textContent || '').includes(s)), needle);

const clickRow = (needle) => browser.execute((s) => {
  const row = [...document.querySelectorAll('[data-testid="email-row"]')]
    .find((r) => (r.textContent || '').includes(s));
  if (!row || row.offsetHeight === 0) return false;
  row.click();
  return true;
}, needle);

/** The attachment row for `name`, as text, or null. */
const itemText = (name) => browser.execute((n) => {
  const item = [...document.querySelectorAll('[data-testid="attachment-item"]')]
    .find((el) => (el.textContent || '').includes(n));
  return item ? item.innerText : null;
}, name);

const clickInItem = (name, testid) => browser.execute((n, id) => {
  const item = [...document.querySelectorAll('[data-testid="attachment-item"]')]
    .find((el) => (el.textContent || '').includes(n));
  const btn = item?.querySelector(`[data-testid="${id}"]`);
  if (!btn) return false;
  btn.click();
  return true;
}, name, testid);

/**
 * Record every Tauri command and swallow `open_file`.
 *
 * The button under test really does hand the path to the OS, and a Preview
 * window launched on the runner steals focus from every spec after this one —
 * so the one command with a side effect outside the app is stubbed, and only
 * that one. Restored in `after`.
 */
const installInvokeProbe = () => browser.execute(() => {
  const tauri = window.__TAURI__;
  const core = tauri.core;
  if (core.invoke?.__mvProbe) return false;
  const real = core.invoke;
  window.__MV_INVOKES__ = [];
  const probe = (cmd, args) => {
    window.__MV_INVOKES__.push({ cmd, args });
    // The three commands that leave the app: a Preview window, a Finder
    // window and a live drag session all steal focus from every later spec.
    if (cmd === 'open_file' || cmd === 'show_in_folder' || cmd === 'plugin:drag|start_drag') {
      return Promise.resolve(null);
    }
    return real(cmd, args);
  };
  probe.__mvProbe = true;

  // Plain assignment is not enough: on this runtime `core.invoke` is a
  // non-writable property, so `core.invoke = probe` fails silently and every
  // assertion below would then be made against the REAL bridge — which would
  // launch Preview on the runner and steal focus from every later spec. So
  // three attempts, widest last, and the caller is told which reality it got.
  try { core.invoke = probe; } catch { /* non-writable */ }
  if (core.invoke !== probe) {
    try {
      Object.defineProperty(core, 'invoke', { value: probe, writable: true, configurable: true });
    } catch { /* non-configurable */ }
  }
  if (core.invoke !== probe) {
    // The app reads `window.__TAURI__.core` at call time, so swapping the
    // bridge object wholesale reaches it even when the property will not move.
    window.__TAURI__ = { ...tauri, core: { ...core, invoke: probe } };
  }
  window.__MV_PROBE_RESTORE__ = () => {
    try { core.invoke = real; } catch { /* see above */ }
    if (core.invoke !== real) {
      try {
        Object.defineProperty(core, 'invoke', { value: real, writable: true, configurable: true });
      } catch { /* non-configurable */ }
    }
    window.__TAURI__ = tauri;
    delete window.__MV_PROBE_RESTORE__;
  };
  return window.__TAURI__.core.invoke?.__mvProbe === true;
});

const removeInvokeProbe = () => browser.execute(() => {
  if (typeof window.__MV_PROBE_RESTORE__ !== 'function') return false;
  window.__MV_PROBE_RESTORE__();
  return window.__TAURI__.core.invoke?.__mvProbe !== true;
});

const invokedCommands = () => browser.execute(() => (window.__MV_INVOKES__ || []).map((c) => c.cmd));
const invokedWith = (cmd) => browser.execute((c) => (window.__MV_INVOKES__ || [])
  .filter((call) => call.cmd === c).map((call) => call.args), cmd);

const closePreview = () => browser.execute(() => {
  const dlg = document.querySelector('[data-testid="attachment-preview-dialog"]');
  const btn = dlg?.querySelector('button[aria-label="Close"]');
  if (!btn) return false;
  btn.click();
  return true;
});

async function openAttachmentMessage() {
  await browser.waitUntil(() => rowRendered(ATTACHMENT_SUBJECT), {
    timeout: 60_000, interval: 300,
    timeoutMsg: `"${ATTACHMENT_SUBJECT}" never rendered`,
  });
  expect(await clickRow(ATTACHMENT_SUBJECT)).toBe(true);
  await browser.waitUntil(
    () => browser.execute(() => document.querySelectorAll('[data-testid="attachment-item"]').length === 2),
    { timeout: 30_000, interval: 250, timeoutMsg: 'the two attachment rows never rendered' },
  );
}

describe('Connected Attachments', function () {
  this.timeout(180_000);

  let luke, yoda;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    luke = browser.mockAccounts[0];
    yoda = browser.mockAccounts[2];

    // The unified list is built from each account's header cache, so yoda's
    // mail reaches it only once yoda has been opened in this run.
    await activate(yoda.id);
    await browser.waitUntil(
      () => browser.execute((s) => (window.__MAIL_STORE__.getState().emails || [])
        .some((e) => (e.subject || '').includes(s)), ATTACHMENT_SUBJECT),
      { timeout: 60_000, interval: 500, timeoutMsg: `yoda's INBOX never loaded "${ATTACHMENT_SUBJECT}"` },
    );
    await activate(luke.id);
    await browser.waitUntil(async () => (await activeAccountId()) === luke.id, {
      timeout: 60_000, interval: 500, timeoutMsg: 'never came back to luke',
    });

    expect(await browser.execute(() => {
      const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
      if (!btn || btn.offsetHeight === 0) return false;
      btn.click();
      return true;
    })).toBe(true);
    await openAttachmentMessage();
  });

  it('downloads an attachment opened from All Inboxes', async function () {
    expect(await clickInItem(ATTACHMENT_PDF, 'attachment-download')).toBe(true);
    await browser.waitUntil(
      async () => /Downloaded|Click to open/.test((await itemText(ATTACHMENT_PDF)) || ''),
      { timeout: 20_000, interval: 250, timeoutMsg: `the PDF row never reported a download: ${await itemText(ATTACHMENT_PDF)}` },
    );
    expect(await itemText(ATTACHMENT_PDF)).not.toContain('Failed');
  });

  it('previews the image inside the app', async function () {
    expect(await clickInItem(ATTACHMENT_PNG, 'attachment-preview')).toBe(true);
    await browser.waitUntil(
      () => browser.execute(() => {
        const img = document.querySelector('[data-testid="attachment-preview-image"]');
        return !!img && img.complete && img.naturalWidth > 0;
      }),
      { timeout: 20_000, interval: 250, timeoutMsg: 'the image preview never decoded' },
    );
    const src = await browser.execute(() => document.querySelector('[data-testid="attachment-preview-image"]').getAttribute('src'));
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
    expect(await closePreview()).toBe(true);
  });

  it('previews the PDF in a frame', async function () {
    expect(await clickInItem(ATTACHMENT_PDF, 'attachment-preview')).toBe(true);
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector('[data-testid="attachment-preview-pdf"]')),
      { timeout: 20_000, interval: 250, timeoutMsg: 'the PDF frame never rendered' },
    );
    const src = await browser.execute(() => document.querySelector('[data-testid="attachment-preview-pdf"]').getAttribute('src'));
    expect(src.startsWith('blob:')).toBe(true);
    expect(await closePreview()).toBe(true);
  });

  // The PDF is already cached (test 1), so this exercises the button's cached
  // path and leaves the PNG untouched for the prefetch test below.
  it('hands the file to the system app without opening the in-app preview', async function () {
    expect(await installInvokeProbe()).toBe(true);
    try {
      // Not gated on a cached path: the PNG has never been downloaded here and
      // still offers the button, which is the whole point of adding it.
      expect(await browser.execute((n) => {
        const item = [...document.querySelectorAll('[data-testid="attachment-item"]')]
          .find((el) => (el.textContent || '').includes(n));
        return !!item?.querySelector('[data-testid="attachment-open-external"]');
      }, ATTACHMENT_PNG)).toBe(true);

      expect(await clickInItem(ATTACHMENT_PDF, 'attachment-open-external')).toBe(true);
      await browser.waitUntil(async () => (await invokedCommands()).includes('open_file'), {
        timeout: 20_000, interval: 250,
        timeoutMsg: `the button never reached open_file (saw ${JSON.stringify(await invokedCommands())})`,
      });
      const opened = await invokedWith('open_file');
      expect(opened).toHaveLength(1);
      expect(typeof opened[0].path).toBe('string');
      expect(opened[0].path.length).toBeGreaterThan(0);
      // The in-app dialog is exactly what this button skips.
      expect(await browser.execute(() =>
        document.querySelector('[data-testid="attachment-preview-dialog"]') === null)).toBe(true);
    } finally {
      expect(await removeInvokeProbe()).toBe(true);
    }
  });

  it('caches every attachment on its own once the setting is on', async function () {
    // The PNG was only previewed so far — never downloaded.
    expect(await itemText(ATTACHMENT_PNG)).not.toContain('Click to open');

    await openSettings();
    await clickSettingsNav('Behavior');
    expect(await browser.execute(() => {
      const el = document.querySelector('[data-testid="toggle-auto-download-attachments"]');
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })).toBe(true);
    await browser.waitUntil(
      () => browser.execute(() => window.__SETTINGS_STORE__.getState().autoDownloadAttachments === true),
      { timeout: 5_000, timeoutMsg: 'the toggle did not flip the setting' },
    );
    await closeSettings();

    // Switching to yoda runs its pipeline; its INBOX bodies are all cached by
    // now, so the after-bodies step — the newest-first attachment sweep — is
    // what the switch triggers.
    await activate(yoda.id);
    // `browser.execute` does not await a Promise; `executeAsync` does.
    await browser.waitUntil(
      () => browser.executeAsync((accountId, done) => {
        window.__TAURI__.core.invoke('daemon_rpc', { method: 'cached_attachment_path', params: {
          accountId, mailbox: 'INBOX', uid: 910, attachmentIndex: 0,
        } }).then((path) => done(typeof path === 'string' && path.endsWith('pixel.png')), () => done(false));
      }, yoda.id),
      { timeout: 60_000, interval: 500, timeoutMsg: 'the prefetch never cached the PNG' },
    );

    // Back in the viewer the row already offers to open, no click needed.
    await openAttachmentMessage();
    await browser.waitUntil(
      async () => ((await itemText(ATTACHMENT_PNG)) || '').includes('Click to open'),
      { timeout: 10_000, interval: 250, timeoutMsg: `the PNG row never showed the cached state: ${await itemText(ATTACHMENT_PNG)}` },
    );
  });

  // The tile used to be one FileText for every type. An image now IS its own
  // preview, decoded in the page — `naturalWidth` is the only proof of that
  // which a broken data: URI cannot fake.
  it('shows the image itself in the tile instead of a generic icon', async function () {
    await browser.waitUntil(
      () => browser.execute((n) => {
        const item = [...document.querySelectorAll('[data-testid="attachment-item"]')]
          .find((el) => (el.textContent || '').includes(n));
        const img = item?.querySelector('[data-testid="attachment-thumb"]');
        return !!img && img.complete && img.naturalWidth > 0;
      }, ATTACHMENT_PNG),
      { timeout: 30_000, interval: 250, timeoutMsg: 'the PNG row never rendered its own thumbnail' },
    );

    // The PDF has no thumbnail and must not borrow the image's.
    expect(await browser.execute((n) => {
      const item = [...document.querySelectorAll('[data-testid="attachment-item"]')]
        .find((el) => (el.textContent || '').includes(n));
      return !!item && !item.querySelector('[data-testid="attachment-thumb"]');
    }, ATTACHMENT_PDF)).toBe(true);
  });

  it('offers Save As on the row without a right-click', async function () {
    expect(await browser.execute((n) => {
      const item = [...document.querySelectorAll('[data-testid="attachment-item"]')]
        .find((el) => (el.textContent || '').includes(n));
      const btn = item?.querySelector('[data-testid="attachment-save-as"]');
      // Four icon buttons in one row: each must still say a different thing,
      // or a later spec clicking by label gets whichever comes first.
      const labels = [...item.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
      return !!btn && new Set(labels).size === labels.length;
    }, ATTACHMENT_PDF)).toBe(true);
  });

  // The reported gap: "Download All" wrote into the app's own attachment
  // cache, so the files were downloaded nowhere the user could reach. This
  // asserts against the real filesystem — the folder and both names are read
  // back off disk after the button runs.
  it('exports every attachment into one new folder under Downloads', async function () {
    expect(await installInvokeProbe()).toBe(true);
    let exported = null;
    try {
      expect(await browser.execute(() => {
        const btn = document.querySelector('[data-testid="attachment-download-all"]');
        if (!btn || btn.offsetHeight === 0) return false;
        btn.click();
        return true;
      })).toBe(true);

      // Finder is stubbed above, so its argument is the only place the
      // exported folder's real path surfaces.
      await browser.waitUntil(async () => (await invokedCommands()).includes('show_in_folder'), {
        timeout: 60_000, interval: 250,
        timeoutMsg: `the export never reached show_in_folder (saw ${JSON.stringify(await invokedCommands())})`,
      });
      exported = (await invokedWith('show_in_folder'))[0].path;
      expect(exported).toMatch(/[\\/]Downloads[\\/]/);
      expect(exported).toContain(ATTACHMENT_SUBJECT);
      expect(exported).toContain('Attachments');

      // Not the app's private cache — that is the defect this replaced.
      expect(exported).not.toContain('attachment_cache');
      // The daemon wrote them, not the app's sandbox fallback: seeing
      // save_attachment_to here would mean the daemon route failed and the
      // per-file retry quietly covered for it.
      expect(await invokedCommands()).not.toContain('save_attachment_to');

      const names = await browser.executeAsync((dir, done) => {
        window.__TAURI__.core.invoke('plugin:fs|read_dir', { path: dir, options: {} })
          .then((entries) => done(entries.map((e) => e.name).sort()), (e) => done(String(e)));
      }, exported);
      expect(names).toEqual([ATTACHMENT_PDF, ATTACHMENT_PNG].sort());
    } finally {
      if (exported) {
        await browser.executeAsync((dir, done) => {
          window.__TAURI__.core.invoke('plugin:fs|remove', { path: dir, options: { recursive: true } })
            .then(() => done(true), () => done(false));
        }, exported);
      }
      expect(await removeInvokeProbe()).toBe(true);
    }
  });

  // WebDriver cannot perform a real OS drag session, so this proves the seam
  // the app owns: the browser drag is cancelled and a native drag is started
  // on a real path, never on a blob or a data: URI.
  it('starts a native drag on the file, not a webloc', async function () {
    expect(await installInvokeProbe()).toBe(true);
    try {
      expect(await browser.execute((n) => {
        const item = [...document.querySelectorAll('[data-testid="attachment-item"]')]
          .find((el) => (el.textContent || '').includes(n));
        return item?.getAttribute('draggable') === 'true';
      }, ATTACHMENT_PDF)).toBe(true);

      expect(await browser.execute((n) => {
        const item = [...document.querySelectorAll('[data-testid="attachment-item"]')]
          .find((el) => (el.textContent || '').includes(n));
        const event = new Event('dragstart', { bubbles: true, cancelable: true });
        item.dispatchEvent(event);
        // WebKit's own drag hands the Desktop a .webloc; cancelling it is
        // the precondition for the native session replacing it.
        return event.defaultPrevented;
      }, ATTACHMENT_PDF)).toBe(true);

      await browser.waitUntil(async () => (await invokedCommands()).includes('plugin:drag|start_drag'), {
        timeout: 30_000, interval: 250,
        timeoutMsg: `dragstart never reached start_drag (saw ${JSON.stringify(await invokedCommands())})`,
      });
      const [args] = await invokedWith('plugin:drag|start_drag');
      expect(args.item).toHaveLength(1);
      expect(isAbsolute(args.item[0])).toBe(true);
      expect(args.item[0].endsWith(ATTACHMENT_PDF)).toBe(true);
      expect(args.image.startsWith('data:image/png;base64,')).toBe(true);
    } finally {
      expect(await removeInvokeProbe()).toBe(true);
    }
  });
});
