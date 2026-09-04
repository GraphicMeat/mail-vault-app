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
 *   4. With the setting on, switching to the account caches its attachments
 *      without a click — the row opens "Click to open"
 */

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
        window.__TAURI__.core.invoke('cached_attachment_path', {
          accountId, mailbox: 'INBOX', uid: 910, attachmentIndex: 0,
        }).then((path) => done(typeof path === 'string' && path.endsWith('pixel.png')), () => done(false));
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
});
