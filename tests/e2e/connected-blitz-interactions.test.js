/**
 * E2E: Blitz plan C interactions, measured in the iframe and in Blitz on the
 * same messages, in the real webview with the real daemon and render worker.
 *
 * Every measured value is logged as one `[blitzC] <tag> <json>` line: the job
 * clone is deleted after the run, so stdout is the evidence.
 *
 * Harness limits, each worked around on purpose (tauri-wd, see its server.rs):
 *   - Pointer and key actions are page-dispatched MouseEvents / KeyboardEvents
 *     with NO modifiers and no native default action: a drag never selects, a
 *     right-click never fires `contextmenu`, Cmd+A / Cmd+C never act natively.
 *     So selections are set by Range (and the browser's own hit test,
 *     `caretRangeFromPoint`, stands in for a drag), events are dispatched with
 *     the modifiers set, and copy runs `execCommand('copy')`.
 *   - The OS clipboard is read from the machine running the app (pbpaste and
 *     osascript on macOS, Get-Clipboard on Windows), after a sentinel was put
 *     there, so a copy that did nothing cannot pass as a match.
 *   - `takeScreenshot` is an SVG foreignObject of the top document (no iframe,
 *     no ::selection, cross-origin tiles blank): colours are read with
 *     `screencapture -l` on macOS, best effort, and reported as not measured
 *     where that is unavailable.
 *
 * Fixtures (dated 2020, removed in `after`): A the interactions mail, B a
 * Lora mail, C a Merriweather mail, D 3000 paragraphs, E a one-line mail.
 *
 * Measurements log and assert only where the iframe is a hard baseline; the
 * rest is logged for the report. Known interim (Task 15): in the dark theme
 * the Blitz menu and selection colours stay light, so dark colour sections
 * log and do not assert.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD, appDataDir, seedIndexBacklog } from './mockImap.js';
import {
  waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav, startBackup,
} from './helpers.js';
import { closeComposeHard, modalOpen, editorText, editorHtml } from './composeHelpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda
const IS_MAC = process.platform === 'darwin';
const MOD = IS_MAC ? 'meta' : 'ctrl';

const en = JSON.parse(readFileSync(new URL('../../src/i18n/locales/en.json', import.meta.url), 'utf8'));
const TITLE = en['viewer.emailContent'] || 'Email content';

const SUBJECT_A = 'Blitz C interactions fixture';
const SUBJECT_B = 'Blitz C Google font fixture';
const SUBJECT_C = 'Blitz C Merriweather fixture';
const SUBJECT_D = 'Blitz C big fixture';
const SUBJECT_E = 'Blitz C short fixture';
const MSGIDS = ['blitzc-a', 'blitzc-b', 'blitzc-c', 'blitzc-d', 'blitzc-e'].map((x) => `${x}@mock.test`);

const PROBE = 'Sphinx of black quartz, judge my vow 0123456789';
const PROBE_STYLE = 'font-size: 24px; white-space: nowrap; display: inline-block';
const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active', clientAccessGranted: true };
const LINK_HREF = 'https://example.com/blitz-c';
const BIG_N = 3000;

const log = (tag, v) => console.log(`[blitzC] ${tag} ${JSON.stringify(v)}`);
const norm = (s) => String(s || '').replace(/\r/g, '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const visible = (html) => flat(String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
const firstDiff = (a, b) => {
  const x = String(a); const y = String(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  return i === x.length && i === y.length ? null : { at: i, a: x.slice(Math.max(0, i - 20), i + 40), b: y.slice(Math.max(0, i - 20), i + 40) };
};
const cut = (s, n = 1200) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}...(${String(s).length})` : String(s ?? ''));
// The iframe copies its own fold-toggle labels; Blitz marks them unselectable. Compared without them.
const noToggle = (s) => String(s || '').replace(/^(⋯|▸ Show signature|▾ Hide signature|▾ Hide quoted text)$/gm, '').replace(/\n{2,}/g, '\n');
// The nested inline-block paragraph has its own section (it is a known divergence): left out of the others.
const noCta = (s) => String(s || '').replace(/Ctabefore[^\n]*\n?/g, '').replace(/^Ctabutton text$/gm, '').replace(/^Btnlabel$/gm, '').replace(/\n{2,}/g, '\n');
const rgb = (s) => (Array.isArray(s) ? s.slice(0, 3) : (String(s || '').match(/[\d.]+/g) || []).slice(0, 3).map(Number));

// ── Fixtures ────────────────────────────────────────────────────────────────

const b64Lines = (text) => Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');

function htmlMail({ subject, messageId, from, day, html }) {
  const boundary = 'MvBlitzCBoundary';
  return Buffer.from([
    `From: ${from}`, `To: ${YODA}`, `Subject: ${subject}`,
    `Date: ${day} Jan 2020 12:00:00 +0000`, `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    b64Lines(`Plain text of ${subject}.`), '',
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    b64Lines(html), '',
    `--${boundary}--`, '',
  ].join('\r\n'));
}

const WRAP_N = 5;
const wrapParagraph = (i) => `<p style="margin:0">Wraptext W${i} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron.</p>`;

// The 240 px wrap zone comes FIRST, so its position does not depend on the pane width: its paragraphs are
// about 114 px tall (6 lines at 19 px), which puts the tile boundary at y=512 inside one of them. The link follows
// at once and the rest within the first two tiles, the only ones drawn (and given a text layer) before a scroll.
const HTML_A = `<div id="mv-c-wrapzone" style="width:240px;font-size:15px;line-height:19px">${Array.from({ length: WRAP_N }, (_, i) => wrapParagraph(i)).join('')}</div>
<a id="mv-c-link" href="${LINK_HREF}" style="display:block">Link</a>
<p id="mv-c-reply">Reply text with naïve 😀 東京 and עברית mixed.</p>
<p id="mv-c-br">Brline one<br>Brline two<br>Brline three</p>
<p id="mv-c-cta">Ctabefore <a id="mv-c-cta-a" href="https://example.com/cta" style="display:inline-block;padding:4px 10px;background:#dde;text-decoration:none">Ctabutton text</a> ctamiddle <button id="mv-c-btn" type="button" style="display:inline-block">Btnlabel</button> btnafter.</p>
<p>On Fri, Aug 21, 2026, Person A wrote:</p><blockquote><p>Quoted line one.</p></blockquote>
<p>After the quote.</p><div class="gmail_signature">Person B</div>
${Array.from({ length: 40 }, (_, i) => `<p>Filler paragraph ${i} about the quote and the reply.</p>`).join('')}
<p id="mv-c-last">Last paragraph marker ZZLASTZZ.</p>`;

const googleLink = (family) => `<link href="https://fonts.googleapis.com/css2?family=${family}:wght@400;700&display=swap" rel="stylesheet">`;
const HTML_B = `${googleLink('Lora')}`
  + `<p id="mv-c-lora" style="font-family: 'Lora', Georgia, serif">This paragraph is written in Lora.</p>`
  + `<p><span id="mv-c-lora-probe" style="font-family: 'Lora', Georgia, serif; ${PROBE_STYLE}">${PROBE}</span></p>`
  + `<p><span id="mv-c-georgia-probe" style="font-family: Georgia, serif; ${PROBE_STYLE}">${PROBE}</span></p>`;
const HTML_C = `${googleLink('Merriweather')}`
  + `<p id="mv-c-merri" style="font-family: 'Merriweather', Georgia, serif">This paragraph is written in Merriweather.</p>`
  + `<p><span id="mv-c-merri-probe" style="font-family: 'Merriweather', Georgia, serif; ${PROBE_STYLE}">${PROBE}</span></p>`;
const HTML_D = Array.from({ length: BIG_N }, (_, i) => `<p style="margin:0">Paragraph ${i} of the big fixture${i === BIG_N - 1 ? ' ZZBIGLASTZZ' : ''}.</p>`).join('');
const HTML_E = '<p id="mv-c-short" style="margin:0">Short <a id="mv-c-short-link" href="https://example.com/short">link</a></p>';

const MAILS = [
  { subject: SUBJECT_A, id: 0, from: 'Blitz A <a@blitzc.test>', day: 'Thu, 02', html: HTML_A },
  { subject: SUBJECT_B, id: 1, from: 'Blitz B <b@blitzc.test>', day: 'Fri, 03', html: HTML_B },
  { subject: SUBJECT_C, id: 2, from: 'Blitz C <c@blitzc.test>', day: 'Sat, 04', html: HTML_C },
  { subject: SUBJECT_D, id: 3, from: 'Blitz D <d@blitzc.test>', day: 'Sun, 05', html: HTML_D },
  { subject: SUBJECT_E, id: 4, from: 'Blitz E <e@blitzc.test>', day: 'Mon, 06', html: HTML_E },
];

async function withMailbox(path, fn) {
  const { host, port } = browser.mockImap[YODA_SERVER];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(path);
    try { return await fn(client); } finally { lock.release(); }
  } finally {
    await client.logout();
  }
}

// ── The OS clipboard ────────────────────────────────────────────────────────

const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`], { encoding: 'utf8', timeout: 20_000 });

function setClip(text) {
  if (IS_MAC) execFileSync('pbcopy', { input: text });
  else ps(`Set-Clipboard -Value '${text.replace(/'/g, "''")}'`);
}

function cfHtmlFragment(raw) {
  const m = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/.exec(raw);
  return m ? m[1] : raw;
}

/** What is on the OS clipboard now: { plain, html, flavours }. */
function readClip() {
  if (IS_MAC) {
    const plain = execFileSync('pbpaste', { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    let html = '';
    let flavours = '';
    try {
      const raw = execFileSync('osascript', ['-e', 'the clipboard as «class HTML»'], { encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
      const hex = (raw.match(/«data HTML([0-9A-F]*)»/i) || [])[1] || '';
      html = Buffer.from(hex, 'hex').toString('utf8');
    } catch { /* no HTML flavour */ }
    try { flavours = execFileSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8', timeout: 20_000 }).trim(); } catch { /* ignore */ }
    return { plain, html, flavours };
  }
  let plain = '';
  let html = '';
  try { plain = ps('Get-Clipboard -Raw').replace(/\r?\n$/, ''); } catch { /* empty */ }
  try { html = cfHtmlFragment(ps('Get-Clipboard -TextFormatType Html -Raw')); } catch { /* no HTML flavour */ }
  return { plain, html, flavours: '' };
}

const sentinel = () => `MV-SENTINEL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ── In-page kit, installed once and reinstalled if the page was reloaded ───

/* eslint-disable */
function installKit(title) {
  const K = { v: 9, title };
  window.__mvc = K;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  K.sleep = sleep;
  K.rpc = (method, params) => window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method, params });
  K.frame = () => [...document.querySelectorAll('iframe')].find((f) => f.title === title && f.offsetHeight > 0) || null;
  K.ctx = (mode) => {
    if (mode === 'web') {
      const f = K.frame();
      if (!f) return null;
      let d = null;
      try { d = f.contentDocument; } catch { d = null; }
      if (!d || !d.body) return null;
      const r = f.getBoundingClientRect();
      return { doc: d, win: f.contentWindow, scope: d.body, left: r.left, top: r.top, frame: f };
    }
    const layer = document.querySelector('[data-testid="blitz-text-layer"]');
    if (!layer) return null;
    return { doc: document, win: window, scope: layer, left: 0, top: 0, layer };
  };
  K.texts = (c) => {
    const out = [];
    const w = c.doc.createTreeWalker(c.scope, 4);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (p && /^(STYLE|SCRIPT)$/.test(p.tagName)) continue;
      out.push(n);
    }
    return out;
  };
  K.find = (c, needle) => {
    for (const n of K.texts(c)) { const i = n.data.indexOf(needle); if (i >= 0) return [n, i]; }
    return null;
  };
  K.blitz = () => {
    const body = document.querySelector('[data-testid="blitz-email-body"]');
    const tiles = [...document.querySelectorAll('[data-testid="blitz-tile"]')];
    const m = /(\d+)(?:%2F|\/)(\d+)(?:%2F|\/)(\d+)$/i.exec((tiles.find((t) => t.getAttribute('src')) || {}).src || '');
    return {
      docId: body ? Number(body.dataset.docId) || null : null,
      rev: m ? Number(m[2]) : null,
      tiles: tiles.length,
      withSrc: tiles.filter((t) => t.getAttribute('src')).length,
      loaded: tiles.filter((t) => t.getAttribute('src') && t.complete && t.naturalWidth > 0).length,
      iframes: document.querySelectorAll('iframe').length,
      cssHeight: (() => { const b = body && body.querySelector('[role="presentation"]'); return b ? b.getBoundingClientRect().height : 0; })(),
      notice: !!document.querySelector('[data-testid="blitz-failure-notice"]'),
    };
  };
  K.ready = (mode, needle) => {
    const c = K.ctx(mode);
    if (!c) return { ok: false };
    const has = !!K.find(c, needle);
    if (mode === 'web') return { ok: has };
    const b = K.blitz();
    return { ok: has && b.iframes === 0 && b.withSrc >= Math.min(2, b.tiles) && b.loaded === b.withSrc, ...b };
  };
  K.select = (mode, a, b) => {
    const c = K.ctx(mode);
    if (!c) return false;
    const s = K.find(c, a); const e = K.find(c, b);
    if (!s || !e) return false;
    const r = c.doc.createRange();
    r.setStart(s[0], s[1]); r.setEnd(e[0], e[1] + b.length);
    const sel = c.win.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    return !sel.isCollapsed; // a reversed pair of needles collapses the range: that is a failed select
  };
  K.selText = (mode) => { const c = K.ctx(mode); return c ? String(c.win.getSelection()) : null; };
  K.clear = (mode) => { const c = K.ctx(mode); if (c) c.win.getSelection().removeAllRanges(); };
  K.rect = (mode, needle, from, to, noReveal) => {
    let c = K.ctx(mode);
    if (!c) return null;
    const hit = K.find(c, needle);
    if (!hit) return null;
    if (!noReveal && hit[0].parentElement && hit[0].parentElement.scrollIntoView) {
      hit[0].parentElement.scrollIntoView({ block: 'center', inline: 'nearest' });
      c = K.ctx(mode);
    }
    const r = c.doc.createRange();
    const a = from == null ? 0 : from; const b = to == null ? needle.length : to;
    r.setStart(hit[0], hit[1] + a); r.setEnd(hit[0], hit[1] + b);
    const q = r.getBoundingClientRect();
    return { left: c.left + q.left, right: c.left + q.right, top: c.top + q.top, bottom: c.top + q.bottom, width: q.width, height: q.height };
  };
  K.debugOn = () => {
    if (window.__mvDebugOn) return;
    window.__mvDebugOn = true; window.__mvDebug = [];
    const orig = console.debug.bind(console);
    console.debug = (...a) => { try { const s = String(a[0]); if (s.startsWith('[blitz]')) window.__mvDebug.push(a.map((x) => String((x && x.message) || x)).join(' ').slice(0, 200)); } catch { /* ignore */ } orig(...a); };
  };
  K.spy = (mode) => {
    const c = K.ctx(mode);
    if (!c) return false;
    K.debugOn();
    c.win.__mvSpy = null;
    if (!c.win.__mvSpyOn) {
      c.win.__mvSpyOn = true;
      c.win.addEventListener('copy', (e) => {
        const dt = e.clipboardData;
        c.win.__mvSpy = { prevented: e.defaultPrevented, types: dt ? [...dt.types] : [], html: dt ? dt.getData('text/html') : null, plain: dt ? dt.getData('text/plain') : null };
      });
    }
    return true;
  };
  K.copy = (mode) => {
    const c = K.ctx(mode);
    if (!c) return null;
    let ok;
    c.win.__mvSpy = null;
    try { ok = c.doc.execCommand('copy'); } catch (e) { ok = `threw ${e && e.message}`; }
    return { ok, spy: c.win.__mvSpy || null, debug: (window.__mvDebug || []).splice(0) };
  };
  K.target = (c, x, y) => c.doc.elementFromPoint(x - c.left, y - c.top);
  K.fire = (mode, type, x, y, init) => {
    const c = K.ctx(mode);
    if (!c) return null;
    const el = K.target(c, x, y);
    if (!el) return { hit: null };
    const ev = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: c.win, clientX: x - c.left, clientY: y - c.top, button: 0 }, init || {}));
    el.dispatchEvent(ev);
    return { hit: el.tagName, prevented: ev.defaultPrevented };
  };
  K.key = (mode, key, mods) => {
    const c = K.ctx(mode);
    let target;
    if (mode === 'web') target = c ? c.doc.body : document.body;
    else { const root = document.querySelector('[data-testid="blitz-email-body"]'); if (root) root.focus({ preventScroll: true }); target = document.activeElement || root; }
    const ev = new KeyboardEvent('keydown', Object.assign({ key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true }, mods || {}));
    target.dispatchEvent(ev);
    return { target: target && target.tagName, prevented: ev.defaultPrevented };
  };
  K.caret = (mode, x, y) => {
    const c = K.ctx(mode);
    if (!c) return null;
    const px = x - c.left; const py = y - c.top;
    let r = null;
    if (c.doc.caretRangeFromPoint) r = c.doc.caretRangeFromPoint(px, py);
    else if (c.doc.caretPositionFromPoint) { const p = c.doc.caretPositionFromPoint(px, py); if (p) { r = c.doc.createRange(); r.setStart(p.offsetNode, p.offset); } }
    if (!r) return null;
    const n = r.startContainer; const o = r.startOffset;
    const t = n.nodeType === 3 ? n.data : '';
    return { node: n, offset: o, ctx: n.nodeType === 3 ? `${t.slice(Math.max(0, o - 14), o)}|${t.slice(o, o + 14)}` : `[${n.nodeName}]` };
  };
  K.drag = (mode, sx, sy, ex, ey) => {
    const c = K.ctx(mode);
    const a = K.caret(mode, sx, sy); const b = K.caret(mode, ex, ey);
    if (!a || !b) return null;
    const sel = c.win.getSelection();
    sel.removeAllRanges();
    sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
    return { text: String(sel), from: a.ctx, to: b.ctx };
  };
  K.paragraphAt = (mode, x, y) => {
    const c = K.ctx(mode);
    const a = K.caret(mode, x, y);
    if (!a) return null;
    const sel = c.win.getSelection();
    sel.removeAllRanges();
    sel.collapse(a.node, a.offset);
    if (typeof sel.modify !== 'function') return { unsupported: true };
    sel.modify('move', 'backward', 'paragraphboundary');
    sel.modify('extend', 'forward', 'paragraphboundary');
    return { text: String(sel), at: a.ctx };
  };
  K.lines = (mode, needle) => {
    // Line boxes of the paragraph that holds `needle`: one rect per laid-out line.
    const c = K.ctx(mode);
    if (!c) return null;
    const hit = K.find(c, needle);
    if (!hit) return null;
    if (mode === 'web') {
      const p = hit[0].parentElement;
      const r = c.doc.createRange(); r.selectNodeContents(p);
      return [...r.getClientRects()].map((q) => ({ left: c.left + q.left, right: c.left + q.right, top: c.top + q.top, bottom: c.top + q.bottom }));
    }
    const node = hit[0].parentElement.dataset.node;
    return [...c.layer.querySelectorAll(`span[data-node="${node}"]`)].map((s) => { const q = s.getBoundingClientRect(); return { left: q.left, right: q.right, top: q.top, bottom: q.bottom, text: s.textContent, tile: s.closest('[data-tile]') && s.closest('[data-tile]').dataset.tile }; }).sort((p, q) => p.top - q.top);
  };
  K.lineInfo = (mode, needle) => {
    const c = K.ctx(mode);
    if (!c) return null;
    const hit = K.find(c, needle);
    if (!hit) return null;
    const node = hit[0];
    const rr = (a, b) => { const r = c.doc.createRange(); r.setStart(node, a); r.setEnd(node, b); return r.getBoundingClientRect(); };
    const first = rr(hit[1], hit[1] + 1);
    let end = hit[1];
    for (let i = hit[1]; i < node.data.length; i += 1) {
      const q = rr(i, i + 1);
      if (q.width === 0 && q.height === 0) { end = i + 1; continue; }
      if (Math.abs(q.top - first.top) > 6) break;
      end = i + 1;
    }
    const last = rr(end - 1, end);
    return { text: node.data.slice(hit[1], end), left: c.left + first.left, rightEdge: c.left + last.right, top: c.top + first.top, bottom: c.top + first.bottom };
  };
  K.replyQuote = (mode) => {
    const c = K.ctx(mode);
    if (!c) return null;
    const sel = c.win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    if (!c.scope.contains(sel.getRangeAt(0).commonAncestorContainer)) return '';
    return String(sel).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])).replace(/\r?\n/g, '<br>');
  };
  K.focus = (mode) => {
    if (mode === 'web') { const f = K.frame(); if (f) { f.contentWindow.focus(); f.contentDocument.body.focus && f.contentDocument.body.focus(); } return !!f; }
    const root = document.querySelector('[data-testid="blitz-email-body"]'); if (root) root.focus({ preventScroll: true });
    return !!root;
  };
  K.resetWt = () => { if (window.__mvWt) window.__mvWt.calls = []; return true; };
  K.scrollBottom = () => {
    const root = document.querySelector('[data-testid="blitz-email-body"]');
    let el = root;
    while (el && !(el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    if (!el) return null;
    el.scrollTop = el.scrollHeight;
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
  };
  K.chip = () => { const c = document.querySelector('[data-testid="blitz-link-chip"]'); return c ? c.textContent : null; };
  K.menu = (mode) => {
    const c = K.ctx(mode);
    const menu = mode === 'web' ? (c && c.doc.getElementById('mv-ctx-menu')) : document.querySelector('[data-testid="blitz-context-menu"]');
    if (!menu) return null;
    const win = mode === 'web' ? c.win : window;
    const cs = win.getComputedStyle(menu);
    const kids = [...menu.children];
    const ics = kids.length ? win.getComputedStyle(kids[0]) : null;
    const off = mode === 'web' ? { left: c.left, top: c.top } : { left: 0, top: 0 };
    const rectOf = (el) => { const q = el.getBoundingClientRect(); return { left: off.left + q.left, right: off.left + q.right, top: off.top + q.top, bottom: off.top + q.bottom }; };
    const inWin = (q) => q.left >= -0.5 && q.top >= -0.5 && q.right <= window.innerWidth + 0.5 && q.bottom <= window.innerHeight + 0.5;
    const itemInfo = kids.map((k) => {
      const q = rectOf(k);
      const cx = (q.left + q.right) / 2; const cy = (q.top + q.bottom) / 2;
      let top = null;
      if (mode === 'blitz') top = document.elementFromPoint(cx, cy);
      return { text: k.textContent, rect: q, inWindow: inWin(q), reachable: mode === 'blitz' ? !!top && (top === k || k.contains(top)) : null };
    });
    return { items: kids.map((k) => k.textContent), itemInfo, rect: rectOf(menu), inWindow: inWin(rectOf(menu)), bg: cs.backgroundColor, border: cs.borderTopColor, color: ics ? ics.color : null, shadow: cs.boxShadow };
  };
  K.clickItem = (mode, label) => {
    const c = K.ctx(mode);
    const menu = mode === 'web' ? (c && c.doc.getElementById('mv-ctx-menu')) : document.querySelector('[data-testid="blitz-context-menu"]');
    if (!menu) return false;
    const item = [...menu.children].find((k) => k.textContent.trim() === label);
    if (!item) return false;
    item.click();
    return true;
  };
  K.writeTextSpy = () => {
    if (window.__mvWt) return true;
    window.__mvWt = { calls: [] };
    const cb = navigator.clipboard;
    if (!cb || !cb.writeText) { window.__mvWt.missing = true; return false; }
    const orig = cb.writeText.bind(cb);
    cb.writeText = (t) => {
      const rec = { text: t, settled: 'pending' };
      window.__mvWt.calls.push(rec);
      const p = orig(t);
      p.then(() => { rec.settled = 'ok'; }, (e) => { rec.settled = `rejected ${e && e.name}`; });
      return p;
    };
    return true;
  };
  K.iframeWatch = (on) => {
    if (on && !window.__mvIw) {
      window.__mvIw = { on: true, seen: [], compose: 0 };
      new MutationObserver((ms) => {
        if (!window.__mvIw.on) return;
        for (const m of ms) for (const n of m.addedNodes) {
          const list = n.nodeName === 'IFRAME' ? [n] : (n.querySelectorAll ? [...n.querySelectorAll('iframe')] : []);
          // The reply's reading context is compose (plan D); only an iframe in the reader counts here.
          for (const f of list) {
            if (f.closest('[data-testid^="compose"]')) { window.__mvIw.compose += 1; continue; }
            window.__mvIw.seen.push({ t: Math.round(performance.now()), title: f.title, parent: (f.parentElement && f.parentElement.className || '').toString().slice(0, 60) });
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (window.__mvIw) window.__mvIw.on = !!on;
    return true;
  };
  K.iframeSeen = (reset) => {
    const r = window.__mvIw ? { seen: window.__mvIw.seen.slice(), compose: window.__mvIw.compose, now: [...document.querySelectorAll('iframe')].filter((f) => !f.closest('[data-testid^="compose"]')).length } : { seen: [], now: document.querySelectorAll('iframe').length, noWatch: true };
    if (reset && window.__mvIw) { window.__mvIw.seen = []; window.__mvIw.compose = 0; }
    return r;
  };
  K.rafProbe = () => new Promise((resolve) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n += 1; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else resolve(n); };
    requestAnimationFrame(tick);
    setTimeout(() => resolve(n), 1500);
  });
  K.probeWidth = (probe) => {
    const all = [...document.querySelectorAll('[data-testid="blitz-text-layer"] span[data-node]')];
    const head = probe.slice(0, 6);
    const starts = all.filter((x) => x.textContent.includes(head));
    const widthOf = (sp) => {
      if (!sp) return 0;
      const same = all.filter((x) => x.dataset.node === sp.dataset.node);
      const rs = same.map((x) => x.getBoundingClientRect());
      return Math.max(...rs.map((r) => r.right)) - Math.min(...rs.map((r) => r.left));
    };
    starts.sort((p, q) => p.getBoundingClientRect().top - q.getBoundingClientRect().top);
    return { lora: widthOf(starts[0]), georgia: widthOf(starts[1]), groups: starts.length, n: all.length };
  };
  K.layerOrigin = () => { const r = document.querySelector('[data-testid="blitz-text-layer"]').getBoundingClientRect(); return { left: r.left, top: r.top }; };
  K.textRuns = async (docId, index) => (await K.rpc('render.textRuns', { docId, index })).runs || [];
  K.inkDrift = async (needles) => {
    // Highlight edge vs glyph edge: for each line of each paragraph (tile 0), the right edge of the
    // last non-space character's range rect against the rightmost dark pixel of the tile PNG in the line band.
    const b = K.blitz();
    if (!b.docId) return { error: 'no doc' };
    const r = await K.rpc('render.tile', { docId: b.docId, index: 0 });
    const bin = atob(r.png); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const k = bmp.width / (document.querySelector('[data-testid="blitz-text-layer"]').getBoundingClientRect().width || bmp.width);
    const layerRect = document.querySelector('[data-testid="blitz-text-layer"]').getBoundingClientRect();
    const out = [];
    for (const needle of needles) {
      const c = K.ctx('blitz');
      const hit = K.find(c, needle);
      if (!hit) continue;
      const root = hit[0].parentElement.closest('.mv-blitz-root');
      for (const s of root.querySelectorAll('span[data-node]')) {
        const text = s.firstChild; if (!text) continue;
        const str = text.data; const end = str.trimEnd().length;
        if (!end) continue;
        const rr = c.doc.createRange(); rr.setStart(text, end - 1); rr.setEnd(text, end);
        const q = rr.getBoundingClientRect();
        const lineTop = s.getBoundingClientRect().top - layerRect.top; const lineBot = s.getBoundingClientRect().bottom - layerRect.top;
        if (lineBot > 500) continue; // tile 0 only
        let ink = -1;
        const x0 = Math.floor((q.left - layerRect.left - 12) * k); const x1 = Math.ceil((q.right - layerRect.left + 12) * k);
        for (let y = Math.floor(lineTop * k); y < Math.ceil(lineBot * k); y += 1) {
          for (let x = Math.max(0, x0); x < Math.min(bmp.width, x1); x += 1) {
            const o = (y * bmp.width + x) * 4;
            if (px[o + 3] > 128 && (px[o] + px[o + 1] + px[o + 2]) / 3 < 140 && x > ink) ink = x;
          }
        }
        out.push({ tail: str.slice(Math.max(0, end - 8), end), highlightRight: Math.round((q.right - layerRect.left) * 100) / 100, inkRight: ink < 0 ? null : Math.round(((ink + 1) / k) * 100) / 100 });
      }
    }
    return { k, lines: out };
  };
  K.hitScan = async (docId, x, y0, y1, step) => {
    // A 2-D scan: the toggle is a small box, so sweep x too (first column is the caller's).
    for (let y = y0; y <= y1; y += step) {
      for (const xx of [x, 40, 80, 120, 200, 300]) {
        const h = await K.rpc('render.hit', { docId, x: xx, y });
        if (h && h.fold) return { y, x: xx, fold: h.fold };
      }
    }
    window.__mvScanTrace = 'none';
    return null;
  };
  K.cropTile = async (docId, y0, h) => {
    const r = await K.rpc('render.tile', { docId, index: 0 });
    const bin = atob(r.png); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = document.createElement('canvas'); cv.width = Math.min(560, bmp.width); cv.height = Math.min(h, bmp.height - y0);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(bmp, 0, y0, cv.width, cv.height, 0, 0, cv.width, cv.height);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0; const colours = new Set();
    for (let i = 0; i < px.length; i += 4) { if ((px[i] + px[i + 1] + px[i + 2]) / 3 < 140) ink += 1; if (colours.size < 50) colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]); }
    return { tile: [bmp.width, bmp.height], crop: [cv.width, cv.height], ink, colours: colours.size, png: cv.toDataURL('image/png').split(',')[1] };
  };
  K.wordWidths = (mode, head) => {
    const c = K.ctx(mode);
    if (!c) return null;
    const hit = K.find(c, head);
    if (!hit) return null;
    const text = hit[0].data;
    const out = [];
    let i = hit[1];
    const words = text.slice(i).split(/(\s+)/).filter((w) => w && !/^\s+$/.test(w)).slice(0, 8);
    for (const w of words) {
      const at = text.indexOf(w, i);
      const r = c.doc.createRange(); r.setStart(hit[0], at); r.setEnd(hit[0], at + w.length);
      out.push([w, Math.round(r.getBoundingClientRect().width * 100) / 100]);
      i = at + w.length;
    }
    return out;
  };
  K.selectAllCopyTimed = async (modKey, marker) => {
    const t0 = performance.now();
    K.spy('blitz');
    const root = document.querySelector('[data-testid="blitz-email-body"]');
    root.focus({ preventScroll: true });
    const ev = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true, composed: true, [modKey]: true });
    document.activeElement.dispatchEvent(ev);
    let selectMs = -1;
    while (performance.now() - t0 < 20000) {
      if (String(window.getSelection()).includes(marker)) { selectMs = performance.now() - t0; break; }
      await sleep(5);
    }
    let firstCopyMs = null; let richMs = null; let attempts = 0; let firstSpy = null;
    const log = [];
    // Few copies: each one that misses the cache also starts a promise ClipboardItem write.
    for (const rel of [0, 150, 300, 500, 800, 1200, 1600, 2000, 3000, 5000, 8000]) {
      if (selectMs < 0) break;
      const at = selectMs + rel;
      const wait = at - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
      const r = K.copy('blitz');
      const now = performance.now() - t0;
      attempts += 1;
      const hasHtml = !!(r && r.spy && r.spy.html);
      log.push([Math.round(now - selectMs), hasHtml]); // ms after the selection was complete
      if (firstCopyMs === null) { firstCopyMs = now - selectMs; firstSpy = r && r.spy ? { types: r.spy.types, plainLen: (r.spy.plain || '').length } : null; }
      if (hasHtml) { richMs = now - selectMs; break; }
    }
    return { selectMs: Math.round(selectMs), firstCopyMs: firstCopyMs === null ? null : Math.round(firstCopyMs), richMs: richMs === null ? null : Math.round(richMs), attempts, firstSpy, tries: log, selectionLenAtEnd: String(window.getSelection()).length, spans: document.querySelectorAll('[data-testid="blitz-text-layer"] span').length };
  };
  K.rpcTime = async (method, params, times) => {
    const out = [];
    for (let i = 0; i < (times || 1); i += 1) {
      const t0 = performance.now();
      let r; try { r = await K.rpc(method, params); } catch (e) { r = { error: String((e && e.message) || e) }; }
      out.push({ ms: Math.round((performance.now() - t0) * 10) / 10, keys: r && typeof r === 'object' ? Object.keys(r).slice(0, 4) : typeof r, link: r && r.link ? r.link.href : null, fold: r && r.fold ? r.fold : null, error: r && r.error ? r.error : null });
    }
    return out;
  };
  K.scanTrace = () => window.__mvScanTrace || null;
  return true;
}
/* eslint-enable */

let kitReady = false;
async function ensureKit() {
  const ok = await browser.execute(() => !!window.__mvc && window.__mvc.v === 9);
  if (!ok) await browser.execute(installKit, TITLE);
  kitReady = true;
}
async function kit(name, ...args) {
  if (!kitReady) await ensureKit();
  const out = await browser.execute((n, a) => (window.__mvc ? { v: window.__mvc[n](...a) } : { missing: true }), name, args);
  if (out && out.missing) { await ensureKit(); return (await browser.execute((n, a) => ({ v: window.__mvc[n](...a) }), name, args)).v; }
  return out.v;
}
async function kitAsync(name, ...args) {
  if (!kitReady) await ensureKit();
  const run = () => browser.executeAsync((n, a, done) => {
    if (!window.__mvc) { done({ missing: true }); return; }
    Promise.resolve().then(() => window.__mvc[n](...a)).then((v) => done({ v }), (e) => done({ error: String((e && e.message) || e) }));
  }, name, args);
  let out = await run();
  if (out && out.missing) { await ensureKit(); out = await run(); }
  if (out && out.error) throw new Error(`${name}: ${out.error}`);
  return out.v;
}
const rpc = (method, params = {}) => browser.executeAsync((m, p, done) => {
  window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: m, params: p })
    .then(done, (e) => done({ __error: String((e && e.message) || e) }));
}, method, params);

// ── Driving the app ─────────────────────────────────────────────────────────

let currentMode = null;
async function setSettingToggle(testid, want) {
  const toggle = await $(`[data-testid="${testid}"]`);
  const on = (await toggle.getAttribute('aria-checked')) === 'true';
  if (on !== want) await toggle.click();
}

async function setRenderer(mode) {
  if (currentMode === mode) return;
  if (currentMode === 'blitz') await kit('iframeWatch', false);
  await openSettings();
  await clickSettingsNav('Appearance');
  await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="setting-email-renderer"]')), { timeout: 10_000, interval: 200 });
  await setSettingToggle('setting-email-renderer', mode === 'blitz');
  await browser.pause(200);
  await closeSettings();
  currentMode = mode;
  await browser.pause(400);
}

async function setAppTheme(want) {
  await openSettings();
  await clickSettingsNav('Appearance');
  const label = en[`settings.colors.${want}`] || (want === 'dark' ? 'Dark' : 'Light');
  await browser.waitUntil(() => browser.execute((l) => !![...document.querySelectorAll('button[aria-pressed]')].find((b) => b.getAttribute('aria-label') === l && b.offsetHeight > 0), label), { timeout: 10_000, interval: 200 });
  await browser.execute((l) => { [...document.querySelectorAll('button[aria-pressed]')].find((b) => b.getAttribute('aria-label') === l && b.offsetHeight > 0)?.click(); }, label);
  await browser.pause(300);
  await closeSettings();
  await browser.pause(500);
}

async function openRow(subject) {
  await browser.waitUntil(() => browser.execute((needle) => {
    const find = () => [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
    const row = find();
    if (row) { row.click(); return true; }
    // Not in the rendered window (a short window loads fewer rows): scroll the list that holds the rows to
    // its end, which also asks for the next page, then back to the top and again.
    const rows = [...document.querySelectorAll('[data-testid="email-row"]')].filter((r) => r.offsetHeight > 0);
    let list = null;
    for (let el = rows.length ? rows[rows.length - 1].parentElement : null; el && !list; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) list = el;
    }
    if (list) {
      const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
      list.scrollTop = atEnd ? 0 : list.scrollHeight;
    }
    return false;
  }, subject), { timeout: 60_000, interval: 400, timeoutMsg: `no row for "${subject}" in ${YODA}'s INBOX` });
}

const READY = { [SUBJECT_A]: 'Reply', [SUBJECT_B]: 'Lora.', [SUBJECT_C]: 'Merriweather.', [SUBJECT_D]: 'Paragraph 0', [SUBJECT_E]: 'Short' };

async function waitReady(mode, subject, timeout = 60_000) {
  let last = null;
  try {
    await browser.waitUntil(async () => { last = await kit('ready', mode, READY[subject]); return !!last && last.ok; }, { timeout, interval: 300 });
  } catch (e) {
    throw new Error(`${subject} never ready in ${mode}: ${JSON.stringify(last)}`);
  }
  return last;
}

/** The shown tiles are all painted and the layout stopped changing (the worker is not behind on tile paints). */
async function waitSettled(timeout = 20_000) {
  let last = null; let stable = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const b = await kit('blitz');
    const ok = b.withSrc >= Math.min(2, b.tiles) && b.loaded === b.withSrc && last && last.rev === b.rev && last.docId === b.docId && last.withSrc === b.withSrc;
    stable = ok ? stable + 1 : 0;
    last = b;
    if (stable >= 3) return Date.now() - t0;
    await browser.pause(150);
  }
  return -1;
}

/** Open `subject` in `mode`, optionally in the other email theme, and wait until it is drawn. */
async function openFixture(mode, subject = SUBJECT_A, theme = 'light') {
  await setRenderer(mode);
  await switchToFolder(YODA, 'INBOX');
  await openRow(subject);
  await waitReady(mode, subject);
  await setEmailTheme(mode, subject, theme);
  if (mode === 'blitz') await kit('iframeWatch', true);
  await kit('clear', mode);
  await browser.pause(300);
}

async function setEmailTheme(mode, subject, want) {
  const before = mode === 'blitz' ? (await kit('blitz')).docId : null;
  const clicked = await browser.execute((label) => {
    for (const b of document.querySelectorAll('button')) {
      if (b.offsetHeight > 0 && ((b.textContent || '').trim() === label || b.getAttribute('aria-label') === label)) { b.click(); return true; }
    }
    return false;
  }, want === 'light' ? 'Light' : 'Dark');
  if (!clicked) return false; // already in that theme (the button names the other)
  await browser.pause(700);
  if (mode === 'blitz') {
    await browser.waitUntil(async () => (await kit('blitz')).docId !== before, { timeout: 20_000, interval: 300 }).catch(() => {});
  }
  await waitReady(mode, subject);
  return true;
}

// ── Copy ────────────────────────────────────────────────────────────────────

/** Select, wait out the debounce and serialize, copy through the page, read the OS clipboard. */
async function copySelection(mode, { wait = 900 } = {}) {
  await kit('spy', mode);
  await browser.pause(wait);
  const mark = sentinel();
  setClip(mark);
  const page = await kit('copy', mode);
  await browser.pause(500);
  const clip = readClip();
  return { page, plain: clip.plain, html: clip.html, flavours: clip.flavours, changed: clip.plain !== mark && clip.plain !== `${mark}\n`, mark };
}

const brief = (c) => ({ ok: c.page && c.page.ok, changed: c.changed, plain: cut(c.plain, 700), html: cut(c.html, 900), flavours: c.flavours, spy: c.page && c.page.spy && { prevented: c.page.spy.prevented, types: c.page.spy.types, plain: cut(c.page.spy.plain, 200), html: cut(c.page.spy.html, 200) }, debug: c.page && c.page.debug });

// ── Pixels (macOS, best effort) ─────────────────────────────────────────────

let shots = null;
async function pixelKit() {
  if (shots) return shots;
  shots = { ok: false, why: '' };
  if (!IS_MAC) { shots.why = 'not macOS: pixels not measured here'; return shots; }
  try {
    process.env.SHOTS_APP_BINARY ||= process.env.TAURI_APP_BINARY || resolve(process.cwd(), 'target/debug/mailvault');
    const cap = await import('../../scripts/screenshots/capture.js');
    const win = await import('../../scripts/screenshots/window.js');
    const { PNG } = await import('pngjs');
    const raised = await win.raiseWindow(1200, 800).catch((e) => `raise failed ${e.message}`);
    await browser.pause(1200);
    const locked = execFileSync('/bin/sh', ['-c', 'ioreg -n Root -d1 -a | plutil -extract IOConsoleUsers.0.CGSSessionScreenIsLocked raw -o - - 2>/dev/null || echo false'], { encoding: 'utf8' }).trim();
    const id = cap.windowId();
    let permission = 'unknown';
    try { permission = execFileSync(resolve(process.cwd(), 'scripts/screenshots/.windowid'), ['--check-permission'], { encoding: 'utf8' }).trim(); } catch { permission = 'denied'; }
    shots = { ok: locked === 'false' && permission === 'granted', why: `locked=${locked} permission=${permission} raised=${raised}`, windowId: cap.windowId, PNG };
  } catch (e) {
    shots = { ok: false, why: `pixel kit failed: ${e.message}` };
  }
  return shots;
}

/** Median RGB around a viewport point, from `screencapture -l`, with the distinct-colour guard. */
async function pixelAt(x, y) {
  const k = await pixelKit();
  if (!k.ok) return { unavailable: k.why };
  const out = resolve(browser.testDataDir, `blitzc-${Date.now()}.png`);
  const dims = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
  execFileSync('screencapture', ['-x', '-o', '-t', 'png', '-l', k.windowId(), out]);
  const png = k.PNG.sync.read(readFileSync(out));
  const scale = png.width / dims.w;
  const offY = png.height - dims.h * scale;
  const cx = Math.round(x * scale); const cy = Math.round(offY + y * scale);
  const seen = new Set();
  for (let i = 0; i < png.data.length && seen.size < 300; i += 4 * 97) seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  const chans = [[], [], []];
  for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
    const o = (png.width * (cy + dy) + (cx + dx)) << 2;
    for (let c = 0; c < 3; c += 1) chans[c].push(png.data[o + c]);
  }
  const med = chans.map((a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)]);
  return { r: med[0], g: med[1], b: med[2], distinct: seen.size, scale, png: [png.width, png.height], at: [cx, cy] };
}

/** The viewport point between "Reply" and "text" (a space, so no glyph ink under it). */
const gapPoint = async (mode, noReveal = false) => {
  const r = await kit('rect', mode, 'Reply text', 5, 6, noReveal);
  return r ? { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } : null;
};



function renderWorkers() {
  const daemonPid = parseInt(readFileSync(join(appDataDir(browser.testDataDir), 'daemon.pid'), 'utf8').trim(), 10);
  if (IS_MAC) {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
    return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] })).filter((q) => q.ppid === daemonPid && q.cmd.includes('--render-worker')).map((q) => ({ pid: q.pid, ppid: q.ppid, daemonPid }));
  }
  const out = ps(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${daemonPid}" | Where-Object { $_.CommandLine -like '*--render-worker*' } | ForEach-Object { "$($_.ProcessId)" }`);
  return out.split(/\s+/).filter(Boolean).map((q) => ({ pid: Number(q), ppid: daemonPid, daemonPid }));
}
// By pid, of the one child of THIS run's daemon: never by name.
function killWorker(pid) {
  if (IS_MAC) process.kill(pid, 'SIGKILL'); else ps(`Stop-Process -Id ${pid} -Force`);
}

// ── Real keystrokes into the focused app (macOS System Events, Windows SendKeys), best effort ────

function nativeKey(letter) {
  try {
    if (IS_MAC) {
      execFileSync('osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose name is "mailvault" to true'], { timeout: 15_000 });
      const front = execFileSync('osascript', ['-e', 'tell application "System Events" to name of first process whose frontmost is true'], { encoding: 'utf8', timeout: 15_000 }).trim();
      if (!/mailvault/i.test(front)) return `not sent: frontmost is ${front}`;
      execFileSync('osascript', ['-e', `tell application "System Events" to keystroke "${letter}" using command down`], { timeout: 15_000 });
      return 'sent';
    }
    const vk = letter.toUpperCase().charCodeAt(0);
    const out = ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class MvK { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e); }'; $p = Get-Process mailvault -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if (-not $p) { 'no window'; exit 0 }; $h = $p.MainWindowHandle; [MvK]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [void][MvK]::ShowWindow($h, 9); [void][MvK]::SetForegroundWindow($h); [MvK]::keybd_event(0x12,0,2,[UIntPtr]::Zero); Start-Sleep -Milliseconds 400; if ([MvK]::GetForegroundWindow() -ne $h) { 'not foreground'; exit 0 }; [MvK]::keybd_event(0x11,0,0,[UIntPtr]::Zero); [MvK]::keybd_event(${vk},0,0,[UIntPtr]::Zero); [MvK]::keybd_event(${vk},0,2,[UIntPtr]::Zero); [MvK]::keybd_event(0x11,0,2,[UIntPtr]::Zero); 'sent'`).trim();
    if (!out.endsWith('sent')) return `not sent: ${out}`;
    return 'sent';
  } catch (e) { return `failed: ${String(e.message).slice(0, 160)}`; }
}

// ── The spec ────────────────────────────────────────────────────────────────

describe('Blitz plan C: interactions, iframe vs Blitz', function () {
  this.timeout(900_000);

  let priorSettings = null;
  let clipboardWorks = false;
  const base = {}; // iframe baselines kept for later sections
  const fails = [];

  const section = async (name, body) => {
    const issues = [];
    const ck = (cond, msg) => { if (!cond) issues.push(msg); };
    try { await body(ck, issues); } finally {
      if (issues.length) { log(`${name}.issues`, issues); fails.push(...issues.map((m) => `${name}: ${m}`)); }
    }
    expect(issues).toEqual([]);
  };

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await ensureKit();
    log('commit', { head: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })() });
    log('host', await browser.execute(() => ({
      ua: navigator.userAgent, platform: navigator.platform, dpr: window.devicePixelRatio,
      inner: [window.innerWidth, window.innerHeight], dataTheme: document.documentElement.getAttribute('data-theme'),
    })));
    log('raf', { callbacksIn1s: await kitAsync('rafProbe') });

    await withMailbox('INBOX', async (client) => {
      for (const m of MAILS) {
        await client.append('INBOX', htmlMail({ subject: m.subject, messageId: MSGIDS[m.id], from: m.from, day: m.day, html: m.html }), ['\\Seen'], new Date(`2020-01-0${2 + m.id}T12:00:00Z`));
      }
    });
    priorSettings = await browser.execute(() => {
      const s = window.__SETTINGS_STORE__.getState();
      return { billingProfile: s.billingProfile ?? null, trackerBlockingEnabled: !!s.trackerBlockingEnabled, emailRenderer: s.emailRenderer };
    });
    await switchToFolder(YODA, 'INBOX');
    await setAppTheme('light');

    // Positive control: can this host's page write the OS clipboard through execCommand('copy')?
    const mark = sentinel();
    setClip(mark);
    const ctl = await browser.execute(() => {
      const ta = document.createElement('textarea');
      ta.value = 'blitzc-clipboard-control'; document.body.appendChild(ta); ta.select();
      let ok; try { ok = document.execCommand('copy'); } catch (e) { ok = `threw ${e.message}`; }
      ta.remove();
      return { ok, hasFocus: document.hasFocus(), visibility: document.visibilityState };
    });
    await browser.pause(400);
    const got = readClip();
    clipboardWorks = got.plain.trim() === 'blitzc-clipboard-control';
    log('clipboard.control', { ...ctl, readBack: cut(got.plain, 60), worksThroughExecCommand: clipboardWorks, flavours: got.flavours });
  });

  after(async function () {
    try { await closeComposeHard(); } catch { /* app gone */ }
    try {
      await browser.execute((prior) => {
        window.__SETTINGS_STORE__.setState({ billingProfile: prior.billingProfile, trackerBlockingEnabled: prior.trackerBlockingEnabled });
      }, priorSettings);
    } catch { /* app gone */ }
    try { await setRenderer('web'); } catch { /* app gone */ }
    try { await setAppTheme('light'); } catch { /* app gone */ }
    try {
      const { host, port } = browser.mockImap[YODA_SERVER];
      const probe = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
      await probe.connect();
      const boxes = (await probe.list()).map((b) => b.path);
      await probe.logout();
      for (const path of boxes) {
        try {
          await withMailbox(path, async (client) => {
            const uids = [];
            for (const id of MSGIDS) uids.push(...await client.search({ header: { 'message-id': `<${id}>` } }, { uid: true }));
            uids.push(...await client.search({ header: { subject: 'Blitz C' } }, { uid: true }));
            if (uids.length) await client.messageDelete([...new Set(uids)], { uid: true });
          });
        } catch { /* mailbox not selectable */ }
      }
    } catch (e) {
      console.warn('[blitzC] could not purge the fixtures:', e.message);
    }
    log('summary', { issues: fails });
  });

  // ── Fonts: Blitz FIRST, so the Lora download lands while the body is open ──

  it('8a. Google font arrives late: same doc, new rev, probe reflows without a re-open', async function () {
    await section('gfont.late', async (ck) => {
      const list0 = await rpc('fonts.list');
      const installed0 = (list0.fonts || []).map((f) => f.family);
      ck(!installed0.includes('Lora'), 'precondition: Lora already installed');
      await setRenderer('blitz');
      await switchToFolder(YODA, 'INBOX');
      await openRow(SUBJECT_B);
      const samples = [];
      const t0 = Date.now();
      for (let i = 0; i < 120; i += 1) {
        const b = await kit('blitz');
        const w = await kit('probeWidth', PROBE);
        if (w.groups >= 2 && b.docId) samples.push({ t: Date.now() - t0, docId: b.docId, rev: b.rev, lora: Math.round(w.lora * 100) / 100, georgia: Math.round(w.georgia * 100) / 100 });
        const tail = samples.slice(-8);
        if (samples.length > 8 && tail.every((x) => x.rev === tail.at(-1).rev && x.lora === tail.at(-1).lora)
          && (tail.at(-1).rev !== samples[0].rev || Date.now() - t0 > 40_000)) break;
        await browser.pause(250);
      }
      const list1 = await rpc('fonts.list');
      const changes = samples.filter((x, i) => i === 0 || x.rev !== samples[i - 1].rev || x.lora !== samples[i - 1].lora || x.docId !== samples[i - 1].docId || i === samples.length - 1);
      log('gfont.late', { samples: samples.length, changes, installedAfter: (list1.fonts || []).map((f) => f.family), downloading: list1.downloading });
      ck(samples.length > 0, 'the probe was never drawn');
      if (!samples.length) return;
      const last = samples.at(-1);
      // A doc can be re-opened once while the pane settles (a width change); the font must then reflow THAT doc in place.
      const seg = samples.filter((x) => x.docId === last.docId);
      const first = seg[0];
      log('gfont.late.segments', { docIds: [...new Set(samples.map((x) => x.docId))], lastSegment: seg.length });
      base.loraBlitz = last.lora;
      ck(last.rev !== first.rev, `rev never bumped (${first.rev}); first sample may already hold the font: ${JSON.stringify(first)}`);
      ck(Math.abs(last.lora - first.lora) > 3, `probe did not reflow (${first.lora} -> ${last.lora})`);
      ck(Math.abs(last.lora - last.georgia) > 3, `final Lora probe is as wide as the Georgia control (${last.lora} vs ${last.georgia})`);
      ck((list1.fonts || []).some((f) => f.family === 'Lora'), 'Lora never installed');
    });
  });

  it('8b. Lora probe is as wide in Blitz as in the iframe (within 2 px)', async function () {
    await section('gfont.width', async (ck) => {
      await openFixture('web', SUBJECT_B);
      let web = null;
      await browser.waitUntil(async () => {
        web = await browser.execute(() => {
          const f = [...document.querySelectorAll('iframe')].find((x) => x.offsetHeight > 0);
          const d = f && f.contentDocument;
          const lora = d && d.getElementById('mv-c-lora-probe'); const geo = d && d.getElementById('mv-c-georgia-probe');
          return lora ? { lora: lora.getBoundingClientRect().width, georgia: geo.getBoundingClientRect().width, loaded: [...d.fonts].filter((x) => x.family.includes('Lora') && x.status === 'loaded').length } : null;
        });
        return web && web.loaded > 0 && Math.abs(web.lora - web.georgia) > 3;
      }, { timeout: 45_000, interval: 500 }).catch(() => {});
      await openFixture('blitz', SUBJECT_B);
      await browser.pause(2500);
      const w = await kit('probeWidth', PROBE);
      const fl = await rpc('fonts.list');
      const words = { web: null, blitz: await kit('wordWidths', 'blitz', 'Sphinx of') };
      const probeTop = await kit('rect', 'blitz', 'Sphinx of');
      const origin = await kit('layerOrigin');
      const b = await kit('blitz');
      const crop = b.docId ? await kitAsync('cropTile', b.docId, 0, 210) : null;
      void probeTop; void origin;
      log('gfont.width.detail', { loraFonts: (fl.fonts || []).filter((f) => f.family === 'Lora').map((f) => ({ family: f.family, bytes: f.bytes, faces: (f.files || []).length })), wordsBlitz: words.blitz, crop });
      await openFixture('web', SUBJECT_B);
      words.web = await kit('wordWidths', 'web', 'Sphinx of');
      log('gfont.width.words', words);
      await openFixture('blitz', SUBJECT_B);
      log('gfont.width', { web, blitz: w, blitzFirstRun: base.loraBlitz });
      ck(!!web && web.loaded > 0, 'the iframe never loaded Lora');
      if (web) ck(Math.abs(web.lora - w.lora) <= 2, `widths differ: iframe ${web.lora} vs blitz ${w.lora}`);
    });
  });

  it('8c. tracker blocking: neither renderer downloads a new family (Merriweather), blocking off does', async function () {
    await section('gfont.blocking', async (ck) => {
      await browser.execute((billing) => window.__SETTINGS_STORE__.setState({ billingProfile: billing, trackerBlockingEnabled: true }), PREMIUM);
      try {
        const fontsNow = async () => { const l = await rpc('fonts.list'); return { installed: (l.fonts || []).map((f) => f.family), downloading: l.downloading || [] }; };
        const before = await fontsNow();
        ck(!before.installed.includes('Merriweather'), 'precondition: Merriweather already installed');
        for (const mode of ['blitz', 'web']) {
          await openFixture(mode, SUBJECT_C);
          await browser.pause(8000);
          const after = await fontsNow();
          const faces = mode === 'web'
            ? await browser.execute(() => { const f = [...document.querySelectorAll('iframe')].find((x) => x.offsetHeight > 0); return f ? [...f.contentDocument.fonts].map((x) => x.family) : null; })
            : null;
          log(`gfont.blocking.${mode}`, { fonts: after, ifameFaces: faces });
          ck(!after.installed.includes('Merriweather') && !after.downloading.includes('Merriweather'), `${mode}: Merriweather fetched under tracker blocking`);
        }
        await browser.execute((prior) => window.__SETTINGS_STORE__.setState({ billingProfile: prior.billingProfile, trackerBlockingEnabled: prior.trackerBlockingEnabled }), priorSettings);
        await openFixture('web', SUBJECT_E);
        await openFixture('blitz', SUBJECT_C);
        let fonts = null;
        await browser.waitUntil(async () => { fonts = await fontsNow(); return fonts.installed.includes('Merriweather'); }, { timeout: 45_000, interval: 1000 }).catch(() => {});
        log('gfont.blocking.control', fonts);
        ck(!!fonts && fonts.installed.includes('Merriweather'), 'control: with blocking off Blitz did not download Merriweather');
      } finally {
        await browser.execute((prior) => window.__SETTINGS_STORE__.setState({ billingProfile: prior.billingProfile, trackerBlockingEnabled: prior.trackerBlockingEnabled }), priorSettings);
      }
    });
  });

  // ── 1. Copy across a folded quote ─────────────────────────────────────────

  it('1. copy across a folded quote: iframe vs Blitz (plain + html)', async function () {
    await section('copy.foldedQuote', async (ck) => {
      const got = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        ck(await kit('select', mode, 'On Fri', 'After'), `${mode}: select failed`);
        got[mode] = await copySelection(mode);
      }
      log('copy.foldedQuote', { web: brief(got.web), blitz: brief(got.blitz) });
      ck(got.web.changed, 'iframe copy did not reach the OS clipboard (harness)');
      ck(got.blitz.changed, 'Blitz copy did not reach the OS clipboard');
      if (got.web.changed && got.blitz.changed) {
        log('copy.foldedQuote.verdict', {
          quoteTextInIframePlain: got.web.plain.includes('Quoted line one'), quoteTextInBlitzPlain: got.blitz.plain.includes('Quoted line one'),
          quoteTextInIframeHtml: got.web.html.includes('Quoted line one'), quoteTextInBlitzHtml: got.blitz.html.includes('Quoted line one'),
          toggleGlyphInIframePlain: got.web.plain.includes('⋯'), toggleGlyphInBlitzPlain: got.blitz.plain.includes('⋯'),
          rawPlainDiff: firstDiff(norm(got.web.plain), norm(got.blitz.plain)), rawHtmlTextDiff: firstDiff(visible(got.web.html), visible(got.blitz.html)),
        });
        ck(!got.web.plain.includes('Quoted line one') && !got.blitz.plain.includes('Quoted line one'), 'a copy across the folded quote carried the hidden quote text');
        ck(norm(noToggle(got.blitz.plain)) === norm(noToggle(got.web.plain)), `plain differs (toggle glyph aside): ${JSON.stringify(firstDiff(norm(noToggle(got.web.plain)), norm(noToggle(got.blitz.plain))))}`);
        ck(noToggle(visible(got.blitz.html)) === noToggle(visible(got.web.html)).replace(/\s*⋯\s*/g, ' ').replace(/\s+/g, ' '), `html text differs: ${JSON.stringify(firstDiff(visible(got.web.html).replace(/\s*⋯\s*/g, ' '), visible(got.blitz.html)))}`);
      }
    });
  });

  it('copy of mixed RTL, emoji and CJK equals the iframe', async function () {
    await section('copy.bidi', async (ck) => {
      const got = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        ck(await kit('select', mode, 'naïve', 'עברית'), `${mode}: select failed`);
        got[mode] = await copySelection(mode);
      }
      log('copy.bidi', { web: brief(got.web), blitz: brief(got.blitz) });
      ck(got.web.changed && got.blitz.changed, 'a copy did not reach the OS clipboard');
      ck(norm(got.blitz.plain) === norm(got.web.plain), `plain differs: ${JSON.stringify(firstDiff(norm(got.web.plain), norm(got.blitz.plain)))}`);
    });
  });

  // ── 2. Nested inline roots ────────────────────────────────────────────────

  it('2. nested inline roots (inline-block link, button): plain copy iframe vs Blitz', async function () {
    await section('copy.nestedInline', async (ck) => {
      const got = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        if (mode === 'web') {
          const dom = await browser.execute(() => { const d = document.querySelector('iframe').contentDocument; const p = d.getElementById('mv-c-cta'); return p ? { html: p.innerHTML.slice(0, 500), buttonSurvived: !!d.getElementById('mv-c-btn'), inlineBlockSurvived: !!d.getElementById('mv-c-cta-a') } : null; });
          log('copy.nestedInline.dom', dom);
          ck(!!dom && dom.inlineBlockSurvived, 'the inline-block link did not survive into the iframe DOM (comparison vacuous)');
        }
        const sel = await kit('select', mode, 'Ctabefore', 'btnafter.');
        ck(sel, `${mode}: select failed`);
        got[mode] = await copySelection(mode);
        got[mode].selText = await kit('selText', mode);
      }
      log('copy.nestedInline', { web: brief(got.web), blitz: brief(got.blitz), selText: { web: got.web.selText, blitz: got.blitz.selText } });
      log('copy.nestedInline.diff', {
        plain: firstDiff(norm(got.web.plain), norm(got.blitz.plain)), flat: firstDiff(flat(got.web.plain), flat(got.blitz.plain)),
        words: ['Ctabefore', 'Ctabutton text', 'ctamiddle', 'Btnlabel', 'btnafter.'].map((w) => ({ w, web: got.web.plain.includes(w), blitz: got.blitz.plain.includes(w) })),
        order: { web: ['Ctabefore', 'Ctabutton', 'ctamiddle', 'Btnlabel', 'btnafter'].map((w) => got.web.plain.indexOf(w)), blitz: ['Ctabefore', 'Ctabutton', 'ctamiddle', 'Btnlabel', 'btnafter'].map((w) => got.blitz.plain.indexOf(w)) },
      });
      ck(got.web.changed && got.blitz.changed, 'a copy did not reach the OS clipboard');
      // Report-only: the exact diff above is the finding if they differ.
    });
  });

  // ── 3. Text-layer geometry ────────────────────────────────────────────────

  it('3a. drag-select past a line end into the next paragraph (hit test stands in for the drag)', async function () {
    await section('geometry.drag', async (ck) => {
      const got = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        await kit('rect', mode, 'Wraptext W3 alpha'); // scroll the W2 / W3 boundary into view
        const li2 = await kit('lineInfo', mode, 'Wraptext W2 alpha');
        const li3 = await kit('lineInfo', mode, 'Wraptext W3 alpha');
        const alpha = await kit('rect', mode, 'Wraptext W2 alpha', 12, 17, true);
        if (!li2 || !li3 || !alpha) { ck(false, `${mode}: anchors not found`); continue; }
        const mid = { x: (alpha.left + alpha.right) / 2, y: (alpha.top + alpha.bottom) / 2 };
        const y2 = (li2.top + li2.bottom) / 2; const y3 = (li3.top + li3.bottom) / 2;
        const toEnd = await kit('drag', mode, mid.x, mid.y, li2.rightEdge + 60, y2);
        const toNext = await kit('drag', mode, mid.x, mid.y, li3.left + 4, y3);
        const below = await kit('drag', mode, mid.x, mid.y, li3.rightEdge + 60, y3);
        const rightOfNext = await kit('drag', mode, mid.x, mid.y, li3.rightEdge + 60, y3 - 40);
        got[mode] = { line2: { text: li2.text, left: li2.left, rightEdge: li2.rightEdge }, line3: { text: li3.text, rightEdge: li3.rightEdge }, toEnd, toNext, belowRightOfEnd: below, rightOfLine: rightOfNext };
      }
      log('geometry.drag', got);
      for (const mode of ['web', 'blitz']) {
        const g = got[mode];
        if (!g || !g.toEnd) continue;
        const end = flat(g.line2.text);
        ck(end.endsWith(flat(g.toEnd.text)) && flat(g.toEnd.text).length > 0, `${mode}: a drag to the right of the line end did not stop at the line end: selected "${cut(g.toEnd.text, 60)}", the line is "${cut(end, 60)}"`);
        ck(!flat(g.toNext.text).includes('Wraptext W3') && flat(g.toNext.text).endsWith('omicron.'), `${mode}: a drag to the start of the next paragraph ended elsewhere: "${cut(g.toNext.text, 80)}"`);
        ck(flat(g.belowRightOfEnd.text).endsWith(flat(g.line3.text)), `${mode}: a drag below-right of the line end did not end at the next line end: "${cut(g.belowRightOfEnd.text.slice(-60), 80)}" vs "${cut(g.line3.text, 60)}"`);
      }
    });
  });

  it('3b. triple-click a paragraph that straddles y=512 (paragraph selection by Selection.modify)', async function () {
    await section('geometry.triple', async (ck) => {
      await openFixture('blitz');
      const info = await browser.execute(() => {
        const layer = document.querySelector('[data-testid="blitz-text-layer"]');
        const byNode = new Map();
        for (const tile of layer.querySelectorAll('[data-tile]')) {
          for (const s of tile.querySelectorAll('span[data-node]')) {
            const e = byNode.get(s.dataset.node) || { tiles: new Set(), text: '' };
            e.tiles.add(tile.dataset.tile); e.text += s.textContent; byNode.set(s.dataset.node, e);
          }
        }
        return [...byNode.entries()].filter(([, v]) => v.tiles.size > 1).map(([node, v]) => ({ node, tiles: [...v.tiles], text: v.text.slice(0, 80), len: v.text.length }));
      });
      log('geometry.straddlers', info);
      ck(info.length > 0, 'no paragraph straddles the first tile boundary in this layout (fixture cannot test it)');
      if (!info.length) return;
      const target = info[0];
      const wi = /W(\d+)/.exec(target.text);
      const needle = wi ? `Wraptext W${wi[1]} ` : target.text.slice(0, 20);
      const expectFull = flat(`Wraptext W${wi ? wi[1] : '?'} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron.`);
      const out = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        await kit('rect', mode, needle); // scroll the paragraph into view
        const lines = await kit('lines', mode, needle);
        if (!lines || !lines.length) { out[mode] = { error: 'no lines' }; continue; }
        const pick = (l) => ({ x: (l.left + l.right) / 2, y: (l.top + l.bottom) / 2 });
        const first = pick(lines[0]); const last = pick(lines[lines.length - 1]);
        const ofLine = (i) => pick(lines[Math.min(i, lines.length - 1)]);
        const results = [];
        for (const [name, pt] of [['firstLine', first], ['midLine', ofLine(Math.floor(lines.length / 2))], ['lastLine', last]]) {
          const r = await kit('paragraphAt', mode, pt.x, pt.y);
          results.push({ name, y: Math.round(pt.y), text: r && (r.unsupported ? 'unsupported' : cut(r.text, 400)), full: !!r && flat(r.text) === expectFull, len: r && r.text ? flat(r.text).length : null });
        }
        out[mode] = { lineCount: lines.length, results };
      }
      log('geometry.triple', { target, expectedLen: expectFull.length, out });
      for (const mode of ['web', 'blitz']) {
        const o = out[mode];
        if (!o || o.error) { ck(false, `${mode}: ${o && o.error}`); continue; }
        for (const r of o.results) ck(r.full || r.text === 'unsupported', `${mode} ${r.name}: triple-click selected ${r.len} of ${expectFull.length} chars`);
      }
    });
  });

  it('3c. highlight edge vs glyph edge at wrapped line ends (pixel drift)', async function () {
    await section('geometry.drift', async (ck) => {
      await openFixture('blitz');
      const needles = ['Wraptext W0 ', 'Wraptext W1 '];
      const ink = await kitAsync('inkDrift', needles);
      const rows = (ink.lines || []).filter((l) => l.inkRight != null);
      const drifts = rows.map((l) => Math.round((l.highlightRight - l.inkRight) * 100) / 100);
      const stats = drifts.length ? { n: drifts.length, min: Math.min(...drifts), max: Math.max(...drifts), meanAbs: Math.round((drifts.reduce((a, d) => a + Math.abs(d), 0) / drifts.length) * 100) / 100 } : null;
      log('geometry.drift', { k: ink.k, error: ink.error, stats, lines: ink.lines });
      // Same lines in the iframe: line right edges, for the wrap comparison.
      const wrap = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        const lines = await kit('lines', mode, 'Wraptext W0 alpha');
        wrap[mode] = lines && lines.map((l) => ({ left: Math.round(l.left * 10) / 10, right: Math.round(l.right * 10) / 10, top: Math.round(l.top * 10) / 10 }));
      }
      log('geometry.wrap', { web: wrap.web, blitz: wrap.blitz, lineCount: { web: wrap.web && wrap.web.length, blitz: wrap.blitz && wrap.blitz.length } });
      ck(!!stats, 'no line could be measured');
    });
  });

  // ── 4. Drag then immediate copy; select all ───────────────────────────────

  it('4a. drag-select then IMMEDIATE copy: OS clipboard rich + plain, Blitz vs iframe', async function () {
    await section('copy.immediate', async (ck) => {
      const got = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        await kit('spy', mode);
        const mark = sentinel();
        setClip(mark);
        // Pointer down, selection, pointer up and copy in ONE page turn: no serialize can have landed.
        const page = await browser.execute((mode) => {
          const K = window.__mvc; const c = K.ctx(mode);
          const s = K.find(c, 'Reply'); const e = K.find(c, 'mixed');
          const t = s[0].parentElement;
          const pd = (type) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse', button: 0 }));
          pd('pointerdown');
          const r = c.doc.createRange(); r.setStart(s[0], s[1]); r.setEnd(e[0], e[1] + 5);
          const sel = c.win.getSelection(); sel.removeAllRanges(); sel.addRange(r);
          pd('pointerup');
          return K.copy(mode);
        }, mode);
        await browser.pause(600);
        const clip = readClip();
        got[mode] = { page, plain: clip.plain, html: clip.html, flavours: clip.flavours, changed: clip.plain !== mark };
        // The same selection once serialize had time to land (the rich upgrade is not needed then).
        if (mode === 'blitz') {
          await kit('select', mode, 'Reply', 'mixed');
          got.blitzSettled = await copySelection(mode);
        }
      }
      log('copy.immediate', { web: brief({ ...got.web, page: got.web.page }), blitz: brief({ ...got.blitz, page: got.blitz.page }), blitzSettled: brief(got.blitzSettled) });
      ck(got.web.changed, 'iframe immediate copy did not reach the clipboard (harness)');
      ck(got.blitz.changed, 'Blitz immediate copy left the clipboard untouched');
      ck(norm(got.blitz.plain) === norm(got.web.plain), `immediate plain differs: ${JSON.stringify(firstDiff(norm(got.web.plain), norm(got.blitz.plain)))}`);
      log('copy.immediate.rich', { webHasHtml: !!got.web.html, blitzImmediateHasHtml: !!got.blitz.html, blitzSettledHasHtml: !!got.blitzSettled.html });
      ck(!!got.blitzSettled.html, 'a settled Blitz copy has no HTML flavour');
    });
  });

  it('4b. select all then copy across three tiles, including never-shown tiles', async function () {
    await section('copy.selectAll', async (ck) => {
      const out = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        const before = mode === 'blitz' ? await kit('blitz') : null;
        await kit('spy', mode);
        if (mode === 'web') {
          await browser.execute(() => document.querySelector('iframe').contentDocument.execCommand('selectAll'));
        } else {
          await browser.execute((mod) => { window.__mvc.key('blitz', 'a', { [mod === 'meta' ? 'metaKey' : 'ctrlKey']: true }); }, MOD);
        }
        let t0 = Date.now();
        let selText = '';
        await browser.waitUntil(async () => { selText = await kit('selText', mode); return selText.includes('ZZLASTZZ'); }, { timeout: 15_000, interval: 200 }).catch(() => {});
        const selectMs = Date.now() - t0;
        t0 = Date.now();
        const c = await copySelection(mode, { wait: 1500 });
        out[mode] = { selectMs, copyMs: Date.now() - t0, tilesBefore: before && { tiles: before.tiles, withSrc: before.withSrc }, selLen: selText.length, sel: c, hasLast: c.plain.includes('ZZLASTZZ'), plainLen: c.plain.length };
      }
      log('copy.selectAll', { web: { ...out.web, sel: brief(out.web.sel) }, blitz: { ...out.blitz, sel: brief(out.blitz.sel) } });
      log('copy.selectAll.diff', { plain: firstDiff(norm(out.web.sel.plain), norm(out.blitz.sel.plain)), flat: firstDiff(flat(out.web.sel.plain), flat(out.blitz.sel.plain)), htmlTextEqual: visible(out.web.sel.html) === visible(out.blitz.sel.html) });
      ck(out.blitz.hasLast, 'Blitz select-all copy lacks the last paragraph');
      ck(out.web.hasLast, 'iframe select-all copy lacks the last paragraph');
      const cmp = (x) => flat(noCta(noToggle(x)));
      ck(cmp(out.blitz.sel.plain) === cmp(out.web.sel.plain), `select-all plain differs (toggle glyphs and the nested-inline paragraph aside): ${JSON.stringify(firstDiff(cmp(out.web.sel.plain), cmp(out.blitz.sel.plain)))}`);
    });
  });

  it('4c. real keystrokes (Cmd/Ctrl+A then Cmd/Ctrl+C) into the focused body: OS clipboard, iframe vs Blitz', async function () {
    await section('copy.nativeKey', async (ck) => {
      const out = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        await kit('focus', mode);
        const mark = sentinel(); setClip(mark);
        const sentA = nativeKey('a');
        await browser.pause(mode === 'blitz' ? 3500 : 800);
        const selLen = (await kit('selText', mode) || '').length;
        const sentC = nativeKey('c');
        await browser.pause(1500);
        const clip = readClip();
        out[mode] = { sentA, sentC, selLen, changed: clip.plain !== mark, hasLast: clip.plain.includes('ZZLASTZZ'), plainLen: clip.plain.length, htmlLen: clip.html.length, flavours: clip.flavours };
      }
      if (out.blitz.sentA !== 'sent' || out.blitz.selLen === 0) { log('copy.nativeKey', { ...out, status: { measured: false, why: `the real keys did not reach the webview: ${out.blitz.sentA} / selection ${out.blitz.selLen}` } }); return; }
      // A drag-selection then a real Cmd+C a moment later.
      await openFixture('blitz');
      await kit('select', 'blitz', 'Reply', 'mixed');
      await kit('focus', 'blitz');
      const mark = sentinel(); setClip(mark);
      const sentC = nativeKey('c');
      await browser.pause(900);
      const clip = readClip();
      out.blitzSelectionCopy = { sentC, changed: clip.plain !== mark, plain: cut(clip.plain, 120), htmlLen: clip.html.length };
      // The 3000-paragraph message through the real keys.
      await openFixture('blitz', SUBJECT_D);
      await kit('focus', 'blitz');
      const mark2 = sentinel(); setClip(mark2);
      const t0 = Date.now();
      const bigA = nativeKey('a');
      let sel = '';
      await browser.waitUntil(async () => { sel = await kit('selText', 'blitz'); return sel.includes('ZZBIGLASTZZ'); }, { timeout: 30_000, interval: 100 }).catch(() => {});
      const selectMs = Date.now() - t0;
      const bigC = nativeKey('c');
      let big = readClip();
      await browser.waitUntil(() => { big = readClip(); return big.plain !== mark2 && big.plain.includes('ZZBIGLASTZZ'); }, { timeout: 20_000, interval: 150 }).catch(() => {});
      out.big = { bigA, bigC, selectMs, totalMs: Date.now() - t0, hasLast: big.plain.includes('ZZBIGLASTZZ'), plainLen: big.plain.length, htmlLen: big.html.length };
      log('copy.nativeKey', out);
      if (out.blitz.sentA !== 'sent' || out.blitz.sentC !== 'sent') { log('copy.nativeKey.status', { measured: false, why: `${out.blitz.sentA} / ${out.blitz.sentC}` }); return; }
      ck(out.blitz.changed && out.blitz.hasLast, 'a real select-all + copy in Blitz did not put the whole body on the clipboard');
      ck(out.blitzSelectionCopy.changed, 'a real copy of a selection in Blitz left the clipboard untouched');
      ck(out.big.hasLast, 'a real select-all + copy of the 3000-paragraph message lacks the last paragraph');
    });
  });

  // ── 5. Selection colours ──────────────────────────────────────────────────

  for (const theme of ['light', 'dark']) {
    it(`5. ${theme}: selection highlight colour, iframe vs Blitz${theme === 'dark' ? ' (Blitz light-only is the Task 15 interim)' : ''}`, async function () {
      await section(`selection.${theme}`, async (ck) => {
        const sample = {};
        for (const mode of ['web', 'blitz']) {
          await openFixture(mode, SUBJECT_A, theme);
          await gapPoint(mode); // scroll the line into view first: a scroll after the selection leaves the window capture stale
          await browser.pause(500);
          ck(await kit('select', mode, 'Reply', 'text with'), `${mode}: select failed`);
          await kit('focus', mode); // an unfocused iframe paints its selection grey; a clicked one paints it active
          await browser.pause(700);
          const p = await gapPoint(mode, true);
          if (!p) { ck(false, `${mode}: no gap point`); continue; }
          sample[mode] = { point: p, active: await pixelAt(p.x, p.y) };
          if (mode === 'blitz') {
            sample.blitzCss = await browser.execute(() => {
              const layer = document.querySelector('[data-testid="blitz-text-layer"]');
              const span = layer.querySelector('span[data-node]');
              const cs = getComputedStyle(span, '::selection');
              return { selBg: layer.style.getPropertyValue('--mv-blitz-sel-bg'), inactiveBg: layer.style.getPropertyValue('--mv-blitz-sel-inactive-bg'), computedSelection: cs.backgroundColor, supportsInactiveKeyword: CSS.supports('color', '-apple-system-unemphasized-selected-text-background'), supportsWindowInactive: (() => { try { document.querySelector(':root::selection:window-inactive'); return 'parsed'; } catch (e) { return `throws ${e.name}`; } })() };
            });
          }
          if (IS_MAC && theme === 'light') {
            try {
              execFileSync('osascript', ['-e', 'tell application "Finder" to activate'], { timeout: 15_000 });
              await browser.pause(900);
              sample[mode].inactive = await pixelAt(p.x, p.y);
            } catch (e) { sample[mode].inactive = { error: String(e.message).slice(0, 120) }; }
            try { execFileSync('osascript', ['-e', 'tell application "System Events" to set frontmost of first process whose name is "mailvault" to true'], { timeout: 15_000 }); } catch { /* best effort */ }
            await browser.pause(600);
          }
        }
        log(`selection.${theme}`, sample);
        const w = sample.web && sample.web.active; const b = sample.blitz && sample.blitz.active;
        if (!w || w.unavailable || !b || b.unavailable) { log(`selection.${theme}.status`, { measured: false, why: (w && w.unavailable) || (b && b.unavailable) || 'no sample' }); return; }
        log(`selection.${theme}.delta`, { web: [w.r, w.g, w.b], blitz: [b.r, b.g, b.b], max: Math.max(Math.abs(w.r - b.r), Math.abs(w.g - b.g), Math.abs(w.b - b.b)) });
        if (theme === 'light' && w.distinct > 50 && b.distinct > 50) {
          for (const kk of ['r', 'g', 'b']) ck(Math.abs(w[kk] - b[kk]) <= 3, `light selection ${kk}: iframe ${w[kk]} vs blitz ${b[kk]}`);
        }
      });
    });
  }

  // ── 6. Reply quote ────────────────────────────────────────────────────────

  it('6. Reply with a selection spanning a <br> block: quoted text iframe vs Blitz', async function () {
    await section('reply.quote', async (ck) => {
      const got = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        ck(await kit('select', mode, 'Brline one', 'Brline three'), `${mode}: select failed`);
        const selText = await kit('selText', mode);
        // What EmailViewer.selectedReplyHtml passes on: replySelection's escape of Selection.toString.
        const quote = await kit('replyQuote', mode);
        await browser.execute(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
        await browser.keys('r'); // the app's reply shortcut: it reads the live selection like the Reply button
        await browser.waitUntil(modalOpen, { timeout: 15_000, interval: 200, timeoutMsg: `${mode}: compose did not open on r` }).catch(() => {});
        await browser.pause(800);
        got[mode] = { selText, quote, composeOpened: await modalOpen() };
        await closeComposeHard();
      }
      log('reply.quote', got);
      log('reply.quote.diff', { toString: firstDiff(got.web.selText, got.blitz.selText), quote: firstDiff(got.web.quote, got.blitz.quote), brInWeb: (got.web.quote.match(/<br>/g) || []).length, brInBlitz: (got.blitz.quote.match(/<br>/g) || []).length });
      for (const m of ['web', 'blitz']) {
        ck(got[m].composeOpened, `${m}: the reply never opened`);
        ck(got[m].quote.includes('Brline one') && got[m].quote.includes('Brline three'), `${m}: the quote lacks the selection: ${got[m].quote}`);
      }
      ck(got.blitz.quote === got.web.quote, `quoted text differs: iframe ${JSON.stringify(got.web.quote)} vs blitz ${JSON.stringify(got.blitz.quote)}`);
    });
  });

  // ── Folds ─────────────────────────────────────────────────────────────────

  it('fold toggles: same label, same height change, no iframe', async function () {
    await section('folds', async (ck) => {
      await openFixture('web');
      const web = await browser.execute(() => {
        const f = document.querySelector('iframe'); const d = f.contentDocument;
        const toggles = [...d.querySelectorAll('[data-quote-toggle], div[style*="cursor"][style*="user-select"]')];
        const h0 = f.getBoundingClientRect().height;
        const labels = toggles.map((t) => t.textContent);
        const q = d.querySelector('[data-quote-toggle]');
        if (q) q.click();
        return { labels, h0, quoteToggles: d.querySelectorAll('[data-quote-toggle]').length };
      });
      await browser.pause(700);
      web.h1 = await browser.execute(() => document.querySelector('iframe').getBoundingClientRect().height);
      await openFixture('blitz');
      const b0 = (await kit('blitz')).cssHeight;
      const wrote = await kit('rect', 'blitz', 'wrote:');
      const b = await kit('blitz');
      const origin = await kit('layerOrigin');
      let scan = null;
      if (wrote && b.docId) scan = await kitAsync('hitScan', b.docId, 14, Math.round(wrote.bottom - 30 - origin.top), Math.round(wrote.bottom + 120 - origin.top), 4);
      if (!scan && wrote) {
        const y0 = Math.max(0, Math.round(wrote.bottom - origin.top - 80));
        log('folds.crop', { y0, h: 160, ...(await kitAsync('cropTile', b.docId, y0, 160)) });
      }
      let h1 = b0;
      if (scan) {
        await kit('clear', 'blitz');
        await kit('fire', 'blitz', 'click', origin.left + scan.x, scan.y + origin.top);
        await browser.waitUntil(async () => (await kit('blitz')).cssHeight !== b0, { timeout: 8000, interval: 200 }).catch(() => {});
        h1 = (await kit('blitz')).cssHeight;
      }
      log('folds', { web, blitz: { b0, b1: h1, scan, wrote, origin, trace: scan ? null : await kit('scanTrace') } });
      ck(web.labels[0] === '⋯', `iframe quote label is ${web.labels[0]}`);
      ck(!!scan, 'no fold toggle found under "wrote:"');
      if (scan) ck(Math.abs((web.h1 - web.h0) - (h1 - b0)) <= 4, `height change differs: iframe ${web.h1 - web.h0} vs blitz ${h1 - b0}`);
      // Copy across the now OPEN quote must include it in both renderers.
      const iframeCount = await kit('iframeSeen', true);
      ck(iframeCount.now === 0 && iframeCount.seen.length === 0, `an iframe appeared in Blitz mode: ${JSON.stringify(iframeCount)}`);
    });
  });

  // ── Menu ──────────────────────────────────────────────────────────────────

  for (const theme of ['light', 'dark']) {
    it(`9. ${theme}: context menu items, colours and clipboard actions, iframe vs Blitz`, async function () {
      await section(`menu.${theme}`, async (ck) => {
        const got = {};
        for (const mode of ['web', 'blitz']) {
          await openFixture(mode, SUBJECT_A, theme);
          await kit('writeTextSpy');
          const r = await kit('rect', mode, 'Link');
          if (!r) { ck(false, `${mode}: no link rect`); continue; }
          const pt = { x: r.left + 10, y: r.top + 5 };
          // Right after the scroll that brought the link into view, as a user would: logged, not asserted.
          const firstFired = await kit('fire', mode, 'contextmenu', pt.x, pt.y, { button: 2 });
          await browser.pause(700);
          const firstMenu = await kit('menu', mode);
          if (mode === 'blitz') { await kit('key', 'blitz', 'Escape'); await browser.pause(200); }
          // Then once the worker has painted what the scroll showed.
          const settledMs = mode === 'blitz' ? await waitSettled() : 0;
          const fired = await kit('fire', mode, 'contextmenu', pt.x, pt.y, { button: 2 });
          await browser.pause(700);
          const menu = await kit('menu', mode);
          const rec = { firstFired, firstItems: firstMenu && firstMenu.items, settledMs, fired, menu };
          if (mode === 'blitz') {
            const org = await kit('layerOrigin'); const bd = await kit('blitz');
            rec.hitLatency = await kitAsync('rpcTime', 'render.hit', { docId: bd.docId, x: pt.x - org.left, y: pt.y - org.top }, 3);
          }
          if (menu) {
            // Copy: with a selection.
            await kit('select', mode, 'Reply', 'text with');
            await browser.pause(900);
            const mark = sentinel(); setClip(mark);
            await kit('spy', mode);
            await kit('resetWt');
            rec.clickCopy = await kit('clickItem', mode, 'Copy');
            await browser.pause(500);
            const c1 = readClip();
            rec.copy = { changed: c1.plain !== mark, plain: cut(c1.plain, 200), htmlLen: c1.html.length };
            // Reopen for Copy Link.
            await kit('fire', mode, 'contextmenu', pt.x, pt.y, { button: 2 });
            await browser.pause(600);
            const mark2 = sentinel(); setClip(mark2);
            await kit('resetWt');
            rec.clickLink = await kit('clickItem', mode, 'Copy Link');
            await browser.pause(500);
            const c2 = readClip();
            rec.copyLink = { changed: c2.plain !== mark2, plain: cut(c2.plain, 200), writeText: await browser.execute(() => window.__mvWt) };
            // Reopen for Select All.
            await kit('clear', mode);
            await kit('fire', mode, 'contextmenu', pt.x, pt.y, { button: 2 });
            await browser.pause(600);
            rec.clickAll = await kit('clickItem', mode, 'Select All');
            await browser.pause(1500);
            rec.selectAll = { len: (await kit('selText', mode)).length, hasLast: (await kit('selText', mode)).includes('ZZLASTZZ') };
          }
          got[mode] = rec;
        }
        log(`menu.${theme}`, got);
        if (!got.web || !got.blitz || !got.web.menu || !got.blitz.menu) { ck(false, 'a menu did not open'); return; }
        ck(JSON.stringify(got.blitz.menu.items) === JSON.stringify(got.web.menu.items), `items differ: ${JSON.stringify({ web: got.web.menu.items, blitz: got.blitz.menu.items })}`);
        ck(got.blitz.menu.inWindow, 'Blitz menu not fully inside the window');
        if (theme === 'light') {
          for (const kk of ['bg', 'border', 'color']) {
            const bb = rgb(got.blitz.menu[kk]); const ww = rgb(got.web.menu[kk]);
            bb.forEach((v, i) => ck(Math.abs(v - ww[i]) <= 1, `light menu ${kk}: ${got.web.menu[kk]} vs ${got.blitz.menu[kk]}`));
          }
        } else {
          log('menu.dark.expected', { note: 'Blitz menu is light-only until plan B (Task 15 interim)', web: got.web.menu.bg, blitz: got.blitz.menu.bg });
        }
        if (theme === 'light') {
          ck(norm(got.web.copy.plain) === 'Reply text with', `iframe menu Copy put ${JSON.stringify(got.web.copy.plain)} on the clipboard`);
          ck(norm(got.blitz.copy.plain) === norm(got.web.copy.plain), `menu Copy clipboard differs: ${JSON.stringify(firstDiff(norm(got.web.copy.plain), norm(got.blitz.copy.plain)))}`);
          const wl = got.web.copyLink.writeText && got.web.copyLink.writeText.calls[0]; const bl = got.blitz.copyLink.writeText && got.blitz.copyLink.writeText.calls[0];
          ck(!!wl && !!bl && wl.text === bl.text, `Copy Link text differs: ${JSON.stringify({ web: wl, blitz: bl })}`);
          ck(got.blitz.selectAll.hasLast && got.web.selectAll.hasLast, `Select All did not reach the last paragraph: ${JSON.stringify({ web: got.web.selectAll, blitz: got.blitz.selectAll })}`);
        }
      });
    });
  }

  it('9b. context menu on a SHORT body is fully visible with 3 items', async function () {
    await section('menu.short', async (ck) => {
      const out = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode, SUBJECT_E);
        const r = await kit('rect', mode, 'link');
        const body = mode === 'blitz' ? await kit('blitz') : null;
        if (!r) { ck(false, `${mode}: no link`); continue; }
        await kit('fire', mode, 'contextmenu', r.left + 4, r.top + 4, { button: 2 });
        await browser.pause(700);
        out[mode] = { bodyHeight: body && body.cssHeight, link: r, menu: await kit('menu', mode) };
      }
      log('menu.short', out);
      const m = out.blitz && out.blitz.menu;
      ck(!!m, 'no Blitz menu on the short body');
      if (m) {
        ck(m.items.length === 3, `items: ${JSON.stringify(m.items)}`);
        ck(m.inWindow, `menu outside the window: ${JSON.stringify(m.rect)}`);
        ck(m.itemInfo.every((i) => i.inWindow && i.reachable), `an item is clipped or covered: ${JSON.stringify(m.itemInfo)}`);
        ck(out.blitz.bodyHeight < 120, `fixture is not short (${out.blitz.bodyHeight}px)`);
      }
    });
  });

  // ── Search marks and the no-iframe invariant ──────────────────────────────

  it('search marks: same count in the iframe and in Blitz; no iframe while the query changes', async function () {
    await section('search', async (ck) => {
      const got = {};
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        await kit('iframeSeen', true);
        await browser.execute(() => window.__SEARCH_STORE__.setState({ searchActive: true, searchQuery: 'quote' }));
        await browser.pause(1800);
        if (mode === 'web') {
          got.web = await browser.execute(() => { const d = document.querySelector('iframe').contentDocument; const m = [...d.querySelectorAll('mark.mv-search-hit')]; const vis = m.filter((x) => x.getClientRects().length > 0); return { count: m.length, visibleCount: vis.length, hiddenInFoldedQuote: m.length - vis.length, bg: m[0] ? d.defaultView.getComputedStyle(m[0]).backgroundColor : null }; });
        } else {
          await waitReady('blitz', SUBJECT_A);
          await browser.execute((mod) => { window.__mvc.key('blitz', 'a', { [mod === 'meta' ? 'metaKey' : 'ctrlKey']: true }); }, MOD);
          await browser.pause(2500);
          const copy = await copySelection('blitz', { wait: 1200 });
          const marks = (copy.html.match(/<mark\b/g) || []).length;
          const classHits = (copy.html.match(/mv-search-hit/g) || []).length;
          got.blitz = { markTags: marks, classHits, htmlLen: copy.html.length, sample: cut(copy.html.slice(copy.html.indexOf('<mark')), 300), iframes: (await kit('blitz')).iframes };
          for (const q of ['reply', 'quote and', 'zzzzzz']) {
            await browser.execute((qq) => window.__SEARCH_STORE__.setState({ searchActive: true, searchQuery: qq }), q);
            await browser.pause(700);
            const s = await kit('iframeSeen');
            ck(s.now === 0 && s.seen.length === 0, `an iframe appeared while searching "${q}": ${JSON.stringify(s)}`);
          }
        }
        await browser.execute(() => window.__SEARCH_STORE__.setState({ searchActive: false, searchQuery: '' }));
        await browser.pause(600);
      }
      log('search', got);
      // The filler holds "quote" 40 times plus the fold line and quoted text; the count is the iframe's.
      if (got.web && got.blitz) {
        if (got.blitz.markTags === 0 && got.blitz.classHits === 0) log('search.status', { note: 'serialize html carries no marks: Blitz mark count not measurable this way', iframeCount: got.web.count });
        else ck(got.blitz.markTags === got.web.visibleCount, `visible mark count: iframe ${got.web.visibleCount} (of ${got.web.count}) vs blitz ${JSON.stringify(got.blitz)}`);
      }
    });
  });

  it('10. no <iframe> anywhere in Blitz mode: light and dark app theme, selecting, copying, menu, folds', async function () {
    await section('noiframe', async (ck) => {
      const rows = [];
      for (const appTheme of ['light', 'dark']) {
        await setAppTheme(appTheme);
        await openFixture('blitz', SUBJECT_A, appTheme);
        await kit('iframeSeen', true);
        const step = async (name) => rows.push({ appTheme, name, ...(await kit('iframeSeen')) });
        await step('opened');
        await kit('select', 'blitz', 'Reply', 'text with'); await step('selected');
        await copySelection('blitz', { wait: 500 }); await step('copied');
        const r = await kit('rect', 'blitz', 'Link');
        await kit('fire', 'blitz', 'contextmenu', r.left + 8, r.top + 4, { button: 2 }); await browser.pause(500); await step('menu');
        await kit('key', 'blitz', 'Escape'); await browser.pause(300);
        await setEmailTheme('blitz', SUBJECT_A, appTheme === 'light' ? 'dark' : 'light'); await step('emailThemeFlip');
        await browser.execute(() => window.__SEARCH_STORE__.setState({ searchActive: true, searchQuery: 'filler' }));
        await browser.pause(900); await step('searched');
        await browser.execute(() => window.__SEARCH_STORE__.setState({ searchActive: false, searchQuery: '' }));
        await browser.pause(500);
      }
      await setAppTheme('light');
      log('noiframe', rows.map((x) => ({ appTheme: x.appTheme, name: x.name, now: x.now, seen: x.seen.length })));
      ck(rows.every((x) => x.now === 0 && x.seen.length === 0), `an iframe existed in Blitz mode: ${JSON.stringify(rows.filter((x) => x.now || x.seen.length))}`);
    });
  });

  // ── Keys ──────────────────────────────────────────────────────────────────

  it('7. keys: k / j / e / # do nothing while the body has focus, Escape clears (Blitz), Cmd+A selects only the body', async function () {
    await section('keys', async (ck) => {
      const subject = () => browser.execute(() => (window.__MAIL_STORE__.getState().selectedEmail?.subject) || null);
      const got = {};
      const modKey = { [MOD === 'meta' ? 'metaKey' : 'ctrlKey']: true };
      for (const mode of ['web', 'blitz']) {
        await openFixture(mode);
        const rec = { before: await subject() };
        // Positive control: the same j on the document moves the selection, or "did nothing" proves nothing.
        const ctl = {};
        for (const k of ['k', 'j', 'e', '#']) {
          const r = await kit('key', mode, k);
          await browser.pause(500);
          ctl[k] = { ...r, subjectAfter: await subject() };
        }
        rec.inBody = ctl;
        await kit('select', mode, 'Reply', 'text with');
        const esc = await kit('key', mode, 'Escape');
        await browser.pause(300);
        rec.escape = { ...esc, selectionAfter: (await kit('selText', mode)).length };
        await kit('select', mode, 'Reply', 'text with');
        const all = await kit('key', mode, 'a', modKey);
        // A synthetic keydown has no native default action: the iframe's own select-all is execCommand.
        if (mode === 'web') await browser.execute(() => document.querySelector('iframe').contentDocument.execCommand('selectAll'));
        await browser.pause(mode === 'blitz' ? 2500 : 300);
        const sel = await kit('selText', mode);
        rec.cmdA = { ...all, selLen: sel.length, hasLast: sel.includes('ZZLASTZZ'), hasListText: sel.includes(SUBJECT_B) };
        got[mode] = rec;
      }
      // Positive control on the document itself (outside the body).
      await openFixture('blitz');
      await browser.execute(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
      const s0 = await subject();
      await browser.execute(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true, cancelable: true })));
      await browser.pause(900);
      got.control = { before: s0, afterKonDocument: await subject() };
      const stillThere = await browser.execute((subj) => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => (r.innerText || '').includes(subj)), SUBJECT_A);
      log('keys', { ...got, fixtureStillInInbox: stillThere });
      ck(got.control.before !== got.control.afterKonDocument, 'positive control failed: k on the document did not move the selection (A is the oldest message, so only k can move)');
      for (const mode of ['web', 'blitz']) {
        const r = got[mode];
        ck(['k', 'j', 'e', '#'].every((k) => r.inBody[k].subjectAfter === r.before), `${mode}: an app shortcut fired while the body had focus: ${JSON.stringify(r.inBody)}`);
        ck(r.cmdA.hasLast, `${mode}: Cmd/Ctrl+A did not select the whole body`);
        ck(!r.cmdA.hasListText, `${mode}: select-all escaped the body`);
      }
      ck(got.blitz.escape.selectionAfter === 0, 'Blitz Escape did not clear the selection');
      log('keys.escapeBaseline', { iframeSelectionAfterEscape: got.web.escape.selectionAfter, note: 'iframe keeps its selection on Escape when only a synthetic keydown is sent; Blitz clearing it is the deliberate difference' });
    });
  });

  // ── Foreground feel, big message ──────────────────────────────────────────

  it('11a. select-all copy on a 3000-paragraph message completes in under 2 s', async function () {
    await section('perf.big', async (ck) => {
      await openFixture('blitz', SUBJECT_D);
      const b = await kit('blitz');
      const per = await kitAsync('rpcTime', 'render.textRuns', { docId: b.docId, index: 60 }, 3);
      const mark = sentinel(); setClip(mark);
      // Timed in the page (no OS-clipboard round trips inside the clock): Cmd/Ctrl+A, the whole selection, then
      // a few copies up to 20 s until the copy event carries the rich flavour (the cache is warm).
      await browser.setTimeout({ script: 120_000 });
      const t = await kitAsync('selectAllCopyTimed', MOD === 'meta' ? 'metaKey' : 'ctrlKey', 'ZZBIGLASTZZ');
      await browser.setTimeout({ script: 30_000 });
      let clip = readClip();
      await browser.waitUntil(() => { clip = readClip(); return clip.plain !== mark && clip.plain.includes('ZZBIGLASTZZ'); }, { timeout: 30_000, interval: 300 }).catch(() => {});
      log('perf.big', { tiles: b.tiles, cssHeight: b.cssHeight, textRunsRoundTrips: per, ...t, copiedHasLast: clip.plain.includes('ZZBIGLASTZZ'), plainLen: clip.plain.length, htmlLen: clip.html.length });
      ck(clip.plain.includes('ZZBIGLASTZZ'), 'the copy lacks the last paragraph');
      ck(t.selectMs >= 0 && t.richMs !== null && t.selectMs + t.richMs < 2000, `select-all copy took ${t.selectMs} ms to select and ${t.richMs} ms more until the rich flavour; first copy ${t.firstCopyMs} ms after the selection`);
    });
  });

  it('11b. foreground feel under indexing: a fold click and a message switch do not lag', async function () {
    await section('perf.foreground', async (ck) => {
      const status = () => rpc('search_index_status');
      const timings = async () => {
        await openFixture('blitz');
        const wrote = await kit('rect', 'blitz', 'wrote:');
        const b = await kit('blitz');
        const origin = await kit('layerOrigin');
        const scan = wrote && b.docId ? await kitAsync('hitScan', b.docId, 14, Math.round(wrote.bottom - 30 - origin.top), Math.round(wrote.bottom + 120 - origin.top), 4) : null;
        const folds = [];
        for (let i = 0; i < 4 && scan; i += 1) {
          const stat = await status();
          // The pane can scroll when the height changes: the point is recomputed from the layer each time.
          // The worker answers a hit only after the tile paints of the last layout (see perf.foreground.hit), so wait for them.
          const settledMs = await waitSettled();
          await kit('rect', 'blitz', 'wrote:');
          const org = await kit('layerOrigin');
          const before = await kit('blitz');
          const hitBefore = (await kitAsync('rpcTime', 'render.hit', { docId: before.docId, x: scan.x, y: scan.y }, 1))[0];
          const probe = await browser.executeAsync((x, y, done) => {
            const box = document.querySelector('[data-testid="blitz-email-body"] [role="presentation"]');
            const before = box.getBoundingClientRect().height;
            const t0 = performance.now();
            const el = document.elementFromPoint(x, y) || box;
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            // Two clocks: the box height (the new layout's meta arrived) and the paint (every shown tile carries
            // the newest rev and has decoded).
            const painted = () => {
              const tiles = [...document.querySelectorAll('[data-testid="blitz-tile"]')].filter((t) => t.getAttribute('src'));
              if (!tiles.length) return false;
              const revs = tiles.map((t) => Number((/(\d+)(?:%2F|\/)(\d+)(?:%2F|\/)(\d+)$/i.exec(t.src) || [])[2]));
              const top = Math.max(...revs);
              return revs.every((r) => r === top) && tiles.every((t) => t.complete && t.naturalWidth > 0);
            };
            let heightMs = -1;
            const poll = () => {
              const now = performance.now() - t0;
              if (heightMs < 0 && box.getBoundingClientRect().height !== before) heightMs = now;
              if (heightMs >= 0 && painted()) return done({ heightMs, paintMs: now });
              if (now > 8000) return done({ heightMs, paintMs: -1 });
              setTimeout(poll, 5);
            };
            poll();
          }, Math.round(org.left + scan.x), Math.round(scan.y + org.top));
          const ms = probe.heightMs;
          const after = await kit('blitz');
          folds.push({ ms: Math.round(ms), paintMs: Math.round(probe.paintMs), settledMs, index: stat && stat.state, indexed: stat && stat.indexed, rev: [before.rev, after.rev], h: [before.cssHeight, after.cssHeight], doc: [before.docId, after.docId], hit: [hitBefore.fold, hitBefore.ms] });
          await browser.pause(400);
        }
        const switches = [];
        for (const subject of [SUBJECT_E, SUBJECT_A, SUBJECT_E, SUBJECT_A]) {
          const stat = await status();
          const ms = await browser.executeAsync((subj, needle, done) => {
            const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(subj));
            if (!row) { done(-2); return; }
            const t0 = performance.now();
            row.click();
            const tick = () => {
              const r = window.__mvc.ready('blitz', needle);
              if (r.ok && window.__mvc.blitz().docId !== window.__mvSwitchPrev) return done(performance.now() - t0);
              if (performance.now() - t0 > 15000) return done(-1);
              setTimeout(tick, 10);
            };
            window.__mvSwitchPrev = window.__mvc.blitz().docId;
            tick();
          }, subject, READY[subject]);
          switches.push({ subject, ms: Math.round(ms), index: stat && stat.state, indexed: stat && stat.indexed });
          await browser.pause(300);
        }
        return { folds, switches, scan: !!scan };
      };
      const idle = await timings();
      log('perf.idle', { index: await status(), ...idle });
      // A real backlog, then a rebuild so the daemon indexes it while the timings run.
      seedIndexBacklog(browser.testDataDir, browser.mockAccounts[0].id, 3000);
      const rebuild = await rpc('search_index_rebuild');
      await browser.pause(1500);
      const during0 = await status();
      log('perf.load.start', { rebuild, during: during0 });
      // And a real backup of the largest mock mailbox, running in the same daemon.
      const sizes = browser.mockInboxSizes || [];
      const bigAcc = browser.mockAccounts[Math.max(0, sizes.indexOf(Math.max(...sizes)))] || browser.mockAccounts[0];
      let run = null;
      try {
        run = await startBackup({ accountId: bigAcc.id, accountJson: JSON.stringify(bigAcc), backupPath: null, skipFolders: 0 });
        await browser.pause(1500);
      } catch (e) { log('perf.backup.start', { error: e.message }); }
      const loaded = await timings();
      let backup = null;
      if (run) {
        await rpc('backup_cancel', { accountId: bigAcc.id });
        backup = await run.finish(60_000).then((r) => ({ cancelled: r.cancelled, emails: r.emails_backed_up, folders: r.completed_folders, error: r.error_message || null }), (e) => ({ error: String(e.message).slice(0, 120) }));
      }
      const end = await status();
      log('perf.foreground', { ...loaded, indexAtStart: during0.state, indexedAtStart: during0.indexed, indexAtEnd: end, backup, backupAccount: bigAcc.email, inboxSizes: sizes });
      ck(loaded.folds.length > 0 && loaded.folds.every((f) => f.ms > 0), `a fold click never repainted: ${JSON.stringify(loaded.folds)}`);
      ck(loaded.folds.every((f) => f.ms <= 150), `a fold click took over 150 ms under load: ${JSON.stringify(loaded.folds)}`);
      ck(loaded.folds.every((f) => f.paintMs > 0 && f.paintMs <= 150), `a fold click was not painted within 150 ms under load (height ${loaded.folds.map((f) => f.ms)}, paint ${loaded.folds.map((f) => f.paintMs)})`);
      ck(loaded.folds.every((f) => f.index === 'indexing') || during0.state === 'indexing', 'the index was not busy while the timings ran (the numbers say nothing about load)');
    });
  });

  // ── Respawn ───────────────────────────────────────────────────────────────

  it('12a. respawn: kill the render worker mid-session; fonts replay and a re-open recovers', async function () {
    await section('respawn', async (ck) => {
      await openFixture('blitz', SUBJECT_B);
      await browser.pause(1500);
      const w0 = await kit('probeWidth', PROBE);
      const before = renderWorkers();
      log('respawn.before', { workers: before, lora: w0 });
      ck(before.length === 1, `expected exactly one render worker child of the daemon, found ${before.length}`);
      if (before.length !== 1) return;
      killWorker(before[0].pid);
      await browser.pause(3000);
      const docId = (await kit('blitz')).docId;
      const dead = { hit: await rpc('render.hit', { docId, x: 10, y: 10 }), tile: await rpc('render.tile', { docId, index: 0 }).then((r) => (r && r.png ? 'png' : r)) };
      const stateDead = await kit('blitz');
      log('respawn.afterKill', { rpc: { hit: dead.hit, tile: dead.tile }, body: stateDead, workersNow: renderWorkers() });
      await kit('fire', 'blitz', 'mousemove', 40, 200);
      await browser.pause(1500);
      const self = await kit('blitz');
      await openRow(SUBJECT_E); await waitReady('blitz', SUBJECT_E);
      await openRow(SUBJECT_B);
      const reopened = await waitReady('blitz', SUBJECT_B).then(() => 'ready').catch((e) => `not ready: ${e.message.slice(0, 160)}`);
      await browser.pause(2500);
      const w1 = await kit('probeWidth', PROBE);
      const after = renderWorkers();
      const fontsList = await rpc('fonts.list');
      log('respawn.after', { selfRecovered: self, reopened, lora: w1, workers: after, newWorker: after.length === 1 && after[0].pid !== before[0].pid, fonts: (fontsList.fonts || []).map((f) => f.family) });
      ck(after.length === 1 && after[0].pid !== before[0].pid, 'a fresh worker did not appear after the re-open');
      ck(reopened === 'ready', `the body did not recover after a re-open: ${reopened}`);
      ck(Math.abs(w1.lora - w0.lora) <= 2 && Math.abs(w1.lora - w1.georgia) > 3, `Lora did not replay: probe width ${w0.lora} before, ${w1.lora} after (Georgia control ${w1.georgia})`);
    });
  });

  it('12b. respawn: after the kill, a never-shown tile is asked for (scroll): what the reader shows', async function () {
    await section('respawn.scroll', async () => {
      await openFixture('blitz', SUBJECT_A);
      const b0 = await kit('blitz');
      const before = renderWorkers();
      if (before.length !== 1) { log('respawn.scroll', { skipped: `workers: ${before.length}` }); return; }
      killWorker(before[0].pid);
      await browser.pause(2500);
      const scrolled = await kit('scrollBottom');
      await browser.pause(5000);
      const b1 = await kit('blitz');
      const failure = await browser.execute(() => ({ notice: !!document.querySelector('[data-testid="blitz-failure-notice"]'), bubble: !!document.querySelector('[data-testid="blitz-failure-bubble"]'), tiles: document.querySelectorAll('[data-testid="blitz-tile"]').length }));
      await openRow(SUBJECT_E); await waitReady('blitz', SUBJECT_E);
      await openRow(SUBJECT_A);
      const reopened = await waitReady('blitz', SUBJECT_A).then(() => 'ready').catch((e) => `not ready: ${e.message.slice(0, 120)}`);
      log('respawn.scroll', { before: b0, scrolled, after: b1, failure, reopened, workersNow: renderWorkers() });
    });
  });
});
