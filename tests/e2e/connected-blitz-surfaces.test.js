/**
 * E2E: with emailRenderer 'blitz', every mail-body surface draws through
 * Blitz with no iframe, and the worker's open docs stay bounded under churn
 * and long scrolls. Every value asserted is logged as one `[blitzsurf]` line.
 *
 * Out of connected-ci (a 100-message chat, a 240 s idle-out wait): run it with
 *   npm run build:e2e && npx wdio run wdio.blitz.conf.js --spec tests/e2e/connected-blitz-surfaces.test.js
 * on the Mac mini only (src-render/tools/run-surfaces.sh queues it and brings
 * the screenshots back).
 *
 * Fixture: the Blitz folder on luke (mockImap.js blitzMailbox).
 *
 * Harness limits worked around on purpose (tauri-wd): pointer events are
 * page-dispatched MouseEvents, a double click is a dispatched dblclick, and a
 * select is driven through the store.
 */
import { execFileSync } from 'node:child_process';
import { waitForApp, waitForEmails, switchToFolder, pressKey } from './helpers.js';
import { closeComposeHard, modalOpen } from './composeHelpers.js';
import {
  BLITZ_FOLDER, BLITZ_THREAD_SUBJECT, BLITZ_CHAT_NAME, BLITZ_CHAT_COUNT, BLITZ_TALL_SUBJECT,
  BLITZ_LONG_ATTACHMENT_NAME,
} from './mockImap.js';
import { getEmailColors } from '../../src/utils/mailChrome.js';
import { raise, shootModes, windowShot, writeShot, setMode, readMode, restoreMode } from './blitzSurfaceShots.js';

const log = (tag, v) => console.log(`[blitzsurf] ${tag} ${JSON.stringify(v)}`);
const setStore = (patch) => browser.execute((p) => window.__SETTINGS_STORE__.setState(p), patch);
const dbg = (fn) => browser.execute((f) => window.__MV_BLITZ_DEBUG__[f](), fn);

const surfaceState = (scope, surface) => browser.execute((scope, surface) => {
  const host = scope ? document.querySelector(scope) : document;
  if (!host) return null;
  const bodies = [...host.querySelectorAll(`[data-renderer="blitz"][data-blitz-surface="${surface}"]`)];
  return {
    iframes: host.querySelectorAll('iframe').length,
    bodies: bodies.length,
    busy: bodies.filter(b => b.getAttribute('aria-busy') === 'true').length,
    painted: bodies.filter(b => {
      const t = b.querySelector('[data-testid="blitz-tile"]');
      return t && t.complete && t.naturalWidth > 0;
    }).length,
    widths: bodies.map(b => Math.round(b.getBoundingClientRect().width)),
  };
}, scope, surface);

async function waitPainted(scope, surface, min = 1) {
  await browser.waitUntil(async () => ((await surfaceState(scope, surface))?.painted ?? 0) >= min,
    { timeout: 20_000, interval: 200, timeoutMsg: `${surface}: no painted Blitz body` });
  const s = await surfaceState(scope, surface);
  log(surface, s);
  return s;
}

/** Painted and nothing re-opening: the surface has repainted after a theme flip. */
const settled = (scope, surface) => async () => {
  await browser.waitUntil(async () => {
    const s = await surfaceState(scope, surface);
    return !!s && s.painted >= 1 && s.busy === 0;
  }, { timeout: 25_000, interval: 250, timeoutMsg: `${surface}: did not settle after the mode flip` });
};

async function clickRow(subject, thread = false) {
  await browser.waitUntil(() => browser.execute((subject, thread) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')].find(r => r.offsetHeight > 0
      && (r.textContent || '').includes(subject) && (!thread || Number(r.getAttribute('data-thread-count') || 1) > 1));
    if (row) row.click();
    return !!row;
  }, subject, thread), { timeout: 30_000, interval: 300, timeoutMsg: `row ${subject} not found` });
}

/** Chat view: pick the correspondent, then the topic. */
async function openChat(name, subject) {
  await browser.waitUntil(() => browser.execute((name) => {
    const hit = [...document.querySelectorAll('[data-testid="sender-row"]')].find(el => el.offsetHeight > 0 && (el.textContent || '').includes(name));
    if (hit) hit.click();
    return !!hit;
  }, name), { timeout: 30_000, interval: 300, timeoutMsg: `chat correspondent ${name} not found` });
  await browser.waitUntil(() => browser.execute((subject) => {
    const hit = [...document.querySelectorAll('[role="button"]')].find(el => el.getAttribute('data-testid') !== 'sender-row'
      && el.offsetHeight > 0 && (el.textContent || '').includes(subject) && el.querySelector('h3'));
    if (hit) hit.click();
    return !!hit;
  }, subject), { timeout: 30_000, interval: 300, timeoutMsg: `chat topic ${subject} not found` });
  await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-blitz-surface="bubble"], [role="group"] iframe')), { timeout: 30_000, interval: 300, timeoutMsg: 'no bubble mounted' });
}

/** The card the social export builds, with the numbers the assertions read. */
const card = (a) => browser.executeAsync((a, done) => {
  (async () => {
    window.__SETTINGS_STORE__.setState({ emailRenderer: a.mode });
    const message = { subject: a.subject || 'Theme probe', from: { name: 'Probe', address: 'probe@example.com' }, to: [{ address: 'me@example.com' }], date: new Date('2026-09-28T23:42:00Z') };
    const c = await window.__MV_SOCIAL_CARD__({ message, bodyHtml: a.body, appearance: a.appearance, mail: a.mail, palette: a.palette });
    const ctx = c.getContext('2d');
    const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    // The body half of the card (never a single strip: where a text row lands differs by a few px between engines).
    const y0 = Math.round(c.height * 0.32);
    const d = ctx.getImageData(0, y0, c.width, Math.max(1, Math.min(c.height - y0, 1200))).data;
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    // How far right the body's ink reaches: 48 one-row strips down the lower half, any pixel unlike the corner's.
    const ref = px(c.width - 1, c.height - 1);
    let ink = 0;
    for (let k = 0; k < 48; k++) {
      const y = Math.min(c.height - 1, Math.round(c.height / 2 + (k / 48) * (c.height / 2)));
      const row = ctx.getImageData(0, y, c.width, 1).data;
      for (let x = c.width - 1; x > ink; x--) {
        const o = x * 4;
        if (Math.abs(row[o] - ref[0]) + Math.abs(row[o + 1] - ref[1]) + Math.abs(row[o + 2] - ref[2]) > 60) { ink = x; break; }
      }
    }
    done({
      w: c.width, h: c.height, body: +(sum / (d.length / 4)).toFixed(3), ink, mid: px(4, Math.round(c.height * 0.7)),
      bl: px(0, c.height - 1), br: px(c.width - 1, c.height - 1),
      png: a.png ? c.toDataURL('image/png').split(',')[1] : undefined,
    });
  })().catch(e => done({ error: String(e?.message || e) }));
}, a);

const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

/** The bubble that carries the long attachment name: its body (iframe or Blitz) and its group, in CSS px. */
const attachmentBubble = () => browser.execute((needle) => {
  const g = [...document.querySelectorAll('[role="group"]')].find(el => (el.textContent || '').includes(needle));
  if (!g) return null;
  const body = g.querySelector('[data-renderer="blitz"], iframe');
  if (!body) return { group: Math.round(g.getBoundingClientRect().width), body: null };
  return {
    kind: body.tagName === 'IFRAME' ? 'iframe' : 'blitz',
    body: Math.round(body.getBoundingClientRect().width),
    group: Math.round(g.getBoundingClientRect().width),
    busy: body.getAttribute('aria-busy') === 'true',
    doc: body.getAttribute('data-blitz-doc'),
    hold: body.getAttribute('data-testid'),
    painted: !!body.querySelector('[data-testid="blitz-tile"]'),
    failures: window.__MV_BLITZ_DEBUG__?.failures?.() ?? null,
  };
}, BLITZ_LONG_ATTACHMENT_NAME.slice(0, 16));

describe('Blitz on every surface', function () {
  this.timeout(900_000);
  const luke = () => browser.mockAccounts[0].email;
  let closeVia = null; // how a pop-out is closed so its onCloseRequested runs (F21), set by the probe test
  let size = null;
  let mode0 = null;

  before(async () => {
    await waitForApp();
    await waitForEmails();
    await browser.setTimeout({ script: 180_000 });
    size = await browser.getWindowSize();
    const raised = await raise(1280, 900);
    if (raised !== 'ok') await browser.setWindowSize(1280, 900);
    mode0 = await readMode();
    // The what's-new popover sits over the reading pane in every shot.
    await browser.pause(2500);
    await browser.execute(() => [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Dismiss')?.click());
    await setStore({ emailRenderer: 'blitz', viewStyle: 'list' });
    await switchToFolder(luke(), BLITZ_FOLDER);
  });
  after(async () => {
    try {
      await setStore({ emailRenderer: 'web', viewStyle: 'list' });
      if (mode0) await restoreMode(mode0);
      await browser.execute(() => window.__TAURI__?.window?.getCurrentWindow?.()?.setAlwaysOnTop(false));
      if (size) await browser.setWindowSize(size.width, size.height);
    } catch { /* app gone */ }
  });

  it('thread: no iframe, bodies paint, a red link raises link safety', async () => {
    await clickRow(BLITZ_THREAD_SUBJECT, true);
    const s = await waitPainted('.thread-reader', 'thread');
    expect(s.iframes).toBe(0);
    // The block link sits at the top of the body: find it with the worker's own hit test, then click there.
    const at = await browser.executeAsync((done) => {
      (async () => {
        const body = document.querySelector('.thread-reader [data-renderer="blitz"][data-blitz-doc]');
        const docId = Number(body.getAttribute('data-blitz-doc'));
        for (let y = 2; y < 120; y += 4) {
          const r = await window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'render.hit', params: { docId, x: 30, y } });
          if (r && r.link) { done({ docId, y, href: r.link.href, alert: r.link.alert ?? null }); return; }
        }
        done(null);
      })().catch(e => done({ error: String(e?.message || e) }));
    });
    log('phish-hit', at);
    expect(at && at.error).toBeUndefined();
    expect(at).not.toBe(null);
    expect(at.alert).toBeTruthy();
    await browser.execute((docId, y) => {
      const body = document.querySelector(`.thread-reader [data-blitz-doc="${docId}"] [data-blitz-tiles]`);
      const r = body.getBoundingClientRect();
      body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: r.left + 30, clientY: r.top + y }));
    }, at.docId, at.y);
    await browser.waitUntil(() => browser.execute(() => [...document.querySelectorAll('[role="alertdialog"]')].some(d => d.offsetHeight > 0)),
      { timeout: 8000, timeoutMsg: 'link safety did not open' });
    await browser.execute(() => {
      const d = [...document.querySelectorAll('[role="alertdialog"]')].find(el => el.offsetHeight > 0);
      [...d.querySelectorAll('button')].find(b => /cancel/i.test(b.textContent || '') || /cancel/i.test(b.getAttribute('aria-label') || ''))?.click();
    });
    await shootModes('thread', settled('.thread-reader', 'thread'));
  });

  it('app shot composites the Blitz bodies over the clone', async () => {
    await setMode('light');
    await browser.pause(500);
    await settled('.thread-reader', 'thread')();
    await browser.execute(() => document.querySelector('.thread-reader [data-renderer="blitz"][data-blitz-doc]')?.scrollIntoView({ block: 'start' }));
    await browser.pause(700);
    const shot = (name) => browser.executeAsync((name, done) => {
      (async () => {
        const body = document.querySelector('.thread-reader [data-renderer="blitz"][data-blitz-doc] [data-blitz-tiles]');
        const rect = body.getBoundingClientRect();
        const c = await window.__MV_CAPTURE_APP__({ redact: false });
        const ratio = c.width / window.innerWidth;
        const x0 = Math.max(0, Math.round(rect.left * ratio)); const y0 = Math.max(0, Math.round(rect.top * ratio));
        const w = Math.min(c.width - x0, Math.round(rect.width * ratio)); const h = Math.min(c.height - y0, Math.round(Math.min(rect.height, window.innerHeight - rect.top) * ratio));
        const d = c.getContext('2d').getImageData(x0, y0, Math.max(1, w), Math.max(1, h)).data;
        let red = 0; const seen = new Set();
        for (let i = 0; i < d.length; i += 4) {
          if (Math.abs(d[i] - 230) < 14 && Math.abs(d[i + 1] - 55) < 14 && Math.abs(d[i + 2] - 90) < 14) red += 1;
          if (seen.size < 64 && i % 28 === 0) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        }
        done({ name, canvas: [c.width, c.height], ratio, region: [x0, y0, w, h], red, distinct: seen.size, png: c.toDataURL('image/png').split(',')[1] });
      })().catch(e => done({ error: String(e?.message || e) }));
    }, name);
    const light = await shot('light');
    log('appshot-light', { ...light, png: undefined });
    expect(light.error).toBeUndefined();
    expect(light.red).toBeGreaterThan(20); // the heading colour was composited from the live doc
    writeShot('appshot-light', light.png);
    await setMode('dark');
    await browser.pause(500);
    await settled('.thread-reader', 'thread')();
    await browser.pause(500);
    const dark = await shot('dark');
    log('appshot-dark', { ...dark, png: undefined });
    expect(dark.error).toBeUndefined();
    expect(dark.distinct).toBeGreaterThan(4);
    writeShot('appshot-dark', dark.png);
    await setMode('light');
  });

  it('thread churn stays bounded and never paints a stale doc (Review Focus 2)', async () => {
    await browser.execute(async () => {
      const headers = [...document.querySelectorAll('.thread-reader [data-testid="thread-email-header"]')].slice(0, 2);
      for (let i = 0; i < 20; i++) { headers[i % 2].click(); await new Promise(r => setTimeout(r, 25)); }
    });
    await browser.pause(2500);
    const r = await browser.execute(() => ({
      open: window.__MV_BLITZ_DEBUG__.openDocs(), pending: window.__MV_BLITZ_DEBUG__.pendingOpens(),
      mounted: document.querySelectorAll('[data-renderer="blitz"]').length, failures: window.__MV_BLITZ_DEBUG__.failures(),
    }));
    log('churn', r);
    expect(r.pending).toBe(0);
    expect(r.open).toBeLessThanOrEqual(r.mounted + 8);
    expect(r.failures).toEqual([]);
  });

  it('chat: bubble width equals the iframe width, also with a long attachment name (Review Focus 3)', async () => {
    await setMode('light');
    await setStore({ viewStyle: 'chat', emailRenderer: 'web' });
    await openChat(BLITZ_CHAT_NAME, 'Blitz chat check');
    await browser.waitUntil(async () => (await attachmentBubble())?.body != null, { timeout: 30_000, interval: 300, timeoutMsg: 'the attachment bubble never mounted its iframe' });
    const web = await browser.execute(() => [...document.querySelectorAll('iframe')].slice(-3).map(f => Math.round(f.getBoundingClientRect().width)));
    const webAtt = await attachmentBubble();
    await setStore({ emailRenderer: 'blitz' });
    const s = await waitPainted(null, 'bubble', 1);
    const toBottom = () => browser.execute(() => {
      const sc = [...document.querySelectorAll('.overflow-y-auto')].find(el => el.querySelector('[role="group"]'));
      if (sc) sc.scrollTop = sc.scrollHeight;
    });
    try {
      await browser.waitUntil(async () => { await toBottom(); const a = await attachmentBubble(); return a && a.kind === 'blitz' && !a.busy; }, { timeout: 30_000, interval: 300, timeoutMsg: 'the attachment bubble never drew through Blitz' });
    } catch (e) { log('attachment-bubble-stuck', await attachmentBubble()); throw e; }
    const blitzAtt = await attachmentBubble();
    log('bubble-width', { web, blitz: s.widths.slice(-3) });
    log('bubble-attachment-width', { web: webAtt, blitz: blitzAtt });
    await shootModes('bubble', settled(null, 'bubble'));
    expect(s.iframes).toBe(0);
    // The bubbles without the long attachment name (the last one is checked on its own below).
    s.widths.slice(-web.length).slice(0, -1).forEach((w, i) => expect(Math.abs(w - web[i])).toBeLessThanOrEqual(1));
    // Task 6 gave the Blitz body a fixed 300 px wrapper: a bubble that grows past 300 px (long attachment name) must not leave it narrower than the iframe.
    expect(blitzAtt.body).toBeGreaterThanOrEqual(webAtt.body - 2);
  });

  it('100-message chat scroll keeps the worker bounded (Review Focus 1)', async () => {
    await browser.execute(async () => {
      const scroller = [...document.querySelectorAll('.overflow-y-auto')].find(el => el.querySelector('[data-blitz-surface="bubble"]'));
      scroller.scrollTop = 0;
      for (let y = 0; y <= scroller.scrollHeight; y += 400) { scroller.scrollTop = y; await new Promise(r => setTimeout(r, 50)); }
      scroller.scrollTop = scroller.scrollHeight;
    });
    await browser.pause(3000);
    const r = await browser.execute(() => ({
      open: window.__MV_BLITZ_DEBUG__.openDocs(), mounted: document.querySelectorAll('[data-renderer="blitz"]').length,
      failures: window.__MV_BLITZ_DEBUG__.failures(),
    }));
    log('scroll', { ...r, messages: BLITZ_CHAT_COUNT });
    expect(r.open).toBeLessThanOrEqual(r.mounted + 8);
    expect(r.failures).toEqual([]);
    await waitPainted(null, 'bubble', 1);
  });

  it('narrow window: every mounted bubble paints (Review Focus 3)', async () => {
    const { width, height } = await browser.getWindowSize();
    await browser.setWindowSize(560, 800);
    try {
      await browser.pause(1500);
      const s = await waitPainted(null, 'bubble', 1);
      expect(Math.min(...s.widths)).toBeGreaterThan(0);
      expect(await dbg('failures')).toEqual([]);
    } finally { await browser.setWindowSize(width, height); }
  });

  it('full view: double-click a bubble, Blitz fills the dialog', async () => {
    await browser.pause(800);
    await browser.execute(() => {
      const g = [...document.querySelectorAll('[role="group"]')].find(el => el.querySelector('[data-blitz-surface="bubble"]'));
      g.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const s = await waitPainted('[role="dialog"]', 'fullView');
    expect(s.iframes).toBe(0);
    await shootModes('fullview', settled('[role="dialog"]', 'fullView'));
    // tauri-wd does not deliver Escape to the webview: the dialog's own close button.
    await browser.execute(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.getAttribute('aria-label') === 'Close')?.click());
    await browser.waitUntil(() => browser.execute(() => !document.querySelector('[role="dialog"] [data-blitz-surface="fullView"]')), { timeout: 8000, timeoutMsg: 'full view did not close' });
    await setStore({ viewStyle: 'list' });
  });

  /** Select `email` in the store and open the reply (the shortcut reads selectedEmail at press time, as connected-compose-reply-modes seeds it). */
  async function openReplyTo(email) {
    await closeComposeHard();
    await setStore({ composeContextVisible: true }); // the reply opens with the original beside it
    const seed = () => browser.execute((e) => {
      window.__MAIL_STORE__.setState({ selectedEmail: e, selectedEmailId: e.uid, selectedThread: null });
      document.activeElement?.blur();
    }, email);
    await seed();
    await seed();
    await pressKey('r');
    await browser.waitUntil(modalOpen, { timeout: 15_000, interval: 200, timeoutMsg: 'Compose did not open on "r"' });
  }
  const quotedDiag = () => browser.execute(() => {
    const q = document.querySelector('[data-testid="compose-quoted"]');
    return {
      quoted: !!q, iframes: q?.querySelectorAll('iframe').length ?? null,
      bodies: [...(q?.querySelectorAll('[data-renderer]') ?? [])].map(b => ({ surface: b.getAttribute('data-blitz-surface'), busy: b.getAttribute('aria-busy'), doc: b.getAttribute('data-blitz-doc'), hold: b.getAttribute('data-testid') })),
      debug: { open: window.__MV_BLITZ_DEBUG__.openDocs(), pending: window.__MV_BLITZ_DEBUG__.pendingOpens(), failures: window.__MV_BLITZ_DEBUG__.failures() },
      text: (q?.innerText || '').slice(0, 160),
    };
  });

  /** Close the pop-out the way the harness can: tauri-wd's closeWindow, or the window's own close(). */
  async function closePopout(main) {
    if (closeVia === 'tauri') await browser.execute(() => { void window.__TAURI__.window.getCurrentWindow().close(); });
    else await browser.closeWindow();
    await browser.switchToWindow(main);
    if (size) await browser.setWindowSize(1280, 900);
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, { timeout: 15_000, interval: 200, timeoutMsg: 'the pop-out did not close' });
  }
  async function openPopout(main, args) {
    await browser.execute((a) => window.__MV_BLITZ_DEBUG__.openWindow(a), args);
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, { timeout: 15_000, timeoutMsg: 'no pop-out window' });
    const pop = (await browser.getWindowHandles()).find(h => h !== main);
    await browser.switchToWindow(pop);
    return pop;
  }

  // A main-window compose quotes the thread (a read-only ThreadView, 'thread' surface, next test); the
  // original-message frame ('original') is what the Detach original window and a detached compose draw.
  it('detached original message window: Blitz, no iframe', async () => {
    await setMode('light');
    const account = browser.mockAccounts[0];
    const email = {
      uid: 424242, subject: 'Blitz original check', from: { name: 'Orig Sender', address: 'orig@example.com' }, to: [{ address: account.email }],
      cc: [], replyTo: [], date: '2026-08-01T10:00:00.000Z', messageId: '<blitz-orig-424242@example.com>', text: 'Original plain body',
      html: `<h2 style="color:#e6375a">Original heading</h2>${Array.from({ length: 12 }, (_, i) => `<p>Quoted paragraph ${i + 1} of the original.</p>`).join('')}`,
      attachments: [], flags: ['\\Seen'], _accountId: account.id,
    };
    const main = await browser.getWindowHandle();
    await openReplyTo(email);
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="compose-original-detach"]')), { timeout: 15_000, timeoutMsg: 'no Detach original button' });
    await browser.execute(() => document.querySelector('[data-testid="compose-original-detach"]').click());
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, { timeout: 15_000, timeoutMsg: 'no original-message window' });
    const win = (await browser.getWindowHandles()).find(h => h !== main);
    await browser.switchToWindow(win);
    let s;
    try { s = await waitPainted(null, 'original'); } catch (e) { log('original-stuck', await quotedDiag()); throw e; }
    expect(s.iframes).toBe(0);
    // Shots: main shrinks below this window (700 x 680) so the capture finds it.
    await browser.switchToWindow(main);
    await browser.setWindowSize(600, 500);
    await browser.switchToWindow(win);
    await browser.pause(900);
    windowShot('original-light');
    await browser.execute(() => document.querySelector('[data-testid="original-window-theme"]')?.click());
    await settled(null, 'original')();
    await browser.pause(900);
    windowShot('original-dark');
    const ids = await dbg('docIds');
    await closePopout(main);
    await browser.pause(1500);
    for (const id of ids) {
      const probed = await browser.executeAsync((d, done) => { window.__MV_BLITZ_DEBUG__.probe(d).then(done, (e) => done(String(e))); }, id);
      expect(probed).toBe('render_unknown_doc');
    }
    await closeComposeHard();
  });

  it('compose quoted thread (a reply to a message in the list): Blitz, no iframe', async () => {
    await setMode('light');
    await clickRow(BLITZ_TALL_SUBJECT);
    const email = await browser.execute((subject) => window.__MAIL_STORE__.getState().sortedEmails.find(x => x.subject === subject) ?? null, BLITZ_TALL_SUBJECT);
    expect(email).not.toBe(null);
    await openReplyTo(email);
    let s;
    try { s = await waitPainted('[data-testid="compose-quoted"]', 'thread'); } catch (e) { log('quoted-thread-stuck', await quotedDiag()); throw e; }
    expect(s.iframes).toBe(0);
    await closeComposeHard();
  });

  it('pop-out close goes through onCloseRequested under tauri-wd (F21)', async () => {
    const main = await browser.getWindowHandle();
    await browser.executeAsync((done) => {
      window.__closeReq = 0;
      window.__TAURI__.event.listen('mv-e2e-close-requested', () => { window.__closeReq += 1; }).then(() => done(true), () => done(false));
    });
    await openPopout(main, { html: '<p>Close path probe</p>', dark: false, title: 'Close probe' });
    await waitPainted(null, 'popout');
    // Observes the request without deciding it: the window's own cleanup handler still holds the close and destroys the window.
    const hooked = await browser.executeAsync((done) => {
      window.__TAURI__.window.getCurrentWindow().onCloseRequested((e) => {
        e.preventDefault();
        void window.__TAURI__.event.emit('mv-e2e-close-requested', {});
      }).then(() => done(true), (err) => done(String(err)));
    });
    expect(hooked).toBe(true);
    await browser.closeWindow();
    await browser.switchToWindow(main);
    await browser.pause(2500);
    const requests = await browser.execute(() => window.__closeReq);
    const gone = (await browser.getWindowHandles()).length === 1;
    closeVia = requests > 0 ? 'wd' : 'tauri';
    log('close-path', { closeWindowFiresCloseRequested: requests > 0, requests, windowGone: gone, using: closeVia });
    if (!gone) await closePopout(main);
  });

  it('pop-out: an app window draws Blitz, and its docs are gone after close (Review Focus 5)', async () => {
    const main = await browser.getWindowHandle();
    const pop = await openPopout(main, { html: '<p>Pop-out body</p>' + Array.from({ length: 30 }, (_, i) => `<p>Line ${i} of the pop-out</p>`).join(''), dark: false, title: 'Pop-out check' });
    const s = await waitPainted(null, 'popout');
    expect(s.iframes).toBe(0);
    // A9: the native window title is the subject (needs core:window:allow-set-title).
    await browser.waitUntil(() => browser.executeAsync((done) => {
      window.__TAURI__.window.getCurrentWindow().title().then(t => done(t === 'Pop-out check'), () => done(false));
    }), { timeout: 5000, timeoutMsg: 'pop-out window title is not the subject' });
    // Shots: the biggest window on screen is the one captured, so main shrinks below the pop-out (674 x 680) meanwhile.
    await browser.switchToWindow(main);
    await browser.setWindowSize(600, 500);
    await browser.switchToWindow(pop);
    await browser.pause(900);
    windowShot('popout-light');
    await browser.execute(() => document.querySelector('[data-testid="original-window-theme"]')?.click());
    await settled(null, 'popout')();
    await browser.pause(900);
    windowShot('popout-dark');
    const ids = await dbg('docIds');
    expect(ids.length).toBeGreaterThan(0);
    await closePopout(main);
    await browser.pause(1500);
    for (const id of ids) {
      const probed = await browser.executeAsync((d, done) => { window.__MV_BLITZ_DEBUG__.probe(d).then(done, (e) => done(String(e))); }, id);
      log('doc-after-close', { id, probed });
      expect(probed).toBe('render_unknown_doc');
    }
  });

  // The window closes while its open is in flight (aria-busy). The doc is a
  // mid-size one that lands well inside installWindowDocCleanup's 1 s wait, so
  // this proves the pending-close path. An open slower than 1 s at close is
  // the accepted, untested residue (Review Focus 5).
  it('pop-out closed mid-render: the worker still idles out (Review Focus 5)', async () => {
    const workers = () => { try { return execFileSync('pgrep', ['-f', '--', 'mailvault-daemon --render-worker'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } };
    expect(workers().length).toBeGreaterThan(0); // earlier tests left a worker running; "none" must mean it exited
    const main = await browser.getWindowHandle();
    const midHtml = (rows) => Array.from({ length: rows }, (_, i) => `<table><tr><td>Row ${i}</td><td>${'x'.repeat(120)}</td></tr></table>`).join('');
    const busyNow = () => browser.execute(() => !!document.querySelector('[data-renderer="blitz"][aria-busy="true"]'));
    // Calibrate: how long this machine's open of the mid doc stays in flight. The close must land inside the cleanup's 1 s wait, so the doc is sized to open in about 400 ms.
    await openPopout(main, { html: midHtml(400), dark: false, title: 'Mid calibration' });
    await browser.waitUntil(busyNow, { timeout: 10_000, interval: 10 });
    const c0 = Date.now();
    await browser.waitUntil(async () => !(await busyNow()), { timeout: 20_000, interval: 25 });
    const openMs = Date.now() - c0;
    await closePopout(main);
    const rows = Math.max(40, Math.min(400, Math.round(400 * (400 / Math.max(openMs, 50)))));
    log('mid-calibration', { rows400OpenMs: openMs, rows });
    await openPopout(main, { html: midHtml(rows), dark: false, title: 'Mid' });
    await browser.waitUntil(busyNow, { timeout: 10_000, interval: 10, timeoutMsg: 'the mid doc was never seen in flight' });
    await closePopout(main);
    await setStore({ emailRenderer: 'web' }); // main's bodies unmount; deferred docs close (F19: a tick later)
    const t0 = Date.now();
    try {
      await browser.waitUntil(async () => workers().length === 0, { timeout: 240_000, interval: 5000, timeoutMsg: 'render worker never idled out: a doc leaked' });
    } catch (e) {
      log('idle-out-stuck', await browser.execute(() => ({
        open: window.__MV_BLITZ_DEBUG__.openDocs(), live: window.__MV_BLITZ_DEBUG__.liveDocs(), deferred: window.__MV_BLITZ_DEBUG__.deferredDocs(),
        pending: window.__MV_BLITZ_DEBUG__.pendingOpens(), ids: window.__MV_BLITZ_DEBUG__.docIds(),
        mounted: [...document.querySelectorAll('[data-renderer="blitz"]')].map(b => b.getAttribute('data-blitz-surface')),
        renderer: window.__SETTINGS_STORE__.getState().emailRenderer,
      })));
      throw e;
    }
    log('idle-out', { seconds: Math.round((Date.now() - t0) / 1000) });
    await setStore({ emailRenderer: 'blitz' });
  });

  it('dark social card matches the web card within tolerance, through Blitz', async () => {
    const BODY = '<div style="background:#ffffff;color:#111111;padding:24px">' + '<p>Hello there, a plain light body for the card.</p>'.repeat(6) + '</div>';
    const base = { appearance: 'dark', mail: 'dark', palette: 'indigo', body: BODY };
    const web = await card({ ...base, mode: 'web', png: true });
    const blitz = await card({ ...base, mode: 'blitz', png: true });
    log('social-dark', { web: { ...web, png: undefined }, blitz: { ...blitz, png: undefined } });
    writeShot('socialcard-dark-web', web.png);
    writeShot('socialcard-dark', blitz.png);
    expect(blitz.error).toBeUndefined();
    expect(blitz.w).toBe(web.w);
    expect(Math.abs(blitz.body - web.body)).toBeLessThanOrEqual(0.03);
    const light = await card({ ...base, appearance: 'light', mail: 'light', mode: 'blitz', png: true });
    expect(light.error).toBeUndefined();
    writeShot('socialcard-light', light.png);
  });

  it('the dark card body reaches both bottom corners in the mail background: no white strip', async () => {
    const body = '<p>Hello there, a plain body for the card.</p>'.repeat(6);
    const want = hex(getEmailColors('dark', 'indigo').background);
    const r = await card({ appearance: 'dark', mail: 'dark', palette: 'indigo', body, mode: 'blitz' });
    log('dark-corners', { want, bl: r.bl, br: r.br, size: [r.w, r.h] });
    expect(r.error).toBeUndefined();
    expect(r.bl).toEqual(want);
    expect(r.br).toEqual(want);
  });

  it('image export draws through Blitz (the same document the export dialog builds)', async () => {
    const r = await card({ appearance: 'light', mail: 'light', palette: 'graphite', body: '<h2>Export probe</h2>' + '<p>Some text for the export.</p>'.repeat(8), mode: 'blitz', png: true });
    log('export-light', { w: r.w, h: r.h, error: r.error });
    expect(r.error).toBeUndefined();
    expect(r.w).toBeGreaterThan(0);
    writeShot('export-light', r.png);
    const d = await card({ appearance: 'dark', mail: 'dark', palette: 'graphite', body: '<h2>Export probe</h2>' + '<p>Some text for the export.</p>'.repeat(8), mode: 'blitz', png: true });
    expect(d.error).toBeUndefined();
    writeShot('export-dark', d.png);
  });

  it('a tall mail exports through Blitz below the area wall (Review Focus 4)', async () => {
    await setStore({ emailRenderer: 'blitz' });
    const before = await dbg('openDocs');
    const body = Array.from({ length: 1000 }, (_, i) => `<p>Tall line ${i}</p>`).join('');
    const r = await card({ appearance: 'light', mail: 'light', palette: 'graphite', body, subject: 'Tall', mode: 'blitz' });
    const after = await dbg('openDocs');
    const failures = await dbg('failures');
    log('tall', { w: r.w, h: r.h, area: r.w * r.h, ink: r.ink, error: r.error, failures, openDocs: { before, after } });
    expect(r.error).toBeUndefined();
    expect(r.h).toBeGreaterThan(1000);
    // Over the wall (area at scale 2 > 16.7e6 px), the worker draws at a smaller scale: the card is narrower than 820 x 2, or within the cap outright.
    expect(r.w < 1640 || r.w * r.h <= 16.7e6).toBe(true);
    expect(failures).toEqual([]);
  });

  it('a mail at the 200 000 CSS px ceiling fails its export instead of exporting a truncated card (A10)', async () => {
    const before = await dbg('openDocs');
    const body = '<p>Top</p><div style="height:210000px;background:#eeeeee">spacer</div><p>Bottom</p>';
    // The page's rejection can reach us as the card's own {error} or as the driver's failed script: either carries the code.
    let r;
    try { r = await card({ appearance: 'light', mail: 'light', palette: 'graphite', body, subject: 'Too tall', mode: 'blitz' }); } catch (e) { r = { error: String(e?.message || e) }; }
    const after = await dbg('openDocs');
    log('ceiling', { error: r.error, w: r.w, h: r.h, openDocs: { before, after } });
    expect(String(r.error || '')).toContain('blitz_export_failed');
  });
});
