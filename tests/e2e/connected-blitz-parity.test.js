/**
 * E2E: Blitz parity harness (plan B, see the plan doc for the contract).
 *
 * Renders each corpus message (tests/fixtures/blitz-corpus/manifest.json) in
 * the reader twice, once with the iframe renderer ('web') and once with
 * Blitz. It then compares every element by parity id: computed colours,
 * font size and weight, box rect, and line count. The rules and tolerances
 * live in src/features/blitz/parity/compare.js, which has its own vitest.
 *
 * The iframe side runs assignParityIds' own source inside the webview. The
 * Blitz side reads ids the pre-pass stamped (window.__MV_PARITY__) and calls
 * render.inspect.
 *
 * Dark: Dark Reader stays on its fallback sheet until the frame reports
 * visible, so forceDarkReaderPass is copied from connected-html-render.
 *
 * Opt-in: it skips unless MV_PARITY=1 (src-render/tools/parity-job.sh sets
 * it), so the connected-ci battery is unaffected. It also skips when the
 * build has no Blitz module, and loads the module's files only after that
 * check.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import { PNG } from 'pngjs';
import { waitForApp, waitForEmails, switchToFolder, reloadApp, expecting } from './helpers.js';
import { MOCK_PASSWORD } from './mockImap.js';
import { windowId } from '../../scripts/screenshots/capture.js';
import { raiseWindow } from '../../scripts/screenshots/window.js';
// Loaded in before() (see there): src/features/blitz/parity/{parityIds,compare}.js
let assignParityIds;
let clusterLineCount;
let compareFixture;
let FRAME_SCRIPT;

const REPO = resolve(import.meta.dirname, '../..');
const CORPUS = join(REPO, 'tests/fixtures/blitz-corpus');
const MANIFEST = JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8'));
const KNOWN = JSON.parse(readFileSync(join(CORPUS, 'known-diffs.json'), 'utf8'));
const YODA = 'yoda@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda (same as connected-blitz-reader)
const FOLDER = 'BlitzCorpus';
const subjectOf = (id) => `Blitz corpus [${id}]`;
const list = (v, d) => (v || d).split(',').map((s) => s.trim()).filter(Boolean);
const MODES = list(process.env.MV_PARITY_MODES, 'light');
const WIDTHS = list(process.env.MV_PARITY_WIDTHS, 'wide,375').map((w) => (w === '375' ? 375 : w));
const ONLY = list(process.env.MV_PARITY_ONLY, '');
const FIXTURES = MANIFEST.fixtures.filter((f) => !ONLY.length || ONLY.includes(f.id));
const SHOTS = process.env.MV_PARITY_SHOTS === '1';
const NARROW_CSS = 'div:has(> iframe[sandbox]), div:has(> [data-mv-parity-doc]) { width: 375px !important; max-width: 375px !important; flex: none !important; }';

const rpc = (method, params) => browser.executeAsync((m, p, done) => {
  window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
    .then(done).catch((e) => done({ __error: String((e && e.message) || e) }));
}, method, params);

function corpusMessage(f, i) {
  const html = readFileSync(join(CORPUS, f.file), 'utf8');
  const b64 = Buffer.from(html, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from([
    'From: Blitz Corpus <corpus@mock.test>',
    `To: ${YODA}`,
    `Subject: ${subjectOf(f.id)}`,
    `Date: ${new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toUTCString()}`,
    `Message-ID: <blitz-corpus-${f.id.replace(/[^a-z0-9]+/gi, '-')}@mock.test>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="MvCorpus"',
    '',
    '--MvCorpus',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Blitz corpus ${f.id}`,
    '',
    '--MvCorpus',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '',
    '--MvCorpus--',
    '',
  ].join('\r\n'));
}

async function withYoda(fn) {
  const { host, port } = browser.mockImap[YODA_SERVER];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try { return await fn(client); } finally { await client.logout(); }
}

/** Click the row for `subject`, scrolling the virtualised list until it renders. */
async function openFixture(id) {
  const subject = subjectOf(id);
  const clicked = await browser.executeAsync((s, done) => {
    const find = () => [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => (r.textContent || '').includes(s) && r.offsetHeight > 0);
    const first = document.querySelector('[data-testid="email-row"]');
    let scroller = first && first.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (scroller) scroller.scrollTop = 0;
    let tries = 0;
    const step = () => {
      const row = find();
      if (row) { row.click(); done(true); return; }
      if (!scroller || ++tries > 40) { done(false); return; }
      scroller.scrollTop += Math.max(100, scroller.clientHeight - 60);
      setTimeout(step, 120);
    };
    step();
  }, subject);
  expecting(`row for ${id}`, () => expect(clicked).toBe(true));
}

const setRenderer = (m) => browser.execute((mode) => window.__SETTINGS_STORE__.getState().setEmailRenderer(mode), m);
const frameTheme = () => browser.execute(() => document.querySelector('iframe[sandbox]')?.contentDocument?.documentElement?.getAttribute('data-mv-theme') || null);

/** Set the reading pane's Light/Dark theme (the toggle from connected-html-render). */
async function setEmailTheme(want) {
  await browser.waitUntil(async () => (await frameTheme()) !== null, { timeout: 20_000, interval: 250, timeoutMsg: 'iframe never loaded' });
  if ((await frameTheme()) === want) return;
  const clicked = await browser.execute((label) => {
    for (const b of document.querySelectorAll('button')) {
      if ((b.textContent || '').trim() === label || b.getAttribute('aria-label') === label) { b.click(); return true; }
    }
    return false;
  }, want === 'light' ? 'Light' : 'Dark');
  expect(clicked).toBe(true);
  await browser.waitUntil(async () => (await frameTheme()) === want, { timeout: 15_000, interval: 250, timeoutMsg: `frame never re-rendered as ${want}` });
}

/** Copied from connected-html-render: make DR leave its fallback sheet. */
async function forceDarkReaderPass() {
  await browser.execute(() => {
    const win = document.querySelector('iframe[sandbox]')?.contentWindow;
    if (!win) return;
    const doc = win.document;
    Object.defineProperty(doc, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(doc, 'visibilityState', { get: () => 'visible', configurable: true });
    doc.dispatchEvent(new win.Event('visibilitychange'));
  });
  await browser.waitUntil(() => browser.execute(() => {
    const fb = document.querySelector('iframe[sandbox]')?.contentDocument?.querySelector('.darkreader--fallback');
    return !!fb && fb.textContent.length === 0;
  }), { timeout: 20_000, interval: 250, timeoutMsg: 'Dark Reader never got past its fallback sheet' });
  await browser.pause(500); // DR's async image analysis of data: backgrounds
}

const settleFrame = () => browser.executeAsync((done) => {
  const d = document.querySelector('iframe[sandbox]')?.contentDocument;
  (d?.fonts?.ready || Promise.resolve()).then(() => requestAnimationFrame(() => requestAnimationFrame(() => done(true))));
});

function collectFrame(assign, cluster) {
  const iframe = document.querySelector('iframe[sandbox]');
  const doc = iframe && iframe.contentDocument;
  if (!doc || !doc.body) return null;
  const win = doc.defaultView;
  const elements = assign(doc.body, false).map(({ el, id }) => {
    const cs = win.getComputedStyle(el);
    const rendered = el.getClientRects().length > 0;
    const r = el.getBoundingClientRect();
    const spans = [];
    const walker = doc.createTreeWalker(el, win.NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.data.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(t);
      for (const tr of range.getClientRects()) if (tr.height > 0) spans.push({ top: tr.top + win.scrollY, bottom: tr.bottom + win.scrollY });
    }
    return {
      mvId: id, tag: el.localName, rendered,
      rect: rendered ? { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height } : null,
      color: cs.color, backgroundColor: cs.backgroundColor,
      borderTopColor: cs.borderTopColor, borderRightColor: cs.borderRightColor,
      borderBottomColor: cs.borderBottomColor, borderLeftColor: cs.borderLeftColor,
      fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily,
      lineCount: spans.length ? cluster(spans) : null,
    };
  });
  const fb = doc.querySelector('.darkreader--fallback');
  return {
    width: doc.documentElement.clientWidth,
    iframeWidth: iframe.getBoundingClientRect().width,
    dpr: window.devicePixelRatio,
    ua: win.navigator.userAgent,
    drFallbackActive: !!fb && fb.textContent.length > 0,
    folds: doc.querySelectorAll('[data-quote-folded]').length,
    elements,
  };
}

const blitzRoot = () => browser.execute(() => {
  const r = document.querySelector('[data-mv-parity-doc]');
  return r ? {
    docId: Number(r.getAttribute('data-mv-parity-doc')),
    width: Number(r.getAttribute('data-mv-parity-width')),
    rev: Number(r.getAttribute('data-mv-parity-rev')),
    theme: r.getAttribute('data-mv-parity-theme'),
  } : null;
});

async function setNarrow(on) {
  await browser.execute((css, enable) => {
    let s = document.getElementById('mv-parity-width');
    if (enable && !s) { s = document.createElement('style'); s.id = 'mv-parity-width'; s.textContent = css; document.head.appendChild(s); }
    if (!enable && s) s.remove();
  }, NARROW_CSS, on);
}

// ── screenshots (macOS screencapture of the live window; see visual-compose-squiggle) ──
function captureWindow(file) {
  execFileSync('screencapture', ['-x', '-o', '-t', 'png', '-l', windowId(), file]);
  return PNG.sync.read(readFileSync(file));
}

/** Full-height image of the element matching `selector`: scroll, capture, crop, stack. */
async function captureElement(selector, tmp) {
  const geo = () => browser.execute((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    let sc = el.parentElement;
    while (sc && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    const r = el.getBoundingClientRect();
    const v = sc ? sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    return { x: r.left, top: r.top, w: r.width, h: r.height, viewTop: Math.max(0, v.top), viewBottom: Math.min(window.innerHeight, v.bottom), innerH: window.innerHeight, dpr: window.devicePixelRatio };
  }, selector);
  await browser.execute((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), selector);
  await browser.pause(300);
  let g = await geo();
  if (!g) return null;
  const out = new PNG({ width: Math.round(g.w * g.dpr), height: Math.round(g.h * g.dpr) });
  for (let pass = 0; pass < 60; pass++) {
    const img = captureWindow(`${tmp}-${pass}.png`);
    const chrome = img.height - Math.round(g.innerH * g.dpr); // title bar above the webview
    const visTop = Math.max(g.top, g.viewTop);
    const visBottom = Math.min(g.top + g.h, g.viewBottom);
    if (visBottom > visTop) {
      const sx = Math.round(g.x * g.dpr);
      const sy = chrome + Math.round(visTop * g.dpr);
      const dy = Math.round((visTop - g.top) * g.dpr);
      const rows = Math.min(Math.round((visBottom - visTop) * g.dpr), out.height - dy);
      PNG.bitblt(img, out, sx, sy, Math.min(out.width, img.width - sx), rows, 0, dy);
    }
    if (g.top + g.h <= g.viewBottom + 1) break;
    await browser.execute((sel, step) => {
      let sc = document.querySelector(sel)?.parentElement;
      while (sc && !(sc.scrollHeight > sc.clientHeight && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
      if (sc) sc.scrollTop += step;
    }, selector, Math.max(50, g.viewBottom - g.viewTop - 20));
    await browser.pause(250);
    g = await geo();
  }
  return out;
}

function sideBySide(a, b) {
  const gap = 16;
  const out = new PNG({ width: a.width + gap + b.width, height: Math.max(a.height, b.height) });
  out.data.fill(255);
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0);
  return PNG.sync.write(out);
}

describe('Blitz parity', function () {
  this.timeout(30 * 60_000);
  let OUT;
  let ua = '';
  const summary = [];

  let seeded = false;
  let prevSize = null;

  before(async function () {
    // Opt-in only: connected-ci globs connected-*.test.js, and an ungated
    // parity run would turn every mini battery red until the gate is green.
    // parity-job.sh sets MV_PARITY=1.
    if (process.env.MV_PARITY !== '1') this.skip();
    await waitForApp();
    await waitForEmails();
    const hasSetter = await browser.execute(() => typeof window.__SETTINGS_STORE__?.getState?.().setEmailRenderer === 'function');
    const probe = await rpc('render.inspect', { docId: 2 ** 31 });
    if (!hasSetter || !(String(probe?.__error || '').includes('render_unknown_doc') || Array.isArray(probe?.elements))) this.skip();

    // Dynamic, after the skip: with the Blitz module deleted these files are
    // gone, and a static import would fail the whole e2e run at load.
    ({ assignParityIds } = await import('../../src/features/blitz/parity/parityIds.js'));
    ({ clusterLineCount, compareFixture } = await import('../../src/features/blitz/parity/compare.js'));
    FRAME_SCRIPT = `return (${collectFrame.toString()})(${assignParityIds.toString()}, ${clusterLineCount.toString()});`;

    OUT = process.env.MV_PARITY_OUT || join(browser.testDataDir, 'blitz-parity');
    mkdirSync(join(OUT, 'cases'), { recursive: true });

    await withYoda(async (client) => {
      try { await client.mailboxDelete(FOLDER); } catch { /* not there */ }
      await client.mailboxCreate(FOLDER);
      for (const [i, f] of FIXTURES.entries()) await client.append(FOLDER, corpusMessage(f, i), ['\\Seen']);
    });
    seeded = true;
    await reloadApp(); // folder lists are read at start-up
    await waitForEmails();
    prevSize = await browser.getWindowSize();
    const raised = await raiseWindow(1280, 900).catch((e) => String(e));
    if (raised !== 'ok') await browser.setWindowSize(1280, 900);
    await browser.execute(() => { window.__MV_PARITY__ = true; });
    await switchToFolder(YODA, FOLDER);

    if (SHOTS) {
      const locked = execFileSync('/bin/sh', ['-c',
        'ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked raw -o - - 2>/dev/null || echo false',
      ], { encoding: 'utf-8' }).trim();
      expect(locked).toBe('false'); // unlock the runner's screen, or run without MV_PARITY_SHOTS
    }
  });

  after(async function () {
    if (OUT) {
      writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({
        date: new Date().toISOString(), ua, modes: MODES, widths: WIDTHS,
        cases: summary,
        totals: { cases: summary.length, passed: summary.filter((c) => c.passed).length },
      }, null, 2)}\n`);
    }
    if (!seeded) return; // skipped: nothing was touched
    // Leave the app as the next spec expects it: web renderer, normal window,
    // not pinned on top, and no BlitzCorpus folder in yoda's sidebar.
    try { await setNarrow(false); await setRenderer('web'); await browser.execute(() => { delete window.__MV_PARITY__; }); } catch { /* app gone */ }
    try { await browser.execute(() => window.__TAURI__?.window?.getCurrentWindow?.()?.setAlwaysOnTop(false)); } catch { /* no window api */ }
    try { if (prevSize) await browser.setWindowSize(prevSize.width, prevSize.height); } catch { /* best effort */ }
    try { await withYoda(async (c) => { await c.mailboxDelete(FOLDER); }); } catch { /* already gone */ }
    try { await reloadApp(); await waitForEmails(); } catch { /* best effort */ }
  });

  for (const mode of MODES) {
    for (const width of WIDTHS) {
      for (const f of FIXTURES) {
        it(`${f.id} ${mode} ${width}`, async function () {
          await setRenderer('web');
          await setNarrow(width === 375);
          await openFixture(f.id);
          await setEmailTheme(mode);
          if (mode === 'dark') await forceDarkReaderPass();
          await settleFrame();
          const frame = await browser.execute(FRAME_SCRIPT);
          expect(frame).not.toBeNull();
          ua = frame.ua;
          expecting(`${f.id}: the corpus must not fold quotes (plan C owns folding)`, () => expect(frame.folds).toBe(0));
          expecting(`${f.id}: Dark Reader still on its fallback sheet`, () => expect(frame.drFallbackActive).toBe(false));
          expecting('WKWebView UA carries "Safari"; regenerate the vectors with the safari profile (Task 10)', () => expect(/safari/i.test(frame.ua)).toBe(false));

          const shotFile = join(OUT, 'shots', `${mode}-${width}`, `${f.id.replace(/\//g, '__')}.png`);
          const iframeShot = SHOTS ? await captureElement('iframe[sandbox]', join(browser.testDataDir, 'shot-web')) : null;

          await setRenderer('blitz');
          let root = null;
          await browser.waitUntil(async () => {
            root = await blitzRoot();
            return !!root && root.theme === mode && root.width === frame.width;
          }, { timeout: 20_000, interval: 250, timeoutMsg: `Blitz root never matched (theme ${mode}, width ${frame.width}): ${JSON.stringify(root)}` });
          // Let data: image updates settle: the rev must hold still for 750 ms.
          let rev = root.rev;
          await browser.waitUntil(async () => {
            await browser.pause(750);
            const now = (await blitzRoot())?.rev;
            const stable = now === rev;
            rev = now;
            return stable;
          }, { timeout: 15_000, interval: 10, timeoutMsg: 'Blitz rev never settled' });
          const reply = await rpc('render.inspect', { docId: root.docId });
          expecting(`render.inspect for ${f.id}`, () => expect(reply?.__error).toBeUndefined());

          const result = compareFixture({ fixture: f.id, mode, width, iframe: frame.elements, blitz: reply.elements, knownDiffs: KNOWN });
          const caseFile = join(OUT, 'cases', `${f.id.replace(/\//g, '__')}__${mode}__${width}.json`);
          writeFileSync(caseFile, `${JSON.stringify({ ...result, meta: { frameWidth: frame.width, iframeWidth: frame.iframeWidth, dpr: frame.dpr, blitzRoot: root }, iframe: frame.elements, blitz: reply.elements }, null, 2)}\n`);
          summary.push({ fixture: f.id, mode, width, compared: result.compared, passed: result.passed, failing: result.failing.length, known: result.known.length });

          if (SHOTS) {
            const blitzShot = await captureElement('[data-mv-parity-doc]', join(browser.testDataDir, 'shot-blitz'));
            if (iframeShot && blitzShot) {
              mkdirSync(join(OUT, 'shots', `${mode}-${width}`), { recursive: true });
              writeFileSync(shotFile, sideBySide(iframeShot, blitzShot));
            }
          }
          expecting(`${f.id} ${mode} ${width}: ${result.failing.length} failing of ${result.compared}; first: ${JSON.stringify(result.failing.slice(0, 12))}`,
            () => expect(result.passed).toBe(true));
        });
      }
    }
  }
});
