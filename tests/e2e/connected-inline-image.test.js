/**
 * E2E: an Outlook-pasted inline image keeps its shape, and offers Open/Save.
 *
 * Outlook (and Power BI pasted through it) sizes an embedded picture in inches
 * in an inline style, beside pixel attributes:
 *
 *   <img width="1234" height="567" style='width:12.85in;height:5.9in'
 *        id="Picture_x0020_1" src="cid:image001.png@...">
 *
 * The frame's `img { max-width:100% }` clamps the width, but the inline height
 * outranks the sheet's `height:auto`, so the picture was squashed sideways.
 * `keepImageProportions` (utils/emailIframeTemplate.js) rewrites it to
 * `height:auto` plus the sender's aspect ratio. The reading pane's context menu
 * (EmailViewer handleContextMenu, `#mv-ctx-menu` inside the frame) offers
 * "Open in Preview" and "Save As..." on an inline image; Save As writes the
 * image's own bytes through exportSaver's `saveOneFile`.
 *
 * Unit tests cover the rewrite and the menu builders against jsdom, which does
 * no layout and resolves no cid: part. Only this run proves, in the real
 * webview with the real daemon's inline-part hydration, that:
 *   a. the rendered image keeps its natural proportions while really clamped;
 *   b. right-clicking it lists Open in Preview and Save As;
 *   c. Save As writes exactly the PNG part's bytes.
 * The double-click open is NOT exercised: it launches Preview on the runner.
 *
 * Family: connected-*. The message is APPENDed to yoda's INBOX on the mock
 * IMAP server (dated 2020, purged in `after`, so no count another spec reads
 * changes), the inline bytes come back through the daemon, and Save As needs
 * the VITE_E2E `__MV_EXPORT_DEST__` seam. CI's ui-headless build has none of
 * these.
 *
 * Every value an assertion reads is logged as one `[inlineimg]` JSON line: the
 * job clone is deleted after the run, so stdout is the only evidence kept.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda

const SUBJECT = 'Inline image fixture Outlook chart';
const MSGID = 'inline-image-outlook-fixture';
const BODY_MARKER = 'mv-inlimg-body';
const IMG_ID = 'Picture_x0020_1';
const CID = 'image001.png@01DA1E2F.3C4D5E60';
const NATURAL = { width: 1234, height: 567 };
const STYLE_WIDTH_PX = 12.85 * 96; // 1233.6: the width the sender's style asks for

const en = JSON.parse(readFileSync(new URL('../../src/i18n/locales/en.json', import.meta.url), 'utf8'));
const OPEN_LABEL = en['viewer.openImageInPreview'] || 'Open in Preview';
const SAVE_LABEL = en['email.attachments.save'] || 'Save As...';

const log = (tag, value) => console.log(`[inlineimg] ${tag} ${JSON.stringify(value)}`);

// ── A real 1234x567 PNG, built here so its bytes are known exactly ──────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function makePng({ width, height }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const o = y * stride + 1 + x * 3;
      // Bars of a chart: the left half blue, the right half orange, a dark band.
      const band = y > height * 0.45 && y < height * 0.55;
      raw[o] = band ? 30 : (x < width / 2 ? 40 : 240);
      raw[o + 1] = band ? 30 : (x < width / 2 ? 110 : 140);
      raw[o + 2] = band ? 30 : (x < width / 2 ? 220 : 30);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = makePng(NATURAL);

/** Outlook's shape: related[ alternative[ plain, html ], inline png ]. */
function outlookMail() {
  const related = 'MvInlineRelated';
  const alt = 'MvInlineAlternative';
  const html = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>'
    + '<body lang="EN-US"><div class="WordSection1">'
    + `<p class="MsoNormal" id="${BODY_MARKER}">Here is the weekly chart.</p>`
    + `<p class="MsoNormal"><img width="1234" height="567" style='width:12.85in;height:5.9in' id="${IMG_ID}" src="cid:${CID}"></p>`
    + '</div></body></html>';
  return Buffer.from([
    'From: Reports <reports@outlook-fixture.test>',
    `To: ${YODA}`,
    `Subject: ${SUBJECT}`,
    'Date: Sat, 04 Jan 2020 12:00:00 +0000',
    `Message-ID: <${MSGID}@mock.test>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${related}"; type="multipart/alternative"`,
    '',
    `--${related}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Here is the weekly chart.',
    '',
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    '',
    `--${alt}--`,
    '',
    `--${related}`,
    'Content-Type: image/png; name="image001.png"',
    'Content-Description: image001.png',
    'Content-Disposition: inline; filename="image001.png"',
    `Content-ID: <${CID}>`,
    'Content-Transfer-Encoding: base64',
    '',
    ...PNG.toString('base64').match(/.{1,76}/g),
    '',
    `--${related}--`,
    '',
  ].join('\r\n'));
}

async function inInbox(fn) {
  const { host, port } = browser.mockImap[YODA_SERVER];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout();
  }
}

async function openRow(subject) {
  await browser.waitUntil(() => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
    row?.click();
    return !!row;
  }, subject), { timeout: 60_000, interval: 500, timeoutMsg: `no row for "${subject}" in ${YODA}'s INBOX` });
}

/**
 * The image as the reading pane's frame draws it. The frame and image are
 * found afresh on every call: a late cid: hydration can replace the document.
 */
const readImage = () => browser.execute((marker, imgId) => {
  const frame = [...document.querySelectorAll('iframe')].find((f) => {
    try { return !!f.contentDocument?.getElementById(marker); } catch { return false; }
  });
  const doc = frame?.contentDocument;
  if (!doc) return { frame: false };
  const img = doc.getElementById(imgId) || doc.querySelector('img[src^="data:image"]');
  if (!img) return { frame: true, img: false };
  const rect = img.getBoundingClientRect();
  const cs = doc.defaultView.getComputedStyle(img);
  return {
    frame: true,
    img: true,
    byId: img.id === imgId,
    srcHead: (img.getAttribute('src') || '').slice(0, 24),
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
    styleAttr: img.getAttribute('style'),
    computed: { width: cs.width, height: cs.height, maxWidth: cs.maxWidth, aspectRatio: cs.aspectRatio },
    frameWidth: doc.documentElement.clientWidth,
    iframeWidth: Math.round(frame.getBoundingClientRect().width),
  };
}, BODY_MARKER, IMG_ID);

/**
 * Right-click the image the way the webview delivers one: a contextmenu event
 * from the frame's own realm at the image's centre. Returns the menu's labels,
 * or null when no menu appeared.
 */
const rightClickImage = () => browser.execute((marker, imgId) => {
  const frame = [...document.querySelectorAll('iframe')].find((f) => {
    try { return !!f.contentDocument?.getElementById(marker); } catch { return false; }
  });
  const doc = frame?.contentDocument;
  const img = doc && (doc.getElementById(imgId) || doc.querySelector('img[src^="data:image"]'));
  if (!img) return { error: 'no image' };
  doc.getElementById('mv-ctx-menu')?.remove();
  const r = img.getBoundingClientRect();
  // The handler is the app window's function: an exception in it is reported
  // there, not to the caller of dispatchEvent. Catch it so a missing menu
  // names its cause.
  const errors = [];
  const onError = (ev) => errors.push(`${ev.message || ev.error} @ ${String(ev.error?.stack || '').split('\n').slice(0, 2).join(' | ')}`);
  window.addEventListener('error', onError);
  doc.defaultView.addEventListener('error', onError);
  try {
    img.dispatchEvent(new doc.defaultView.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + Math.min(r.height / 2, 40)),
    }));
  } finally {
    window.removeEventListener('error', onError);
    doc.defaultView.removeEventListener('error', onError);
  }
  const menu = doc.getElementById('mv-ctx-menu');
  return { menu: !!menu, labels: menu ? [...menu.children].map((c) => (c.textContent || '').trim()) : [], errors };
}, BODY_MARKER, IMG_ID);

const closeMenu = () => browser.execute((marker) => {
  const frame = [...document.querySelectorAll('iframe')].find((f) => {
    try { return !!f.contentDocument?.getElementById(marker); } catch { return false; }
  });
  frame?.contentDocument?.getElementById('mv-ctx-menu')?.remove();
}, BODY_MARKER);

describe('An Outlook-pasted inline image keeps its shape and opens or saves', function () {
  this.timeout(300_000);

  let outDir = null;
  let ready = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    outDir = mkdtempSync(join(tmpdir(), 'mv-inlimg-'));

    await inInbox(async (client) => {
      await client.append('INBOX', outlookMail(), ['\\Seen'], new Date('2020-01-04T12:00:00Z'));
    });
    await switchToFolder(YODA, 'INBOX');
    await openRow(SUBJECT);

    // The cid: part arrives as a data: URI once the daemon hydrates it; wait
    // for the decoded picture, not just the frame.
    try {
      await browser.waitUntil(async () => {
        ready = await readImage();
        return !!ready?.img && ready.srcHead.startsWith('data:image/png') && ready.complete && ready.naturalWidth > 0;
      }, { timeout: 60_000, interval: 500, timeoutMsg: 'the inline image never decoded in the reading pane' });
    } finally {
      log('ready', { ready, png: { bytes: PNG.length, ...NATURAL } });
    }
  });

  after(async function () {
    try {
      await browser.execute(() => { delete window.__MV_EXPORT_DEST__; });
      await closeMenu();
    } catch { /* app already gone */ }
    try {
      await inInbox(async (client) => {
        const uids = await client.search({ header: { 'message-id': `<${MSGID}@mock.test>` } }, { uid: true });
        if (uids.length) await client.messageDelete(uids, { uid: true });
      });
    } catch (e) {
      console.warn('[inlineimg] could not purge the fixture:', e.message);
    }
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('draws the image at its natural proportions while the frame narrows it', async function () {
    const img = await readImage();
    const natural = img.naturalWidth / img.naturalHeight;
    const rendered = img.width / img.height;
    log('proportions', { img, natural, rendered, drift: Math.abs(rendered / natural - 1), styleWidthPx: STYLE_WIDTH_PX });

    // Fixture sanity: the decoded picture is the PNG this spec built.
    expect(img.naturalWidth).toBe(NATURAL.width);
    expect(img.naturalHeight).toBe(NATURAL.height);
    // Really clamped: narrower than the 12.85in the style asks for, so the
    // ratio below is the rewrite's doing, not an unclamped image's.
    expect(img.width).toBeGreaterThan(0);
    expect(img.width).toBeLessThan(STYLE_WIDTH_PX);
    expect(Math.abs(rendered / natural - 1)).toBeLessThan(0.02);
  });

  it('offers Open in Preview and Save As on a right-click of the image', async function () {
    const menu = await rightClickImage();
    log('menu', { menu, want: [OPEN_LABEL, SAVE_LABEL] });
    await closeMenu();
    expect(menu.errors).toEqual([]);
    expect(menu.menu).toBe(true);
    expect(menu.labels).toContain(OPEN_LABEL);
    expect(menu.labels).toContain(SAVE_LABEL);
  });

  it('Save As writes exactly the PNG part\'s bytes', async function () {
    const dest = join(outDir, 'saved-inline.png');
    await browser.execute((p) => { window.__MV_EXPORT_DEST__ = p; }, dest);

    // Click only the item whose text IS the Save As label: Open in Preview
    // sits right above it and would launch Preview on the runner.
    const clicked = await browser.execute((marker, imgId, saveLabel) => {
      const frame = [...document.querySelectorAll('iframe')].find((f) => {
        try { return !!f.contentDocument?.getElementById(marker); } catch { return false; }
      });
      const doc = frame?.contentDocument;
      const img = doc && (doc.getElementById(imgId) || doc.querySelector('img[src^="data:image"]'));
      if (!img) return { clicked: false, why: 'no image' };
      doc.getElementById('mv-ctx-menu')?.remove();
      const r = img.getBoundingClientRect();
      img.dispatchEvent(new doc.defaultView.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + Math.min(r.height / 2, 40)),
      }));
      const menu = doc.getElementById('mv-ctx-menu');
      const items = menu ? [...menu.children] : [];
      const save = items.find((c) => (c.textContent || '').trim() === saveLabel);
      if (!save) return { clicked: false, why: 'no Save As item', labels: items.map((c) => (c.textContent || '').trim()) };
      save.click();
      return { clicked: true };
    }, BODY_MARKER, IMG_ID, SAVE_LABEL);
    log('save click', { clicked, dest });
    expect(clicked.clicked).toBe(true);

    let written = null;
    try {
      await browser.waitUntil(() => {
        written = existsSync(dest) ? statSync(dest).size : null;
        return written === PNG.length;
      }, { timeout: 15_000, interval: 250, timeoutMsg: `Save As never wrote ${PNG.length} bytes to ${dest}` });
    } finally {
      const storeError = await browser.execute(() => window.__MAIL_STORE__?.getState?.().error ?? null).catch(() => 'unreadable');
      log('save result', { dest, written, expected: PNG.length, storeError });
    }
    const bytes = readFileSync(dest);
    expect(bytes.equals(PNG)).toBe(true);
  });
});
