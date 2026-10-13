/**
 * E2E: the Blitz reader (Settings > Appearance > Rust email renderer) on the
 * real app, the real daemon and a real webview.
 *
 * What only this run can prove, none of it reachable from jsdom or cargo:
 *   a. the setting is off by default and the iframe draws the body;
 *   b. the real Settings toggle swaps the iframe for the daemon's tiles: the
 *      reader holds NO iframe, and every tile <img> comes through the shell's
 *      `mvrender` scheme (macOS `mvrender://`, Windows `http://mvrender.localhost`,
 *      so the CSP `img-src`) and decodes at the size the worker reported;
 *   c. the tiles are painted, not blank: the worker's PNG, read back through the
 *      same RPC the shell serves tiles from and decoded by the webview, holds
 *      the fixture's table, block links and the inline `data:` PNG;
 *   d. a body Blitz refuses (a node bomb) shows the failure notice, the plain
 *      text and the bubble, never an iframe, and the bubble's switch flips the
 *      setting and the iframe draws it;
 *   e. a click on a block link goes through activateEmailLink: a mailto: link
 *      opens the in-app compose window prefilled from it, the spoofed link
 *      raises the link-safety dialog, and a click on empty document does
 *      neither. The plain https link is hit-tested (RPC and chip) but NOT
 *      clicked: its outcome is the shell plugin opening the OS browser, which
 *      this harness cannot intercept (window.__TAURI_INTERNALS__.invoke is
 *      not writable and IPC does not go through a page-realm fetch here), and
 *      clicking would launch a browser on the runner.
 *
 * Fixtures: two own-authored messages APPENDed to yoda's INBOX in `before`
 * (dated 2020, purged in `after`), following connected-inline-image. Nothing is
 * added to the mock seed, so no count another spec reads changes. They are
 * single messages, never a conversation: this is the reader, not ThreadView.
 *
 * Harness limits worked around, each on purpose:
 *   - tauri-wd cannot pass element references back into scripts, so every wait
 *     is `waitUntil` + `execute` on plain selectors.
 *   - tauri-wd's pointer actions are page-dispatched MouseEvents and WebKit
 *     never enters :hover, so hover and click are dispatched here the same
 *     way. React's delegated listeners see them; what is proven is the
 *     handler, the hit RPC and the chip, not a physical pointer.
 *   - A tile <img> is cross-origin (`mvrender`), so a canvas drawn from it is
 *     tainted and `fetch` is outside `connect-src`. Pixels are read from the
 *     same `render.tile` RPC the shell serves, decoded by the webview with
 *     createImageBitmap. That proves what the worker painted and that the
 *     webview decodes the image at the size it was given; it is not a
 *     screenshot of the screen.
 *
 * Every value an assertion reads is logged as one `[blitz-e2e]` JSON line: the
 * job clone is deleted after the run, so stdout is the only evidence kept.
 */

import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD } from './mockImap.js';
import {
  waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav,
} from './helpers.js';
import { modalOpen, modalCount, fieldValue, closeComposeHard } from './composeHelpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda

const READER_SUBJECT = 'Blitz e2e reader';
const READER_MSGID = 'blitz-e2e-reader-fixture@mock.test';
const READER_PLAIN = 'Plain text of the Blitz e2e reader fixture.';
const BIG_SUBJECT = 'Blitz e2e too large';
const BIG_MSGID = 'blitz-e2e-too-large-fixture@mock.test';
const BIG_PLAIN = 'Plain text of the Blitz e2e too large fixture.';

const SAFE_HREF = 'https://example.com/blitz-e2e';
const SPOOF_HREF = 'https://evil.test/login';
const SPOOF_TEXT = 'https://bank.test/login';
const MAILTO_TO = 'partners@mock.test';
const MAILTO_SUBJECT = 'Blitz e2e mailto';
const MAILTO_HREF = `mailto:${MAILTO_TO}?subject=${encodeURIComponent(MAILTO_SUBJECT)}`;

// Flat zero-size elements, never nested: over MAX_NODES (150000) in the worker
// (render_too_complex), ~1.1 MB so it crosses the pipeline like BIG_BODY does,
// and it lays out to nothing when the standard iframe draws it afterwards.
const BOMB_NODES = 160_000;

const en = JSON.parse(readFileSync(new URL('../../src/i18n/locales/en.json', import.meta.url), 'utf8'));
const IFRAME_TITLE = en['viewer.emailContent'] || 'Email content';

const log = (tag, value) => console.log(`[blitz-e2e] ${tag} ${JSON.stringify(value)}`);

// ── A solid-colour PNG, built here so its colour is known exactly ───────────

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
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = y * stride + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Colours the fixture paints, and the same as the tile scan looks for.
const BLUE = [31, 79, 216];     // table header cell
const YELLOW = [255, 204, 0];   // safe block link
const CYAN = [0, 208, 224];     // spoofed block link
const PURPLE = [136, 0, 204];   // mailto: block link
const MAGENTA = [255, 0, 255];  // inline data: PNG
const PNG_SIDE = 48;            // CSS px the inline PNG is drawn at

const readerHtml = () => `<h1 id="blitz-e2e-heading" style="margin:0;padding:12px 16px;font-size:24px;color:#202020">Blitz e2e heading</h1>
<table width="600" cellpadding="0" cellspacing="0" style="width:600px;border-collapse:collapse">
<tr><td width="200" style="width:200px;background:rgb(${BLUE.join(',')});color:#ffffff;height:60px;padding:0 16px">Table header cell</td><td style="background:#e8e8e8;height:60px;padding:0 16px">Second column</td></tr>
<tr><td style="background:#ffffff;height:60px;padding:0 16px">Row two</td><td style="background:#f4f4f4;height:60px;padding:0 16px">Row two, column two</td></tr>
<tr><td style="background:#ffffff;height:60px;padding:0 16px">Row three</td><td style="background:#e8e8e8;height:60px;padding:0 16px">Row three, column two</td></tr>
</table>
<div style="position:relative;height:180px;width:600px">
<a href="${SAFE_HREF}" style="position:absolute;top:0;left:0;display:block;height:40px;width:200px;line-height:40px;background:rgb(${YELLOW.join(',')});color:#000000;text-decoration:none">Open the report</a>
<a href="${SPOOF_HREF}" style="position:absolute;top:60px;left:0;display:block;height:40px;width:200px;line-height:40px;background:rgb(${CYAN.join(',')});color:#000000;text-decoration:none">${SPOOF_TEXT}</a>
<a href="${MAILTO_HREF}" style="position:absolute;top:120px;left:0;display:block;height:40px;width:200px;line-height:40px;background:rgb(${PURPLE.join(',')});color:#ffffff;text-decoration:none">Write to partners</a>
</div>
<div style="height:260px;background:#f2f2f2"></div>
<img id="blitz-e2e-png" alt="" width="${PNG_SIDE}" height="${PNG_SIDE}" style="display:block;margin:16px" src="data:image/png;base64,${solidPng(8, 8, MAGENTA).toString('base64')}">
<div style="height:40px"></div>`;

const bombHtml = () => `<p>Blitz too large e2e heading</p>${'<b></b>'.repeat(BOMB_NODES)}`;

const b64Lines = (text) => Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');

function fixtureMail({ subject, msgid, plain, html }) {
  const alt = 'MvBlitzAlternative';
  return Buffer.from([
    'From: Blitz Fixture <fixture@blitz.mock.test>',
    `To: ${YODA}`,
    `Subject: ${subject}`,
    'Date: Sat, 04 Jan 2020 12:00:00 +0000',
    `Message-ID: <${msgid}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(plain),
    '',
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(html),
    '',
    `--${alt}--`,
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

// ── What the page shows ─────────────────────────────────────────────────────

const rendererSetting = () => browser.execute(() => window.__SETTINGS_STORE__?.getState?.().emailRenderer ?? null);

/** The reader's iframe, if any: present, its title, and whether it holds `needle`. */
const readFrame = (needle) => browser.execute((title, wanted) => {
  const frames = [...document.querySelectorAll('iframe[sandbox]')].filter((f) => f.title === title);
  const frame = frames[0];
  let doc = null;
  try { doc = frame?.contentDocument ?? null; } catch { doc = null; }
  return {
    count: frames.length,
    height: frame ? Math.round(frame.getBoundingClientRect().height) : 0,
    hasNeedle: !!doc && !!wanted && (doc.body?.textContent || '').includes(wanted),
    hasHeading: !!doc?.getElementById('blitz-e2e-heading'),
  };
}, IFRAME_TITLE, needle);

const BODY = '[data-testid="blitz-email-body"]';

/** Everything about the Blitz body and its tiles that an assertion reads. */
const readBlitz = () => browser.execute((bodySel) => {
  const body = document.querySelector(bodySel);
  if (!body) return { body: false };
  const box = body.querySelector('[role="presentation"]');
  const tiles = [...body.querySelectorAll('[data-testid="blitz-tile"]')];
  return {
    body: true,
    bodyHeight: body.offsetHeight,
    dpr: window.devicePixelRatio,
    cssWidth: box ? parseFloat(box.style.width) : 0,
    cssHeight: box ? parseFloat(box.style.height) : 0,
    tiles: tiles.map((img) => ({
      src: img.getAttribute('src'),
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      cssWidth: parseFloat(img.style.width),
      cssHeight: parseFloat(img.style.height),
    })),
    chip: document.querySelector('[data-testid="blitz-link-chip"]')?.textContent ?? null,
    iframes: [...document.querySelectorAll('iframe')].length,
  };
}, BODY);

const tilesLoaded = (s) => s.body && s.tiles.length > 0 && s.tiles.every((t) => t.src && t.complete && t.naturalWidth > 0);

/** The toggle's aria-checked in the open Settings page, or null if it is not there. */
const toggleState = () => browser.execute(() => {
  const el = document.querySelector('[data-testid="setting-email-renderer"]');
  return el && el.offsetHeight > 0 ? el.getAttribute('aria-checked') : null;
});

const clickToggle = () => browser.execute(() => {
  const el = document.querySelector('[data-testid="setting-email-renderer"]');
  if (!el) return false;
  el.click();
  return true;
});

// ── Pixels, through the RPC the shell serves tiles from ─────────────────────

/** docId/rev/index of a tile <img>, from its mvrender URL on either OS. */
const tileIds = (src) => {
  const m = /(\d+)(?:%2F|\/)(\d+)(?:%2F|\/)(\d+)$/i.exec(src || '');
  return m ? { docId: Number(m[1]), rev: Number(m[2]), index: Number(m[3]) } : null;
};

/**
 * Ask the daemon for one tile, decode it in the webview and scan it for the
 * given colours (each +-tol per channel): pixel count and bounding box.
 */
const scanTile = (docId, index, colors, tol = 10) => browser.executeAsync(async (id, idx, cols, tolerance, done) => {
  try {
    const r = await window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'render.tile', params: { docId: id, index: idx } });
    const bin = atob(r.png);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const found = cols.map(() => ({ count: 0, minX: 1e9, minY: 1e9, maxX: -1, maxY: -1 }));
    const distinct = new Set();
    for (let y = 0; y < bmp.height; y += 1) {
      for (let x = 0; x < bmp.width; x += 1) {
        const o = (y * bmp.width + x) * 4;
        const r0 = px[o]; const g0 = px[o + 1]; const b0 = px[o + 2];
        if (distinct.size < 4000) distinct.add((r0 << 16) | (g0 << 8) | b0);
        for (let k = 0; k < cols.length; k += 1) {
          const c = cols[k];
          if (Math.abs(r0 - c[0]) <= tolerance && Math.abs(g0 - c[1]) <= tolerance && Math.abs(b0 - c[2]) <= tolerance) {
            const f = found[k];
            f.count += 1;
            if (x < f.minX) f.minX = x;
            if (x > f.maxX) f.maxX = x;
            if (y < f.minY) f.minY = y;
            if (y > f.maxY) f.maxY = y;
          }
        }
      }
    }
    done({ width: bmp.width, height: bmp.height, distinct: distinct.size, found, pngB64Length: r.png.length, png: r.png });
  } catch (e) {
    done({ error: String((e && e.message) || e) });
  }
}, docId, index, colors, tol);

// ── Pointer input, page-dispatched exactly as tauri-wd does it ──────────────

/** Dispatch a bubbling mouse event at document point (x, y) CSS px of the Blitz body. */
const mouseAt = (type, x, y) => browser.execute((bodySel, t, px, py) => {
  const box = document.querySelector(bodySel)?.querySelector('[role="presentation"]');
  if (!box) return false;
  const r = box.getBoundingClientRect();
  box.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: r.left + px, clientY: r.top + py }));
  return true;
}, BODY, type, x, y);

/** The hit-test RPC, called directly: what the worker says is at (x, y). */
const hitAt = (docId, x, y) => browser.executeAsync((id, px, py, done) => {
  window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'render.hit', params: { docId: id, x: px, y: py } })
    .then(done, (e) => done({ error: String((e && e.message) || e) }));
}, docId, x, y);

const chipText = () => browser.execute(() => document.querySelector('[data-testid="blitz-link-chip"]')?.textContent ?? null);

/** Record every render.* call and how it settled, through the VITE_E2E observer seam. */
const installRenderObserver = () => browser.execute(() => {
  window.__e2eRender = [];
  window.__INSIGHTS_NATIVE_OBSERVER__ = (cmd, promise) => {
    if (!String(cmd).startsWith('render.')) return undefined;
    const rec = { cmd, t0: Math.round(performance.now()) };
    window.__e2eRender.push(rec);
    promise.then(
      () => { rec.ok = true; rec.ms = Math.round(performance.now()) - rec.t0; },
      (e) => { rec.ok = false; rec.err = String((e && e.message) || e); rec.ms = Math.round(performance.now()) - rec.t0; },
    );
    return undefined;
  };
});
const renderCalls = () => browser.execute(() => window.__e2eRender || []);

const safetyDialog = () => browser.execute(() => {
  const d = [...document.querySelectorAll('[role="alertdialog"]')].find((el) => el.offsetHeight > 0);
  return d ? (d.innerText || '') : null;
});

const closeSafetyDialog = () => browser.execute(() => {
  const d = [...document.querySelectorAll('[role="alertdialog"]')].find((el) => el.offsetHeight > 0);
  const cancel = d && [...d.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent || '') || /cancel/i.test(b.getAttribute('aria-label') || ''));
  cancel?.click();
  return !!cancel;
});

const centre = (f, dpr, topCss = 0) => ({
  x: ((f.minX + f.maxX) / 2) / dpr,
  y: topCss + ((f.minY + f.maxY) / 2) / dpr,
});

describe('Blitz reader on the real app', function () {
  this.timeout(300_000);

  // Filled in by the pixel test, read by the pointer tests.
  let located = null;
  let docIds = null;
  let toggledAt = 0;

  before(async function () {
    await waitForApp();
    await waitForEmails();

    await inInbox(async (client) => {
      await client.append('INBOX', fixtureMail({ subject: READER_SUBJECT, msgid: READER_MSGID, plain: READER_PLAIN, html: readerHtml() }), ['\\Seen'], new Date('2020-01-04T12:00:00Z'));
      await client.append('INBOX', fixtureMail({ subject: BIG_SUBJECT, msgid: BIG_MSGID, plain: BIG_PLAIN, html: bombHtml() }), ['\\Seen'], new Date('2020-01-03T12:00:00Z'));
    });
    await switchToFolder(YODA, 'INBOX');
  });

  after(async function () {
    try { await browser.execute(() => { delete window.__INSIGHTS_NATIVE_OBSERVER__; }); } catch { /* app already gone */ }
    for (const msgid of [READER_MSGID, BIG_MSGID]) {
      for (const mailbox of ['INBOX', 'Trash']) {
        try {
          const { host, port } = browser.mockImap[YODA_SERVER];
          const client = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
          await client.connect();
          const lock = await client.getMailboxLock(mailbox);
          try {
            const uids = await client.search({ header: { 'message-id': `<${msgid}>` } }, { uid: true });
            if (uids.length) await client.messageDelete(uids, { uid: true });
          } finally {
            lock.release();
            await client.logout();
          }
        } catch (e) {
          console.warn(`[blitz-e2e] could not purge ${msgid} from ${mailbox}:`, e.message);
        }
      }
    }
  });

  it('is off by default: the iframe draws the body and no Blitz body exists', async function () {
    await openRow(READER_SUBJECT);
    let frame = null;
    await browser.waitUntil(async () => {
      frame = await readFrame('Blitz e2e heading');
      return frame.count === 1 && frame.hasHeading;
    }, { timeout: 60_000, interval: 500, timeoutMsg: 'the standard iframe never drew the fixture' });
    const setting = await rendererSetting();
    const blitz = await readBlitz();
    log('off by default', { setting, frame, blitzBody: blitz.body });
    expect(setting).toBe('web');
    expect(frame.count).toBe(1);
    expect(frame.height).toBeGreaterThan(0);
    expect(blitz.body).toBe(false);
  });

  it('turns on through the real Settings toggle and swaps the iframe for tiles', async function () {
    await installRenderObserver();
    await openSettings();
    expect(await clickSettingsNav('Appearance')).toBe(true);
    await browser.waitUntil(async () => (await toggleState()) !== null, {
      timeout: 10_000, interval: 250, timeoutMsg: 'the renderer toggle never appeared in Settings > Appearance',
    });
    expect(await toggleState()).toBe('false');
    expect(await clickToggle()).toBe(true);
    await browser.waitUntil(async () => (await toggleState()) === 'true', {
      timeout: 5_000, interval: 100, timeoutMsg: 'the renderer toggle did not read on after the click',
    });
    toggledAt = Date.now();
    expect(await rendererSetting()).toBe('blitz');
    await closeSettings();

    let state = null;
    await browser.waitUntil(async () => {
      state = await readBlitz();
      return tilesLoaded(state);
    }, { timeout: 30_000, interval: 250, timeoutMsg: 'no Blitz tile ever loaded in the reader' });
    const firstTileMs = Date.now() - toggledAt;
    const frame = await readFrame('');
    const calls = await renderCalls();
    log('blitz on', { firstTileMs, state, frame, calls });

    // No iframe in the reader, and a positive control for that: the off test
    // saw exactly one with this title.
    expect(frame.count).toBe(0);
    expect(state.iframes).toBe(0);
    expect(state.tiles.length).toBeGreaterThanOrEqual(2);
    expect(state.cssWidth).toBeGreaterThan(0);
    expect(state.cssHeight).toBeGreaterThan(512);
    expect(state.tiles.length).toBe(Math.ceil(state.cssHeight / 512));

    // Each tile is a real, decoded image at the size the worker reported.
    state.tiles.forEach((t, i) => {
      expect(t.src).toMatch(/mvrender/);
      const wantW = Math.round(Math.ceil(state.cssWidth) * state.dpr);
      expect(Math.abs(t.naturalWidth - wantW)).toBeLessThanOrEqual(2);
      const wantH = Math.round(Math.min(512, state.cssHeight - i * 512) * state.dpr);
      expect(Math.abs(t.naturalHeight - wantH)).toBeLessThanOrEqual(2);
    });
    const open = calls.find((c) => c.cmd === 'render.open');
    expect(open && open.ok).toBe(true);
  });

  it('paints the tables, block links and the inline data: PNG into the tiles', async function () {
    const state = await readBlitz();
    const ids = state.tiles.map((t) => tileIds(t.src));
    expect(ids.every(Boolean)).toBe(true);
    docIds = ids;
    const dpr = state.dpr;

    // Tile 0: the heading band, the 600px table, both block links.
    let t0 = null;
    await browser.waitUntil(async () => {
      t0 = await scanTile(ids[0].docId, 0, [BLUE, YELLOW, CYAN, PURPLE]);
      return !t0.error && t0.found.every((f) => f.count > 0);
    }, { timeout: 30_000, interval: 500, timeoutMsg: `tile 0 never showed the fixture colours: ${JSON.stringify(t0 && { ...t0, png: undefined })}` });
    // Tile 1: the inline data: PNG, fed by the worker's own image decode, which
    // lands after the first paint and bumps the doc revision.
    let t1 = null;
    await browser.waitUntil(async () => {
      t1 = await scanTile(ids[1].docId, 1, [MAGENTA]);
      return !t1.error && t1.found[0].count > 0;
    }, { timeout: 30_000, interval: 500, timeoutMsg: `the inline data: PNG never reached tile 1: ${JSON.stringify(t1 && { ...t1, png: undefined })}` });
    const after = await readBlitz();

    const [blue, yellow, cyan, purple] = t0.found;
    const magenta = t1.found[0];
    log('pixels', {
      dpr, tile0: { w: t0.width, h: t0.height, distinct: t0.distinct, blue, yellow, cyan, purple },
      tile1: { w: t1.width, h: t1.height, distinct: t1.distinct, magenta },
      displayed: after.tiles.map((t) => ({ w: t.naturalWidth, h: t.naturalHeight })),
      // Observation, not an assertion: the fixture's table is 600px; if the pane is
      // narrower, a document wider than the pane is clipped at the tile edge.
      docCssWidth: after.cssWidth,
    });
    // The tile PNGs themselves, so the render can be looked at after the clone is gone.
    console.log(`[blitz-e2e] tilepng 0 ${t0.png}`);
    console.log(`[blitz-e2e] tilepng 1 ${t1.png}`);

    // Not blank: a painted page holds many colours; an unpainted tile holds one.
    expect(t0.distinct).toBeGreaterThan(8);
    // The RPC bytes are the displayed image's size, so what was scanned is what is shown.
    expect(t0.width).toBe(after.tiles[0].naturalWidth);
    expect(t0.height).toBe(after.tiles[0].naturalHeight);
    expect(t1.width).toBe(after.tiles[1].naturalWidth);
    expect(t1.height).toBe(after.tiles[1].naturalHeight);
    // The table header cell is the width the fixture asked for (200 CSS px).
    expect(Math.abs((blue.maxX - blue.minX + 1) - 200 * dpr)).toBeLessThanOrEqual(8 * dpr);
    expect(Math.abs((blue.maxY - blue.minY + 1) - 60 * dpr)).toBeLessThanOrEqual(8 * dpr);
    // Each block link is painted at its own size: 200 x 40 CSS px.
    for (const f of [yellow, cyan, purple]) {
      expect(Math.abs((f.maxX - f.minX + 1) - 200 * dpr)).toBeLessThanOrEqual(8 * dpr);
      expect(Math.abs((f.maxY - f.minY + 1) - 40 * dpr)).toBeLessThanOrEqual(8 * dpr);
    }
    // The spoofed link sits 60 CSS px below the safe one (absolute tops 0 and 60),
    // on the same left edge.
    expect(Math.abs((cyan.minY - yellow.minY) - 60 * dpr)).toBeLessThanOrEqual(4 * dpr);
    expect(Math.abs(cyan.minX - yellow.minX)).toBeLessThanOrEqual(2 * dpr);
    expect(Math.abs((purple.minY - cyan.minY) - 60 * dpr)).toBeLessThanOrEqual(4 * dpr);
    // The inline data: PNG is drawn at the size its width/height ask for.
    expect(Math.abs((magenta.maxX - magenta.minX + 1) - PNG_SIDE * dpr)).toBeLessThanOrEqual(2 * dpr);
    expect(Math.abs((magenta.maxY - magenta.minY + 1) - PNG_SIDE * dpr)).toBeLessThanOrEqual(2 * dpr);
    expect(magenta.count).toBeGreaterThan(0.8 * PNG_SIDE * dpr * PNG_SIDE * dpr);

    located = {
      dpr,
      blue: centre(blue, dpr),
      yellow: centre(yellow, dpr),
      cyan: centre(cyan, dpr),
      purple: centre(purple, dpr),
      nonLink: { x: 590, y: 4 }, // inside the heading band, far right of any text
    };
    log('located', located);
  });

  it('hit-tests block links: the worker finds them and the chip shows the target', async function () {
    expect(located).not.toBe(null);
    const { docId } = docIds[0];

    // The hit RPC itself: both links, and nothing at an empty point.
    const safe = await hitAt(docId, located.yellow.x, located.yellow.y);
    const spoof = await hitAt(docId, located.cyan.x, located.cyan.y);
    const mail = await hitAt(docId, located.purple.x, located.purple.y);
    const none = await hitAt(docId, located.nonLink.x, located.nonLink.y);
    log('render.hit', { safe, spoof, mail, none });
    expect(safe.link && safe.link.href).toBe(SAFE_HREF);
    expect(safe.link.alert ?? null).toBe(null);
    expect(spoof.link && spoof.link.href).toBe(SPOOF_HREF);
    expect(spoof.link.alert).toBeTruthy();
    expect(mail.link && mail.link.href).toBe(MAILTO_HREF);
    expect(none.link ?? null).toBe(null);

    // The chip, driven by a page-dispatched mousemove (see the header).
    expect(await chipText()).toBe(null);
    expect(await mouseAt('mousemove', located.yellow.x, located.yellow.y)).toBe(true);
    await browser.waitUntil(async () => (await chipText()) === SAFE_HREF, {
      timeout: 5_000, interval: 100, timeoutMsg: `the link chip never showed ${SAFE_HREF}; chip: ${await chipText()}`,
    });
    await browser.pause(300); // the handler drops overlapping moves while a hit is in flight
    expect(await mouseAt('mousemove', located.cyan.x, located.cyan.y)).toBe(true);
    await browser.waitUntil(async () => (await chipText()) === SPOOF_HREF, {
      timeout: 5_000, interval: 100, timeoutMsg: `the link chip never moved to ${SPOOF_HREF}; chip: ${await chipText()}`,
    });
    await browser.pause(300);
    expect(await mouseAt('mousemove', located.blue.x, located.blue.y)).toBe(true);
    await browser.waitUntil(async () => (await chipText()) === null, {
      timeout: 5_000, interval: 100, timeoutMsg: `the link chip stayed up over the table: ${await chipText()}`,
    });
  });

  it('a click goes through activateEmailLink: mailto composes, the spoofed link asks first', async function () {
    expect(located).not.toBe(null);
    await closeComposeHard();

    // A click on empty document does nothing. This is the control: the same
    // waits below see the other clicks' outcomes, so "nothing" here can fail.
    expect(await mouseAt('click', located.blue.x, located.blue.y)).toBe(true);
    await browser.pause(1500);
    expect(await modalOpen()).toBe(false);
    expect(await safetyDialog()).toBe(null);

    // mailto: composes in-app, prefilled from the link, never the OS mail client.
    expect(await mouseAt('click', located.purple.x, located.purple.y)).toBe(true);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000, interval: 200, timeoutMsg: 'a click on the mailto: block link opened no compose window',
    });
    const compose = { windows: await modalCount(), to: await fieldValue('compose-to'), subject: await fieldValue('compose-subject') };
    log('mailto click', compose);
    expect(compose.windows).toBe(1);
    expect(compose.to).toBe(MAILTO_TO);
    expect(compose.subject).toBe(MAILTO_SUBJECT);
    expect(await safetyDialog()).toBe(null);
    await closeComposeHard();

    // The spoofed link raises the link-safety dialog instead of opening.
    expect(await mouseAt('click', located.cyan.x, located.cyan.y)).toBe(true);
    let dialog = null;
    await browser.waitUntil(async () => {
      dialog = await safetyDialog();
      return !!dialog;
    }, { timeout: 10_000, interval: 200, timeoutMsg: 'a click on the spoofed block link never raised the link-safety dialog' });
    log('spoofed click', { dialog, composeOpen: await modalOpen() });
    expect(dialog).toContain(SPOOF_HREF);
    expect(dialog).toContain(SPOOF_TEXT);
    expect(await modalOpen()).toBe(false);
    await closeSafetyDialog();
  });

  it('a body Blitz refuses shows the notice, the plain text and the bubble, never an iframe', async function () {
    await openRow(BIG_SUBJECT);
    await browser.waitUntil(() => browser.execute(() => {
      const n = document.querySelector('[data-testid="blitz-failure-notice"]');
      return !!n && n.offsetHeight > 0;
    }), { timeout: 60_000, interval: 500, timeoutMsg: 'the failure notice never appeared for the refused body' });

    const view = await browser.execute((bodySel) => {
      const notice = document.querySelector('[data-testid="blitz-failure-notice"]');
      const bubble = document.querySelector('[data-testid="blitz-failure-bubble"]');
      const sw = document.querySelector('[data-testid="blitz-failure-switch"]');
      return {
        noticeText: notice?.textContent ?? null,
        panelText: notice?.parentElement?.textContent ?? '',
        bubbleHeight: bubble ? bubble.offsetHeight : 0,
        bubbleText: bubble?.textContent ?? '',
        switchHeight: sw ? sw.offsetHeight : 0,
        tiles: document.querySelectorAll('[data-testid="blitz-tile"]').length,
        blitzBody: !!document.querySelector(bodySel),
        iframes: document.querySelectorAll('iframe').length,
      };
    }, BODY);
    const calls = await renderCalls();
    const lastOpen = [...calls].reverse().find((c) => c.cmd === 'render.open');
    log('failure view', { view, lastOpen });

    // The refusal came from the worker, not from a dead worker: a crashed or
    // timed-out one would read render_unavailable and prove nothing about the limit.
    expect(lastOpen && lastOpen.ok).toBe(false);
    expect(lastOpen.err).toMatch(/render_too_complex|render_too_large/);
    expect(view.noticeText).toBe(en['blitz.failed.notice']);
    expect(view.panelText).toContain(BIG_PLAIN);
    expect(view.bubbleHeight).toBeGreaterThan(0);
    expect(view.bubbleText).toContain(en['blitz.failed.title']);
    expect(view.switchHeight).toBeGreaterThan(0);
    expect(view.tiles).toBe(0);
    expect(view.blitzBody).toBe(false);
    expect(view.iframes).toBe(0);
    expect((await readFrame('')).count).toBe(0);
  });

  it('the bubble\'s switch flips the setting and the iframe draws the message', async function () {
    expect(await rendererSetting()).toBe('blitz');
    const clicked = await browser.execute(() => {
      const sw = document.querySelector('[data-testid="blitz-failure-switch"]');
      if (!sw) return false;
      sw.click();
      return true;
    });
    expect(clicked).toBe(true);
    let frame = null;
    await browser.waitUntil(async () => {
      frame = await readFrame('Blitz too large e2e heading');
      return frame.count === 1 && frame.hasNeedle;
    }, { timeout: 60_000, interval: 500, timeoutMsg: `the standard iframe never drew the message after the switch: ${JSON.stringify(frame)}` });
    const setting = await rendererSetting();
    const blitz = await readBlitz();
    log('after switch', { setting, frame, blitzBody: blitz.body });
    expect(setting).toBe('web');
    expect(blitz.body).toBe(false);

    // The Settings row reads the same setting.
    await openSettings();
    expect(await clickSettingsNav('Appearance')).toBe(true);
    await browser.waitUntil(async () => (await toggleState()) !== null, {
      timeout: 10_000, interval: 250, timeoutMsg: 'the renderer toggle never appeared in Settings > Appearance',
    });
    expect(await toggleState()).toBe('false');
    await closeSettings();
  });
});
