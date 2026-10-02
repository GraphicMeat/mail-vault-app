/**
 * E2E: a social image of a spam message names its sender, shows the sender
 * check and lists the links, in the real webview.
 *
 * Unit tests mock the rasterizer, and jsdom lays nothing out. Only WKWebView
 * (or WebView2) shows that the header boxes render and stack under the header,
 * that the app window's real sender-details popover is open, unclipped and
 * not painted over by the message frame in the shot, and that the sender stays
 * readable while the recipient is masked.
 *
 * (a) A card from an in-memory message with a Reply-To mismatch, failed
 *     authentication and an http link whose text shows another site: the boxes
 *     make the card taller, redacted or not. The composed image is logged as a
 *     JPEG (`[socialcard-jpeg]`) for a human to look at.
 * (b) The app window with the verified-sender fixture open (luke's INBOX), the
 *     header expanded so its To line is on screen: the clone's text carries
 *     the popover and the sender, never the recipient, and the popover is
 *     neither clipped by an ancestor nor erased by the frame composite.
 *
 * Every value an assertion reads is logged as one `[sendetails]` JSON line.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { SENDER_AUTH_SUBJECT } from './mockImap.js';

const log = (tag, value) => console.log(`[sendetails] ${tag} ${JSON.stringify(value)}`);

// The fixture message of (b): From name and address as the header prints them,
// its uid in luke's INBOX, and the recipient (the account) the shot must mask.
const SENDER_NAME = 'Verified Sender';
const SENDER_ADDRESS = 'news@verified.mock.test';
const SENDER_UID = 9504;
const RECIPIENT = 'luke@mock.test';

const SPAM = {
  uid: 424242,
  subject: 'Your parcel is waiting',
  from: { name: 'Parcel Desk', address: 'parcel@prize-mail.example' },
  to: [{ name: 'Mia Example', address: 'mia@recipient.example' }],
  replyTo: [{ address: 'claims@elsewhere.example' }],
  authenticationResults: 'mx.example; spf=fail; dkim=none; dmarc=fail',
  date: '2026-09-28T23:42:00Z',
  html: '<div style="padding:24px"><p>Dear Mia Example, your parcel could not be delivered. Confirm your address:</p>'
    + '<p><a href="http://parcel-track.example/c/8841?e=mia%40recipient.example">https://post.example/track</a></p>'
    + '<p><a href="https://fine.example/help">Help centre</a></p></div>',
};

describe('Social export: spam sender, sender details and links', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await browser.waitUntil(() => browser.execute(() => typeof window.__MV_SOCIAL_CONTENT__ === 'function'
      && typeof window.__MV_CAPTURE_APP__ === 'function' && typeof window.__MV_SOCIAL_COMPOSE__ === 'object'),
    { timeout: 30_000, interval: 250, timeoutMsg: 'social hooks never loaded' });
  });

  const card = (message, options) => browser.executeAsync((message, options, done) => {
    (async () => {
      const started = performance.now();
      const content = await window.__MV_SOCIAL_CONTENT__(
        { ...message, date: new Date(message.date) },
        { content: 'card', theme: 'light', mailTheme: 'light', ...options },
      );
      const { composeSocialImage, loadWatermark, sizes } = window.__MV_SOCIAL_COMPOSE__;
      const out = composeSocialImage({
        content, size: sizes.portrait, background: { type: 'gradient', id: 'sunset' }, padding: 48, radius: 26,
        shadow: true, chrome: true, theme: 'light', watermark: await loadWatermark(), maxSize: { w: 1080, h: 1350 },
      });
      done({ ms: Math.round(performance.now() - started), w: content.width, h: content.height, jpeg: out.toDataURL('image/jpeg', 0.85) });
    })().catch(e => done({ error: String(e?.message || e) }));
  }, message, options);

  it('(a) the boxes make the card taller, and a redacted card still builds with the sender revealed', async function () {
    const plain = await card(SPAM, { redact: false });
    const boxes = await card(SPAM, { redact: false, senderDetails: true, links: true });
    const masked = await card(SPAM, { redact: true, revealSender: true, senderDetails: true, links: true });
    for (const [name, r] of [['plain', plain], ['boxes', boxes], ['masked+reveal', masked]]) {
      log(`card ${name}`, { ...r, jpeg: r.jpeg?.length });
      expect(r.error).toBeUndefined();
    }
    // Two boxes of a few rows each: at 2x, far more than a stray line of text.
    expect(boxes.h - plain.h).toBeGreaterThan(300);
    expect(masked.h - plain.h).toBeGreaterThan(300);
    console.log(`[socialcard-jpeg] ${boxes.jpeg}`);
    console.log(`[socialcard-jpeg] ${masked.jpeg}`);
  });

  /**
   * Opens the verified-sender fixture. The header is what names the open
   * message (as connected-sender-verification does); the message frame is
   * waited for separately, and described in the failure when it never comes.
   */
  async function openFixture() {
    const clickRow = () => browser.execute((subject) => {
      const row = [...document.querySelectorAll('[data-testid="email-row"]')]
        .find(r => r.offsetHeight > 0 && (r.innerText || '').includes(subject));
      if (!row) return false;
      row.click();
      return true;
    }, SENDER_AUTH_SUBJECT);
    const headerNamesSender = () => browser.execute((name) => {
      const header = document.querySelector('[data-testid="sender-header"]');
      return !!header && (header.innerText || '').includes(name);
    }, SENDER_NAME);

    await browser.waitUntil(async () => clickRow(), { timeout: 60_000, interval: 1000, timeoutMsg: 'fixture row never appeared' });
    // The first click can land while the list re-renders: click again until the header names the sender.
    await browser.waitUntil(async () => {
      if (await headerNamesSender()) return true;
      await clickRow();
      return false;
    }, { timeout: 45_000, interval: 1000, timeoutMsg: 'the viewer header never named the fixture sender' });

    const frames = () => browser.execute(() => [...document.querySelectorAll('#root iframe')].map((f) => {
      const box = f.getBoundingClientRect();
      let readable = false;
      try { readable = !!f.contentDocument?.body; } catch { readable = false; }
      return { sandbox: f.getAttribute('sandbox'), w: Math.round(box.width), h: Math.round(box.height), readable };
    }));
    // The fixture's body is plain text: the reader may draw it without a frame.
    // A frame, when there is one, gets time to load so the composite has it.
    let seen = [];
    await browser.waitUntil(async () => {
      seen = await frames();
      return seen.some(f => f.readable && f.h > 20);
    }, { timeout: 10_000, interval: 400 }).catch(() => {});
    log('frames', seen);
    // The frame's auto-size passes land up to a second after load.
    await browser.pause(1500);
    // The To line, with the recipient the shot must mask, is behind this toggle.
    const expanded = await browser.execute(() => {
      const toggle = document.querySelector('[data-testid="header-toggle"]');
      if (!toggle) return null;
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      return true;
    });
    expect(expanded).toBe(true);
    await browser.pause(1000);
  }

  it('(b) the app window shot opens the real popover, the sender address readable and the recipient masked', async function () {
    await openFixture();
    const r = await browser.executeAsync((target, reveal, done) => {
      (async () => {
        // The popover's geometry while the capture holds it open: is any clipping ancestor cutting it?
        let seen = null;
        const poll = setInterval(() => {
          const el = document.querySelector('[data-capture-overlay]');
          const box = el?.getBoundingClientRect();
          if (!box || box.height < 50) return;
          let clippedBy = null;
          for (let p = el.parentElement; p; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (!/(hidden|auto|scroll|clip)/.test(`${cs.overflowX} ${cs.overflowY}`)) continue;
            const pr = p.getBoundingClientRect();
            if (box.left < pr.left - 1 || box.right > pr.right + 1 || box.top < pr.top - 1 || box.bottom > pr.bottom + 1) {
              clippedBy = `${p.tagName.toLowerCase()}.${String(p.className).slice(0, 60)}`;
              break;
            }
          }
          const frame = document.querySelector('#root iframe[sandbox]')?.getBoundingClientRect();
          const overlap = frame && {
            left: Math.max(box.left, frame.left), top: Math.max(box.top, frame.top),
            right: Math.min(box.right, frame.right), bottom: Math.min(box.bottom, frame.bottom),
          };
          seen = {
            rect: { left: box.left, top: box.top, width: box.width, height: box.height },
            clippedBy,
            overFrame: overlap && overlap.right > overlap.left && overlap.bottom > overlap.top ? overlap : null,
          };
        }, 30);
        const root = document.getElementById('root');
        const rootRect = root.getBoundingClientRect();
        const started = performance.now();
        const canvas = await window.__MV_CAPTURE_APP__({ redact: true, dict: null, reveal, senderDetails: target });
        clearInterval(poll);
        const ms = Math.round(performance.now() - started);
        // The popover over the message frame: text there means the frame composite left it alone.
        let variance = null;
        if (seen?.overFrame) {
          const s = canvas.width / rootRect.width;
          const o = seen.overFrame;
          const w = Math.max(1, Math.round((o.right - o.left) * s));
          const h = Math.max(1, Math.round((o.bottom - o.top) * s));
          const d = canvas.getContext('2d').getImageData(Math.round((o.left - rootRect.left) * s), Math.round((o.top - rootRect.top) * s), w, h).data;
          let sum = 0; let sum2 = 0; let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
            sum += l; sum2 += l * l; n += 1;
          }
          variance = +(sum2 / n - (sum / n) ** 2).toFixed(5);
        }
        done({
          ms, w: canvas.width, h: canvas.height, seen, variance, text: window.__MV_CAPTURE_TEXT__(),
          after: { popover: !!document.querySelector('[data-capture-overlay]') },
        });
      })().catch(e => done({ error: String(e?.message || e) }));
    }, { uid: SENDER_UID, mailbox: 'INBOX' }, [SENDER_ADDRESS]);
    log('capture', { ...r, text: undefined, textLength: r.text?.length });
    expect(r.error).toBeUndefined();

    // The real popover is in the shot: its title and the authentication it reports.
    expect(r.text).toContain('Sender Details');
    expect(r.text).toContain('Authentication');
    // The sender's address is readable (header and popover), exactly as revealed;
    // the app window shot reveals addresses only, so the display name stays masked.
    expect(r.text).toContain(SENDER_ADDRESS);
    expect(r.text).not.toContain(SENDER_NAME);
    // The recipient is not: masked wherever it was on screen.
    expect(r.text).not.toContain(RECIPIENT);
    expect(r.text).toMatch(/x{4}@x{4}\.x{4}/);
    // Open while captured, closed after.
    expect(r.after.popover).toBe(false);
    // Not cut off by a clipping ancestor, and not erased by the frame composite.
    expect(r.seen).not.toBeNull();
    expect(r.seen.clippedBy).toBeNull();
    if (r.seen.overFrame) expect(r.variance).toBeGreaterThan(0.0005);
  });

  it('(b) the same shot without a reveal masks the sender too', async function () {
    // Open for real: absence assertions mean nothing against an empty window.
    await openFixture();
    const r = await browser.executeAsync((target, done) => {
      window.__MV_CAPTURE_APP__({ redact: true, dict: null, senderDetails: target })
        .then(() => done({ text: window.__MV_CAPTURE_TEXT__() }), e => done({ error: String(e?.message || e) }));
    }, { uid: SENDER_UID, mailbox: 'INBOX' });
    expect(r.error).toBeUndefined();
    // The open message's header and popover are there, with filler where the sender was.
    expect(r.text).toContain('Sender Details');
    expect(r.text).toContain('Authentication');
    expect(r.text).toMatch(/x{4}@x{8}\.x{4}\.x{4}/); // news@verified.mock.test
    expect(r.text).toMatch(/x{8} x{6}/); // Verified Sender
    expect(r.text).not.toContain(SENDER_ADDRESS);
    expect(r.text).not.toContain(SENDER_NAME);
  });
});
