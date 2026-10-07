/**
 * Website feature-card clips: eight short takes (about 5 s each), one cause and
 * one effect per clip, cut by video/capture/tools/webclip.swift into a 960x660
 * H.264 loop and a poster (scripts/footage/webclip-encode.sh). Each clip is its
 * own `it`, named after its output file. Everything that is not the cause and
 * its effect is staged off camera in `prepare`, so the take is only the 5 s.
 *
 * Three boots (scripts/footage/web-clips.sh has the exact env per boot):
 *
 *   A  archive-delete       (deletes a year from the mock server, so alone)
 *   B  search-50k           (the 50,000-message vault is seeded before boot)
 *   C  unified-inbox, link-safety, trackers, undo-send, time-capsule,
 *      scheduled-backups    (FOOTAGE_EXTRA_MAIL=1 FOOTAGE_ALIGN_ALL=1, in this order)
 *
 * `FOOTAGE_ONLY=<clip>[,<clip>]` picks the clips; the boot's setup only does
 * what the picked clips need.
 *
 * Locale: rows are found by the demo's own marker subjects in the run's
 * language (lib/mailbox.js footageMarkers), by sender names (not translated),
 * by data-testid and by app labels (L). English-only needles left: the tracker
 * newsletter (extra mail is generated in English) and the search query (the
 * 50k corpus is English with a few planted non-English words).
 *
 * Every take writes `<clip>.webclip.json`: the crop (window points) around
 * what the clip is about, the segments of the .mov to keep (seconds, from the
 * take's own timeline), the poster time and inspection frames; and
 * `<clip>.textscan.json`: em dashes, version labels and relative dates in the
 * visible text inside the crop, sampled during the take (a cross-check only;
 * the frames are what is looked at).
 *
 * STAGED (disclose): time-capsule's three older snapshots are backdated files
 * built from a real snapshot of the vault (as ph-tier1 c09); the snapshot the
 * take adds is real. scheduled-backups' frequency is a native <select> set
 * through React's value setter (the native menu never draws).
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, clickSel, bootToInbox, resetView, beforeTake,
  waitPage, since, openWorkInbox, dismissBulkBubble, setSetting,
} from '../lib/scene.js';
import { footageMarkers } from '../lib/mailbox.js';
import { APP_LOCALE } from '../lib/locale.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const MARK = footageMarkers(APP_LOCALE);
const facts = { locale: APP_LOCALE, markers: MARK };

const ASPECT = 960 / 660;
const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const bubbleText = () => {
  for (const el of document.querySelectorAll('.fixed.bottom-4.right-4')) {
    if (el.offsetHeight > 0) return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }
  return '';
};

// ── Crop and text scan ──────────────────────────────────────────────────────

/** Union of boxes (viewport CSS px, {x,y,w,h}; nulls skipped). */
function union(...boxes) {
  const b = boxes.flat().filter(Boolean);
  if (!b.length) return null;
  const x0 = Math.min(...b.map((r) => r.x)), y0 = Math.min(...b.map((r) => r.y));
  const x1 = Math.max(...b.map((r) => r.x + r.w)), y1 = Math.max(...b.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * A 960:660 crop around `box` (viewport CSS px): padded, at least `minW` wide,
 * inside the webview with an inset, and clear of the window's rounded bottom
 * corners (they record black).
 */
async function fitCrop(box, { minW = 760, pad = 24 } = {}) {
  const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const inset = 4;
  const maxW = Math.min(vp.w - 2 * inset, (vp.h - 2 * inset) * ASPECT);
  let w = Math.max(minW, box.w + 2 * pad, (box.h + 2 * pad) * ASPECT);
  w = Math.min(w, maxW);
  const h = w / ASPECT;
  let x = box.x + box.w / 2 - w / 2;
  let y = box.y + box.h / 2 - h / 2;
  x = Math.max(inset, Math.min(x, vp.w - inset - w));
  y = Math.max(inset, Math.min(y, vp.h - inset - h));
  const corner = 22;
  if (y + h > vp.h - corner && (x < corner || x + w > vp.w - corner)) y = Math.max(inset, vp.h - corner - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(w / ASPECT), viewport: vp };
}

/** Viewport CSS px -> window points (the webview sits under the 32 pt title bar). */
async function toWindow(r) {
  const off = await browser.execute(() => ({ top: window.outerHeight - window.innerHeight }));
  const top = off.top > 0 && off.top < 80 ? off.top : 32;
  return [r.x, r.y + top, r.w, r.h];
}

/** Visible text inside `crop` (viewport CSS px) that must not ship: em dashes, versions, relative dates. */
function scanText(crop) {
  const hits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const re = [/—/, /\bv?\d+\.\d+\.\d+\b/, /\bv\d+(\.\d+)?\b/i, /\b\d+\s*(days?|weeks?|months?|years?)\s+ago\b/i];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.textContent || '';
    if (!s.trim() || !re.some((r) => r.test(s))) continue;
    const el = n.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width === 0 || r.right < crop.x || r.x > crop.x + crop.w || r.bottom < crop.y || r.y > crop.y + crop.h) continue;
    hits.push({ text: s.trim().slice(0, 120), box: [r.x, r.y, r.width, r.height].map(Math.round) });
  }
  // Text in same-origin iframes (mail bodies).
  for (const f of document.querySelectorAll('iframe')) {
    try {
      const doc = f.contentDocument;
      if (!doc) continue;
      const fr = f.getBoundingClientRect();
      if (fr.right < crop.x || fr.x > crop.x + crop.w || fr.bottom < crop.y || fr.y > crop.y + crop.h) continue;
      const t = doc.body?.innerText || '';
      for (const r of re) { const m = t.match(r); if (m) hits.push({ iframe: true, text: t.slice(Math.max(0, m.index - 40), m.index + 60) }); }
    } catch { /* cross-origin */ }
  }
  return hits;
}

/** Collects text-scan samples for one clip. */
class Scan {
  constructor(clip) { this.clip = clip; this.samples = []; }

  async at(take, label, crop) {
    if (!crop) return;
    const hits = await browser.execute(scanText, crop);
    this.samples.push({ t: Number(take.t(Date.now()).toFixed(2)), label, hits });
  }

  write(crop) {
    const all = this.samples.flatMap((s) => s.hits.map((h) => ({ ...h, t: s.t, at: s.label })));
    writeFileSync(join(OUT_DIR, `${this.clip}.textscan.json`), JSON.stringify({ crop, samples: this.samples, hits: all.length }, null, 2));
    console.log(`[webclip] ${this.clip} text scan: ${all.length} hit(s) ${JSON.stringify(all.slice(0, 6))}`);
  }
}

/** Box (viewport CSS px) of the first visible match. */
const boxOf = (sel, text = '') => browser.execute((s, t) => {
  for (const el of document.querySelectorAll(s)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (t && !(el.innerText || '').includes(t)) continue;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  return null;
}, sel, text);

/**
 * `<clip>.webclip.json` for the encoder: crop and per-segment crops in window
 * points, segments in seconds of the .mov, poster and inspection frames in
 * seconds of the output.
 */
async function writeWebclip(clip, { crop, segments, poster, boxes = {} }) {
  const win = await toWindow(crop);
  const segs = [];
  for (const s of segments) {
    segs.push({ t0: Number(s.t0.toFixed(3)), t1: Number(s.t1.toFixed(3)), ...(s.crop ? { crop: await toWindow(s.crop) } : {}), ...(s.label ? { label: s.label } : {}) });
  }
  const dur = segs.reduce((a, s) => a + s.t1 - s.t0, 0);
  const winBoxes = {};
  for (const [k, b] of Object.entries(boxes)) if (b) winBoxes[k] = await toWindow(b);
  const spec = {
    scale: 2, size: [960, 660], fps: 30, maxBytes: 250000,
    crop: win, segments: segs,
    poster: Number((poster ?? dur * 0.75).toFixed(2)),
    frames: [0.1, ...[0.2, 0.4, 0.6, 0.8].map((f) => Number((dur * f).toFixed(2))), Number((dur - 0.1).toFixed(2))],
    boxes: winBoxes,
    durationSeconds: Number(dur.toFixed(3)),
  };
  writeFileSync(join(OUT_DIR, `${clip}.webclip.json`), JSON.stringify(spec, null, 2));
  console.log(`[webclip] ${clip}: crop ${JSON.stringify(win)}, ${segs.length} segment(s), ${dur.toFixed(2)} s`);
  return spec;
}

// ── Take plumbing ───────────────────────────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  facts[`${clip}Seconds`] = rec.seconds;
  return rec;
}

/**
 * One clip: back to the plain inbox, `prepare` (off camera), a quiet frame,
 * `body(take, scan)` returns what writeWebclip needs.
 */
async function shoot(ctx, clip, body, { prepare, onError, allow } = {}) {
  if (!want(clip)) ctx.skip();
  await resetView();
  if (prepare) await prepare();
  await beforeTake(clip, { allow });
  const take = new Take(clip);
  const scan = new Scan(clip);
  await take.start();
  try {
    const web = await body(take, scan);
    await finish(take, clip);
    await writeWebclip(clip, web);
    scan.write(web.crop);
  } catch (e) {
    facts[`${clip}Error`] = String(e?.message || e);
    if (onError) { try { await onError(); } catch (e2) { facts[`${clip}OnError`] = String(e2?.message || e2); } }
    await take.abort();
    throw e;
  }
}

/** One daemon RPC from the page (setup only), the channel the app's daemonCall uses. */
function rpc(method, params = {}) {
  return browser.executeAsync((m, p, done) => {
    const inv = window.__TAURI_INTERNALS__?.invoke;
    if (!inv) { done({ error: 'no invoke' }); return; }
    inv('daemon_rpc', { method: m, params: p }).then((v) => done({ ok: v ?? null }), (e) => done({ error: String(e?.message || e) }));
  }, method, params);
}

/** Tag the first visible element under `scope` matching `sel` whose trimmed text is exactly `text`. */
function markExact(scope, sel, text, tag) {
  return browser.execute((sc, s, tx, tg) => {
    document.querySelectorAll(`[data-footage-target="${tg}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    for (const root of sc ? [...document.querySelectorAll(sc)] : [document]) {
      const hit = [...root.querySelectorAll(s)].find((el) => el.getClientRects().length > 0 && (el.innerText || el.textContent || '').trim() === tx);
      if (hit) { hit.setAttribute('data-footage-target', tg); return true; }
    }
    return false;
  }, scope, sel, text, tag);
}

/** Tag the first visible row whose text contains `needle`. */
function tagRow(needle, tag) {
  return browser.execute((n, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => r.getBoundingClientRect().height > 0 && (r.innerText || '').includes(n));
    if (!row) return false;
    row.setAttribute('data-footage-target', t);
    return true;
  }, needle, tag);
}

/** Settings > nav (> tab), off camera. */
async function settingsSetup(navLabel, tabLabel) {
  await clickSel('[data-testid="open-settings"]');
  await waitPage(settingsOpen, { timeout: 8000 });
  await clickSel('[data-testid="settings-page"] .settings-nav-item', navLabel);
  await browser.pause(900);
  if (tabLabel) {
    await markExact('[data-testid="settings-page"]', '[role="tab"]', tabLabel, 'settings-tab');
    await clickSel('[data-footage-target="settings-tab"]');
    await browser.pause(900);
  }
  await browser.execute(() => document.activeElement?.blur?.());
}

/** A native <select> set the way React hears it; the cursor travels there first. */
async function setSelect(take, selector, value, label) {
  await take.moveTo(selector, label);
  const r = await browser.execute((s, v) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.offsetHeight > 0);
    if (!el) return { error: `no visible ${s}` };
    const from = el.value;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { from, value: el.value };
  }, selector, value);
  if (r.error) throw new Error(`${label}: ${r.error}`);
  take.note(`set-${label}`, { ...r, at: Number(take.t(Date.now()).toFixed(3)) });
  return r;
}

/** The backup drive: a folder under the run's HOME, saved and write-tested like the picker does. */
async function seedBackupDrive() {
  const dir = join(browser.footageDataDir, 'BackupDrive');
  mkdirSync(dir, { recursive: true });
  const invoke = (cmd, args) => browser.executeAsync((c, a, done) => {
    window.__TAURI__.core.invoke(c, a).then((v) => done(v ?? true)).catch((e) => done({ __error: String(e?.message || e) }));
  }, cmd, args);
  const saved = await invoke('backup_save_external_location', { path: dir });
  if (saved?.__error) throw new Error(`backup_save_external_location: ${saved.__error}`);
  const valid = await invoke('backup_validate_external_location', {});
  if (valid?.__error || valid?.status !== 'ready') throw new Error(`backup location not ready: ${JSON.stringify(valid)}`);
  await browser.execute((loc) => window.__SETTINGS_STORE__.getState().setExternalBackupLocation(loc), valid);
  return valid;
}

// ── Bulk archive (setup only; from ph-tier1.js) ─────────────────────────────

async function bulkArchive(presetLabel) {
  const opened = await browser.execute((label) => {
    const btn = document.querySelector(`.mail-list-toolbar button[aria-label="${label}"]`) || document.querySelector(`button[aria-label="${label}"]`);
    if (!btn || btn.offsetHeight === 0) return false;
    btn.click();
    return true;
  }, L('workspace.selectMessages'));
  if (!opened) throw new Error('bulk: select-messages control not found');
  if (!(await waitPage((t) => document.body.innerText.includes(t), { timeout: 10000 }, L('bulk.ops.bulkEmailOperations')))) throw new Error('bulk: dialog did not open');
  await browser.pause(800);
  if (!(await clickSel('[role="dialog"] button', presetLabel))) throw new Error(`bulk: preset ${presetLabel} not found`);
  const selectedWord = L('bulk.ops.emailsSelected').replace('{{selectedCount}}', '').trim();
  await waitPage((w) => document.body.innerText.includes(w), { timeout: 10000 }, selectedWord);
  await waitPage((n) => [...document.querySelectorAll('[role="dialog"] button')]
    .some((b) => (b.textContent || '').trim().startsWith(n) && !b.disabled), { timeout: 30000 }, L('common.next'));
  if (!(await clickSel('[role="dialog"] button', L('common.next')))) throw new Error('bulk: Next not clickable');
  await browser.pause(500);
  if (!(await clickSel('[data-testid="bulk-action-archive"]'))) throw new Error('bulk: archive not offered');
  await browser.pause(300);
  if (!(await clickSel('[data-testid="bulk-step2-confirm"]'))) throw new Error('bulk: confirm not clickable');
  const done = await waitPage((c) => {
    for (const el of document.querySelectorAll('.fixed.bottom-4.right-4')) if ((el.innerText || '').includes(c)) return true;
    return false;
  }, { timeout: 180000, interval: 400 }, L('bulk.progress.operationComplete'));
  if (!done) throw new Error(`bulk: archive never completed (${await browser.execute(bubbleText)})`);
  await dismissBulkBubble();
  await browser.execute(() => window.__MAIL_STORE__?.getState?.().loadEmails?.());
  await browser.pause(2500);
}

// ── time-capsule staging (from ph-tier1.js c09) ─────────────────────────────

const appDir = () => join(process.env.FOOTAGE_DATA_DIR || process.env.HOME, 'Library/Application Support/com.mailvault.app');
const accountEmail = (id) => {
  try { return JSON.parse(readFileSync(join(appDir(), 'accounts.json'), 'utf8')).find((a) => a.id === id)?.email || null; } catch { return null; }
};

/** Three backdated snapshots built from a real one (taken and removed here); same format as snapshot.rs. */
async function stageSnapshots() {
  const accountId = await browser.execute(() => window.__MAIL_STORE__?.getState?.().activeAccountId);
  const email = accountEmail(accountId);
  if (!accountId || !email) throw new Error(`time-capsule: no account (${accountId}, ${email})`);
  const made = await rpc('snapshot.create_from_maildir', { accountId, accountEmail: email });
  const dir = join(appDir(), 'snapshots', accountId);
  if (made.error) throw new Error(`time-capsule: real snapshot failed: ${JSON.stringify(made)}`);
  const realName = made.ok?.filename || made.ok?.info?.filename || readdirSync(dir).filter((f) => f.endsWith('.json.gz')).sort().at(-1);
  if (!realName) throw new Error(`time-capsule: no snapshot file after create: ${JSON.stringify(made)}`);
  const realPath = join(dir, realName);
  const real = JSON.parse(gunzipSync(readFileSync(realPath)).toString('utf8'));
  unlinkSync(realPath);
  const meta = await browser.execute((acct) => {
    const st = window.__MAIL_STORE__?.getState?.() || {};
    const out = {};
    for (const e of [...(st.emails || []), ...(st.sortedEmails || [])]) {
      if (!e || e.uid == null || out[e.uid]) continue;
      if (e.accountId && e.accountId !== acct) continue;
      out[e.uid] = { ms: new Date(e.date || e.internalDate || 0).getTime() };
    }
    return out;
  }, accountId);
  const p2 = (n) => String(n).padStart(2, '0');
  const staged = [];
  for (const [daysAgo, hour, minute] of [[6, 8, 12], [27, 9, 3], [58, 7, 41]]) {
    const at = new Date(Date.now() - daysAgo * 86400000);
    at.setUTCHours(hour, minute, 17, 0);
    const iso = at.toISOString();
    const mailboxes = {};
    for (const [name, mb] of Object.entries(real.mailboxes || {})) {
      const emails = mb.emails.filter((e) => meta[e.uid] && meta[e.uid].ms > 0 && meta[e.uid].ms <= at.getTime())
        .map((e) => ({ uid: e.uid, subject: '', from: '', date: '', flags: e.flags, size: e.size }));
      if (emails.length) mailboxes[name] = { total_emails: emails.length, emails };
    }
    const manifest = { account_id: accountId, account_email: email, timestamp: iso.replace('Z', '+00:00'), mailboxes };
    const filename = `${at.getUTCFullYear()}-${p2(at.getUTCMonth() + 1)}-${p2(at.getUTCDate())}T${p2(at.getUTCHours())}-${p2(at.getUTCMinutes())}-${p2(at.getUTCSeconds())}.000Z.json.gz`;
    writeFileSync(join(dir, filename), gzipSync(Buffer.from(JSON.stringify(manifest))));
    staged.push({ filename, mailboxes: Object.fromEntries(Object.entries(mailboxes).map(([k, v]) => [k, v.total_emails])) });
  }
  facts.timeCapsuleStaged = { realMailboxes: Object.fromEntries(Object.entries(real.mailboxes || {}).map(([k, v]) => [k, v.total_emails])), staged };
  console.log(`[setup] snapshots staged: ${JSON.stringify(facts.timeCapsuleStaged)}`);
}

// ── search-50k (from ph-search50k.js) ───────────────────────────────────────

const indexStatus = () => browser.executeAsync((done) => {
  window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'search_index_status', params: {} })
    .then(done, (e) => done({ error: String(e?.message || e) }));
});

async function waitForIndex(timeoutMs = 1200000) {
  const t0 = Date.now();
  let last = null;
  let stableSince = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < timeoutMs) {
    const s = await indexStatus();
    const done = s && s.available && s.state === 'idle' && s.complete;
    if (!last || s.total !== last.total || s.indexed !== last.indexed || !done) stableSince = Date.now();
    last = s;
    if (Date.now() - lastLog > 20000) { console.log(`[setup] index ${since(t0)} s: ${JSON.stringify(s)}`); lastLog = Date.now(); }
    if (done && Date.now() - stableSince > 8000) { console.log(`[setup] index finished in ${since(t0)} s: ${JSON.stringify(s)}`); return s; }
    await browser.pause(2000);
  }
  console.error(`[setup] index NOT finished after ${since(t0)} s: ${JSON.stringify(last)}`);
  return last;
}

const searchState = () => browser.execute(() => {
  const st = window.__SEARCH_STORE__?.getState?.();
  const panel = document.querySelector('#mail-search-panel');
  return {
    active: !!st?.searchActive, searching: !!st?.isSearching, query: st?.searchQuery ?? null,
    results: st?.searchResults?.length ?? null, durationMs: st?.searchDurationMs ?? null, laneMs: st?.searchLaneMs ?? null,
    searched: st?.searchSearched ?? null, filters: st?.searchFilters || null,
    // Every "N ms" / "N s" the panel shows, as drawn.
    durations: panel ? (panel.innerText.match(/[\d.,]+\s*(ms|s)\b/g) || []) : [],
    panelText: panel ? panel.innerText.replace(/\s+/g, ' ').slice(0, 300) : '',
    rows: document.querySelectorAll('[data-testid="email-row"]').length,
  };
});

const searchDone = (q) => {
  const st = window.__SEARCH_STORE__?.getState?.();
  return !!st && st.searchActive && !st.isSearching && st.searchQuery === q && document.querySelectorAll('[data-testid="email-row"]').length > 0;
};

const scopeVault = () => browser.execute(() => {
  window.__SEARCH_STORE__?.getState?.().setSearchFilters?.({ folder: 'all', location: 'local' });
  window.__SETTINGS_STORE__?.getState?.().clearSearchHistory?.();
});

async function dryRun(q) {
  await browser.execute((query) => {
    const st = window.__SEARCH_STORE__.getState();
    st.setSearchFilters({ folder: 'all', location: 'local' });
    st.setSearchQuery(query);
    setTimeout(() => window.__SEARCH_STORE__.getState().performSearch(), 0);
  }, q);
  await waitPage((query) => {
    const st = window.__SEARCH_STORE__?.getState?.();
    return !!st && st.searchActive && !st.isSearching && st.searchQuery === query;
  }, { timeout: 60000, interval: 300 }, q);
  await browser.pause(600);
  return searchState();
}

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: website feature clips', function () {
  this.timeout(3600000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    facts.accounts = (browser.demoAccounts || []).map((a) => ({ id: a.id, email: a.email, name: a.name }));
    // The account rows' data-usage hover card never gets its stats in the harness (ph-tier2a).
    await setSetting('transferHoverEnabled', false);
    if (want('search-50k')) {
      facts.index = await waitForIndex();
      await browser.pause(6000);
      facts.indexSettled = await indexStatus();
      console.log(`[fact] index status: ${JSON.stringify(facts.indexSettled)}`);
    }
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(function () {
    writeFileSync(join(OUT_DIR, 'web-clips.facts.json'), JSON.stringify(facts, null, 2));
  });

  // 1. Archive & delete: the server loses a year, the vault keeps it.
  it('archive-delete', async function () {
    const COUNT = '[data-testid="email-list-count"]';
    const t = {};
    const box = {};
    await shoot(this, 'archive-delete', async (take, scan) => {
      t.start = take.t(Date.now());
      box.dialog = await boxOf('[role="dialog"]');
      box.count = await boxOf(COUNT);
      box.sources = union(await boxOf(SEL.sourceAll), await boxOf(SEL.sourceVault), await boxOf(SEL.sourceServer));
      await scan.at(take, 'confirm', box.dialog);
      await take.hold(700);
      await take.click('[data-testid="bulk-delete-confirm"]', 'confirm', { dur: 500 });
      t.confirm = take.events.at(-1).t;
      const done = L('bulk.progress.operationComplete');
      const failed = L('bulk.progress.operationFailed');
      const progress = [];
      const deadline = Date.now() + 300000;
      let finished = false;
      while (Date.now() < deadline) {
        const text = await browser.execute(bubbleText);
        const tt = take.t(Date.now());
        if (!progress.length || progress.at(-1).text !== text) progress.push({ t: Number(tt.toFixed(3)), text });
        if (!box.bubble && text) box.bubble = await boxOf('.fixed.bottom-4.right-4');
        if (text.includes(done) || text.includes(failed)) { finished = text.includes(done); break; }
        await browser.pause(150);
      }
      facts.archiveProgress = progress;
      if (!finished) throw new Error(`archive never completed: ${progress.at(-1)?.text}`);
      t.firstProgress = progress.find((p) => /\d+%/.test(p.text))?.t ?? null;
      t.complete = progress.at(-1).t;
      box.bubbleDone = await boxOf('.fixed.bottom-4.right-4');
      await scan.at(take, 'complete', box.bubbleDone);
      const dropped = await waitPage((s, b) => {
        const c = (document.querySelector(s)?.textContent || '').trim();
        return !!c && c !== b;
      }, { timeout: 8000, interval: 100 }, COUNT, facts.archiveCountBefore);
      t.countDrop = take.t(Date.now());
      facts.archiveCountAfter = await browser.execute((s) => (document.querySelector(s)?.textContent || '').trim(), COUNT);
      console.log(`[footage] server count "${facts.archiveCountBefore}" -> "${facts.archiveCountAfter}" (${dropped ? 'changed' : 'UNCHANGED'})`);
      // The header can pass through a partial count while the deletes land
      // (run a2: 2,842 -> 2,554 -> 2,422 over 0.4 s). The clip cuts that
      // transient out: it shows the count before, then the settled one.
      const lastNumber = (txt) => Number(((txt || '').match(/\d[\d.,\u00a0\u202f']*/g) || []).pop()?.replace(/\D/g, '') || NaN);
      const expected = lastNumber(facts.archiveCountBefore) - Number(String(facts.archiveSelected || '').replace(/\D/g, ''));
      facts.archiveCountExpected = expected;
      const counts = [];
      const settleDeadline = Date.now() + 15000;
      while (Date.now() < settleDeadline) {
        const c = await browser.execute((sel) => (document.querySelector(sel)?.textContent || '').trim(), COUNT);
        if (!counts.length || counts.at(-1).text !== c) counts.push({ t: Number(take.t(Date.now()).toFixed(3)), text: c });
        if (lastNumber(c) === expected) break;
        await browser.pause(60);
      }
      t.countSettled = counts.at(-1).t;
      facts.archiveCounts = counts;
      facts.archiveCountSettled = counts.at(-1).text;
      if (lastNumber(counts.at(-1).text) !== expected) console.warn(`[footage] server count never settled on ${expected}: ${JSON.stringify(counts)}`);
      await take.hold(900);
      await take.click(SEL.sourceVault, 'source-vault', { dur: 500 });
      t.vault = take.events.at(-1).t;
      await take.waitFor(() => document.querySelectorAll('[data-testid="email-row"]').length > 3, 'vault rows', 10000);
      await take.hold(300);
      facts.archiveVaultCount = await browser.execute((s) => (document.querySelector(s)?.textContent || '').trim(), COUNT);
      t.vaultShown = take.t(Date.now());
      box.list = await boxOf('[data-testid="email-row"]');
      await take.hold(1500);
      t.end = take.t(Date.now());
      facts.archiveTimes = t;
      facts.archiveBoxes = box;
      console.log(`[footage] archive-delete times ${JSON.stringify(t)}; vault "${facts.archiveVaultCount}"`);
      // One crop: the list header (the count), the dialog, the sidebar's Vault
      // button. The progress bubble (bottom right) stays out of it: the run is
      // cut from the confirm click to just before the count changes.
      const crop = await fitCrop(union(box.count, box.dialog, box.sources), { minW: 860, pad: 16 });
      await scan.at(take, 'vault', crop);
      return {
        crop,
        segments: [
          { t0: t.confirm - 0.8, t1: t.confirm + 0.9, label: 'confirm' },
          { t0: t.countDrop - 0.7, t1: t.countDrop - 0.03, label: 'count-before' },
          { t0: t.countSettled + 0.03, t1: Math.min(t.end, t.vaultShown + 1.5), label: 'count-after-and-vault' },
        ],
        boxes: box,
      };
    }, {
      prepare: async () => {
        // The Server list, then the bulk dialog up to its confirmation (off camera).
        await clickSel(SEL.sourceServer);
        await waitPage(() => document.querySelectorAll('[data-testid="email-row"]').length > 5, { timeout: 15000 });
        await browser.pause(1500);
        facts.archiveCountBefore = await browser.execute((s) => (document.querySelector(s)?.textContent || '').trim(), COUNT);
        const opened = await browser.execute((label) => {
          const btn = document.querySelector(`.mail-list-toolbar button[aria-label="${label}"]`);
          if (!btn || btn.offsetHeight === 0) return false;
          btn.click();
          return true;
        }, L('workspace.selectMessages'));
        if (!opened) throw new Error('select-messages control not found');
        // The year buttons describe the loaded window until the dialog's read of
        // the whole header cache lands: wait for the oldest year itself.
        const wantYear = process.env.FOOTAGE_S3_YEAR || '2022';
        if (!(await waitPage((y) => [...document.querySelectorAll('[role="dialog"] button')]
          .some((b) => (b.textContent || '').trim().startsWith(`${y} (`)), { timeout: 60000, interval: 300 }, wantYear))) {
          throw new Error(`the bulk dialog never offered ${wantYear}`);
        }
        await browser.pause(600);
        facts.archiveYears = await browser.execute(() => [...document.querySelectorAll('[role="dialog"] button')]
          .map((b) => (b.textContent || '').trim()).filter((s) => /^\d{4} \(/.test(s)));
        const year = wantYear;
        facts.archiveYear = year;
        if (!(await clickSel('[role="dialog"] button', `${year} (`))) throw new Error(`year ${year} not offered`);
        await waitPage((n) => [...document.querySelectorAll('[role="dialog"] button')]
          .some((b) => (b.textContent || '').trim().startsWith(n) && !b.disabled), { timeout: 15000 }, L('common.next'));
        await clickSel('[role="dialog"] button', L('common.next'));
        await waitPage(() => !!document.querySelector('[data-testid="bulk-action-archive_and_delete"]'), { timeout: 8000 });
        await clickSel('[data-testid="bulk-action-archive_and_delete"]');
        await browser.pause(400);
        await clickSel('[data-testid="bulk-step2-confirm"]');
        if (!(await waitPage(() => !!document.querySelector('[data-testid="bulk-delete-confirm"]'), { timeout: 8000 }))) throw new Error('no confirmation');
        facts.archiveConfirmText = await browser.execute(() => (document.querySelector('[role="dialog"]')?.innerText || '').replace(/\s+/g, ' ').slice(0, 600));
        // How many the run will take off the server: the confirmation's own number.
        facts.archiveSelected = (facts.archiveConfirmText.match(/\d[\d.,\u00a0\u202f']*/) || [''])[0];
        await browser.execute(() => document.activeElement?.blur?.());
        await browser.pause(800);
      },
      // The confirmation dialog is the take's first frame.
      allow: (o) => o.role === 'dialog' || o.role === 'alertdialog' || (o.box[2] >= 900 && o.box[3] >= 500),
    });
  });

  // 2. Search 50,000 messages: the count and the time it took.
  it('search-50k', async function () {
    const Q = process.env.FOOTAGE_QUERY || 'invoice';
    await shoot(this, 'search-50k', async (take, scan) => {
      await take.hold(500);
      await take.click(SEL.searchInput, 'search-box', { dur: 450 });
      await take.hold(200);
      await take.type(SEL.searchInput, Q, 'search-box', { follow: true });
      await take.hold(250);
      // The Search button, not Enter: Enter commits the word as a chip and
      // keeps the box focused, and the recent-searches list (just fed by this
      // search) then opens over the result line. A press outside the box
      // closes that list, as it does for a user reaching for the button.
      await take.click('#mail-search-panel form button[type="submit"]', 'search-button', { dur: 450 });
      await take.waitFor(searchDone, `results for ${Q}`, 30000, Q);
      const tResults = take.t(Date.now());
      await take.hold(400);
      facts.search = await searchState();
      console.log(`[fact] search on screen: ${JSON.stringify(facts.search)}`);
      const panel = await boxOf('#mail-search-panel');
      const rows = await browser.execute(() => {
        const r = [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 6).map((e) => e.getBoundingClientRect());
        return r.length ? { x: r[0].x, y: r[0].y, w: r[0].width, h: r.at(-1).bottom - r[0].y } : null;
      });
      const crop = await fitCrop(union(panel, rows), { minW: 760 });
      await scan.at(take, 'results', crop);
      await take.hold(2200);
      const end = take.t(Date.now());
      return { crop, segments: [{ t0: 0.25, t1: end }], poster: Math.min(end - 0.3, tResults + 1.0), boxes: { panel, rows } };
    }, {
      prepare: async () => {
        facts.searchDry = await dryRun(Q);
        console.log(`[setup] dry run "${Q}": ${JSON.stringify(facts.searchDry)}`);
        // For the record: what other queries show on this machine (nothing of
        // this is filmed; the take searches Q).
        facts.searchProbes = [];
        for (const q of (process.env.FOOTAGE_SEARCH_PROBES || 'invoice,contract,Réunion,invoice contract,invoice shipment').split(',').map((x) => x.trim()).filter(Boolean)) {
          const r = await dryRun(q);
          facts.searchProbes.push({ q, results: r.results, durations: r.durations, laneMs: r.laneMs, durationMs: r.durationMs });
        }
        console.log(`[setup] search probes: ${JSON.stringify(facts.searchProbes)}`);
        facts.searchDry2 = await dryRun(Q);
        await resetView();
        await scopeVault();
        // The panel open and empty before the take; the take is typing and Enter.
        await clickSel(SEL.searchToggle);
        await waitPage((x) => !!document.querySelector(x)?.offsetHeight, { timeout: 5000 }, SEL.searchInput);
        await browser.execute(() => document.activeElement?.blur?.());
        await scopeVault();
        await browser.pause(600);
        facts.searchFiltersBeforeTake = await browser.execute(() => window.__SEARCH_STORE__?.getState?.().searchFilters);
      },
    });
  });

  // 8. Unified inbox: All Inboxes mixes the accounts, each with its dot.
  it('unified-inbox', async function () {
    const ALL = '.mail-sidebar [data-testid="all-inboxes-btn"]';
    const dots = () => {
      const seen = {};
      for (const d of document.querySelectorAll('[data-testid="email-row"] [data-testid="account-dot"]')) {
        if (d.getBoundingClientRect().height <= 0) continue;
        const c = getComputedStyle(d).backgroundColor;
        seen[c] = (seen[c] || 0) + 1;
      }
      return seen;
    };
    await shoot(this, 'unified-inbox', async (take, scan) => {
      const all = await boxOf(ALL);
      const accounts = await boxOf('.mail-sidebar .sidebar-account-open');
      await take.hold(800);
      await take.click(ALL, 'all-inboxes', { dur: 550 });
      const tClick = take.events.at(-1).t;
      await take.waitFor(() => !!document.querySelector('[data-testid="account-dot"]'), 'unified rows', 10000);
      await take.hold(300);
      facts.unifiedDots = await browser.execute(dots);
      const rows = await browser.execute(() => {
        const r = [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 9).map((e) => e.getBoundingClientRect());
        return r.length ? { x: r[0].x, y: r[0].y, w: r[0].width, h: r.at(-1).bottom - r[0].y } : null;
      });
      facts.unifiedTop = await browser.execute(() => [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 9)
        .map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 90)));
      const crop = await fitCrop(union(all, accounts, rows), { minW: 760 });
      await scan.at(take, 'unified', crop);
      await take.hold(2600);
      const end = take.t(Date.now());
      if (Object.keys(facts.unifiedDots || {}).length < 2) throw new Error(`unified list shows ${Object.keys(facts.unifiedDots || {}).length} account colour(s)`);
      return { crop, segments: [{ t0: Math.max(0.2, tClick - 1.6), t1: end }], boxes: { all, accounts, rows } };
    }, {
      prepare: async () => {
        // STAGED (disclose): the demo's work and personal accounts hash to the
        // same violet, so the personal account gets teal, picked the way the
        // account settings colour picker sets it (settingsStore.setAccountColor).
        const personal = (browser.demoAccounts || [])[1]?.id;
        if (personal) await browser.execute((id) => window.__SETTINGS_STORE__.getState().setAccountColor(id, '#14b8a6'), personal);
        facts.unifiedAccountColor = personal ? { [personal]: '#14b8a6' } : null;
        await browser.pause(400);
      },
    });
  });

  // 6. Link safety: the link says one place and goes to another.
  it('link-safety', async function () {
    await shoot(this, 'link-safety', async (take, scan) => {
      const row = await boxOf('[data-footage-target="phish-row"]');
      await take.hold(600);
      await take.click('[data-footage-target="phish-row"]', 'open-phish', { dur: 550 });
      const tOpen = take.events.at(-1).t;
      await take.waitFor(() => [...document.querySelectorAll('iframe')].some((f) => !!f.contentDocument?.querySelector('a[href]')), 'phishing body', 12000);
      await take.hold(900);
      const link = await browser.execute(() => {
        for (const f of document.querySelectorAll('iframe')) {
          const a = f.contentDocument?.querySelector('a[href]');
          if (!a) continue;
          const fr = f.getBoundingClientRect();
          const r = a.getBoundingClientRect();
          if (r.width > 0) return { x: fr.x + r.x, y: fr.y + r.y, w: r.width, h: r.height };
        }
        return null;
      });
      if (!link) throw new Error('no link inside the rendered body');
      const x = link.x + link.w / 2, y = link.y + link.h / 2;
      take.log({ t: take.t(Date.now()), type: 'move', x, y, bbox: link, label: 'body-link', dur: 0.55 });
      await browser.pause(550);
      const at = Date.now();
      await browser.execute(() => {
        for (const f of document.querySelectorAll('iframe')) { const a = f.contentDocument?.querySelector('a[href]'); if (a) { a.click(); return true; } }
        return false;
      });
      take.log({ t: take.t(at), raf: take.t(at), type: 'click', x, y, bbox: link, label: 'body-link' });
      await take.waitFor((tx) => document.body.innerText.includes(tx), 'link safety dialog', 8000, L('linkSafety.linkTextSays'));
      await take.hold(300);
      const dialog = await boxOf('.mail-dialog');
      facts.linkDialog = await browser.execute(() => (document.querySelector('.mail-dialog')?.innerText || '').replace(/\s+/g, ' '));
      const crop = await fitCrop(union(link, dialog), { minW: 760 });
      await scan.at(take, 'dialog', crop);
      await take.hold(2600);
      const end = take.t(Date.now());
      return { crop, segments: [{ t0: Math.max(0.2, tOpen - 0.5), t1: end }], boxes: { row, link, dialog } };
    }, {
      prepare: async () => {
        if (!(await tagRow(MARK.phishing, 'phish-row'))) throw new Error(`phishing row not on screen: "${MARK.phishing}"`);
        await browser.execute(() => {
          const row = document.querySelector('[data-footage-target="phish-row"]');
          row?.scrollIntoView({ block: 'center' });
        });
        await browser.pause(500);
      },
    });
    await clickSel('.mail-dialog button', L('common.cancel'));
    await browser.pause(500);
  });

  // 5. Trackers: the newsletter's beacon is blocked; the reader eye names it.
  it('trackers', async function () {
    // English only: the extra mail (lib/mailbox.js) is not translated.
    const needle = '#214';
    const rowSel = '[data-testid="email-row"][data-footage-target="tracker-row"]';
    await shoot(this, 'trackers', async (take, scan) => {
      const row = await boxOf(rowSel);
      await take.hold(600);
      await take.click(rowSel, 'open-newsletter', { dur: 550 });
      const tOpen = take.events.at(-1).t;
      await take.waitFor(() => [...document.querySelectorAll('iframe')].some((f) => (f.getAttribute('srcdoc') || '').includes('data-mv-tracker-blocked')),
        'body with the blocked marker', 15000);
      await take.hold(1100);
      const marked = await browser.execute(() => {
        document.querySelectorAll('[data-footage-target="reader-eye"]').forEach((el) => el.removeAttribute('data-footage-target'));
        const eye = [...document.querySelectorAll('[data-testid="tracker-alert-icon"]')]
          .find((el) => !el.closest('[data-testid="email-row"]') && el.getBoundingClientRect().height > 0);
        if (!eye) return false;
        eye.setAttribute('data-footage-target', 'reader-eye');
        return true;
      });
      if (!marked) throw new Error('no tracker eye in the reader');
      const eye = await boxOf('[data-footage-target="reader-eye"]');
      const reader = await browser.execute(() => {
        const f = [...document.querySelectorAll('iframe')].find((x) => x.getBoundingClientRect().height > 0);
        const r = f?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, w: r.width, h: Math.min(r.height, 360) } : null;
      });
      await scan.at(take, 'reader', union(eye, reader));
      await take.click('[data-footage-target="reader-eye"]', 'reader-eye', { dur: 550 });
      await take.waitFor(() => !!document.querySelector('[role="alertdialog"]'), 'tracker dialog', 8000);
      await take.hold(300);
      const dialog = await boxOf('[role="alertdialog"]');
      facts.trackerDialog = await browser.execute(() => (document.querySelector('[role="alertdialog"]')?.innerText || '').replace(/\s+/g, ' '));
      const crop = await fitCrop(union(eye, dialog, reader), { minW: 760 });
      await scan.at(take, 'dialog', crop);
      await take.hold(2400);
      const end = take.t(Date.now());
      return { crop, segments: [{ t0: Math.max(0.2, tOpen - 0.5), t1: end }], boxes: { row, eye, reader, dialog } };
    }, {
      prepare: async () => {
        const tag = () => browser.execute((s) => {
          const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => (r.innerText || '').includes(s));
          if (!row) return 'no row';
          row.setAttribute('data-footage-target', 'tracker-row');
          return row.querySelector('[data-testid="tracker-alert-icon"]') ? 'icon' : 'no icon';
        }, needle);
        let state = await tag();
        if (state !== 'icon') { await browser.pause(8000); state = await tag(); }
        if (state === 'no icon') {
          // Backfill asked before the body reached the vault; one open runs the reader's own scan.
          await clickSel(rowSel);
          await waitPage(() => [...document.querySelectorAll('iframe')].some((f) => (f.getAttribute('srcdoc') || '').includes('data-mv-tracker-blocked')), { timeout: 15000 });
          await browser.pause(1200);
          await resetView();
          state = await tag();
        }
        facts.trackerRowIcon = state;
        if (state !== 'icon') throw new Error(`newsletter row: ${state}`);
      },
    });
    const closeSel = `[role="alertdialog"] button[aria-label="${L('common.close')}"]`;
    if (!(await clickSel(closeSel))) await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await browser.pause(500);
  });

  // 4. Undo send: Send, the countdown toast, Undo, the draft is back.
  it('undo-send', async function () {
    const TOAST = '[data-testid="undo-send-toast"]';
    // The demo's own reply to Priya, first sentence only: typing an address
    // ("accounts@...") fast let the editor's autolink move the caret.
    const body = MARK.scheduledReplyBody.split('\n')[0].split(/(?<=[.!?\u3002])\s*/)[0];
    await shoot(this, 'undo-send', async (take, scan) => {
      const compose = await boxOf(SEL.compose);
      const send = await boxOf(SEL.send);
      await take.hold(700);
      await take.click(SEL.send, 'send', { dur: 500 });
      const tSend = take.events.at(-1).t;
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'undo toast', 10000, TOAST);
      await take.hold(200);
      const toast = await boxOf(TOAST);
      facts.undoToast = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' '), TOAST);
      const crop = await fitCrop(union(compose, toast), { minW: 760 });
      await scan.at(take, 'toast', crop);
      await take.hold(900);
      await take.click(SEL.undoSend, 'undo', { dur: 500 });
      await take.waitFor((s, e, b) => !document.querySelector(s) && (document.querySelector(e)?.innerText || '').includes(b),
        'reply back in compose', 10000, TOAST, SEL.editor, body.split('\n')[0].slice(0, 20));
      await take.hold(300);
      await scan.at(take, 'back', crop);
      facts.undoAfter = await browser.execute((e) => ({ editor: (document.querySelector(e)?.innerText || '').slice(0, 160),
        subject: document.querySelector('[data-testid="compose-subject"]')?.value || null }), SEL.editor);
      await take.hold(1500);
      const end = take.t(Date.now());
      console.log(`[footage] undo-send ${JSON.stringify({ toast: facts.undoToast, after: facts.undoAfter })}`);
      return { crop, segments: [{ t0: Math.max(0.2, tSend - 1.0), t1: end }], boxes: { compose, send, toast } };
    }, {
      prepare: async () => {
        const mode = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().composeOpenMode);
        if (mode !== 'app') await setSetting('composeOpenMode', 'app');
        await setSetting('sendDelay', 15);
        // Reply without the original message beside it (the compose header's
        // own toggle, persisted): the compose card stays narrow enough to read.
        await setSetting('composeContextVisible', false);
        // Priya's licence renewal (sender names are not translated), replied to with the demo's own reply text.
        if (!(await tagRow('Priya Raines', 'priya'))) throw new Error('no row from Priya Raines on screen');
        await clickSel('[data-footage-target="priya"]');
        await waitPage((e) => !document.body.innerText.includes(e), { timeout: 10000 }, L('viewer.selectEmailRead'));
        await browser.pause(800);
        if (!(await clickSel('[data-quick-action="reply"]'))) throw new Error('no reply quick action');
        await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 10000 }, SEL.editor);
        await browser.pause(600);
        // ProseMirror reads typing back from the DOM: the same per-character
        // insertText a take uses (Take.typeRich), fast, off camera.
        const prep = new Take('undo-send-prep');
        const typedR = await prep.typeRich(SEL.editor, body, 'prep', { base: 45, jitter: 10, caret: 'start' });
        const typed = (typedR?.text || '').slice(0, 160);
        facts.undoTyped = typed;
        await browser.execute(() => document.activeElement?.blur?.());
        await browser.pause(800);
      },
      onError: async () => {
        await browser.execute((s) => { const b = document.querySelector(s); if (b) b.click(); return !!b; }, SEL.undoSend);
      },
    });
  });

  // 7. Time Capsule: take a snapshot, open an older one (read-only).
  it('time-capsule', async function () {
    const page = '[data-testid="settings-content"][data-page="time-capsule"]';
    const card = `${page} div[role="button"]`;
    const browserRows = '.snapshot-browser > .overflow-y-auto button';
    await shoot(this, 'time-capsule', async (take, scan) => {
      const content = await boxOf(page);
      const n = await browser.execute((c) => document.querySelectorAll(c).length, card);
      facts.tcCardsBefore = await browser.execute((c) => [...document.querySelectorAll(c)].map((el) => el.innerText.replace(/\s+/g, ' ')), card);
      await take.hold(700);
      await take.click(`${page} button`, 'take-snapshot', { text: L('timeCapsule.takeSnapshot'), dur: 500 });
      const tTake = take.events.at(-1).t;
      await take.waitFor((c, k) => document.querySelectorAll(c).length > k, 'new snapshot card', 30000, card, n);
      facts.tcCardsAfter = await browser.execute((c) => [...document.querySelectorAll(c)].map((el) => el.innerText.replace(/\s+/g, ' ')), card);
      const cards = await boxOf(card);
      await scan.at(take, 'cards', content);
      await take.hold(1100);
      await browser.execute((c) => {
        document.querySelectorAll('[data-footage-target="old-card"]').forEach((el) => el.removeAttribute('data-footage-target'));
        const all = [...document.querySelectorAll(c)];
        (all[all.length - 2] || all[0]).setAttribute('data-footage-target', 'old-card');
      }, card);
      const old = await boxOf('[data-footage-target="old-card"]');
      await take.click('[data-footage-target="old-card"]', 'open-old-snapshot', { dur: 550 });
      await take.waitFor((r) => document.querySelectorAll(r).length > 3
        && [...document.querySelectorAll(r)].some((b) => !b.querySelector('.italic')), 'snapshot rows', 15000, browserRows);
      await take.hold(300);
      const header = await browser.execute((ro) => {
        const el = [...document.querySelectorAll('span')].find((s) => s.getBoundingClientRect().height > 0 && (s.textContent || '').trim() === ro);
        return el ? (el.parentElement.innerText || '').replace(/\s+/g, ' ') : null;
      }, L('timeCapsule.readOnly'));
      facts.tcBrowserHeader = header;
      const rows = await boxOf('.snapshot-browser');
      const crop = await fitCrop(union(content), { minW: 760 });
      await scan.at(take, 'browser', crop);
      await take.hold(2000);
      const end = take.t(Date.now());
      return { crop, segments: [{ t0: Math.max(0.2, tTake - 0.9), t1: end }], boxes: { content, cards, old, rows } };
    }, {
      prepare: async () => {
        // The vault needs mail for a snapshot to hold anything: the last 90 days, archived.
        if (!facts.tcArchived) {
          facts.tcArchived = true;
          try { await bulkArchive(L('bulk.ops.last90Days')); } catch (e) { facts.tcArchiveError = e.message; console.error(`[setup] archive: ${e.message}`); }
          await openWorkInbox();
          await stageSnapshots();
        }
        await settingsSetup(L('settings.tab.timeCapsule'), null);
        await waitPage((c) => document.querySelectorAll(c).length >= 3, { timeout: 15000 }, card);
        await browser.pause(800);
      },
    });
  });

  // 3. Scheduled backups: switch it on, pick when.
  it('scheduled-backups', async function () {
    const SWITCH = `[role="switch"][aria-label="${L('settings.backup.schedule.automaticBackup')}"]`;
    const FREQ = `select[aria-label="${L('settings.backup.schedule.backupFrequency')}"]`;
    const hour = (h) => `[data-testid="backup-hours-picker"] [data-hour="${h}"]`;
    await shoot(this, 'scheduled-backups', async (take, scan) => {
      const sw = await boxOf(SWITCH);
      await take.hold(700);
      await take.click(SWITCH, 'automatic-backup-on', { dur: 500 });
      const tOn = take.events.at(-1).t;
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'frequency picker', 5000, FREQ);
      await take.hold(700);
      facts.backupFreqStart = await browser.execute((s) => document.querySelector(s)?.value, FREQ);
      await setSelect(take, FREQ, 'hours', 'freq-hours');
      await take.waitFor(() => !!document.querySelector('[data-testid="backup-hours-picker"]')?.offsetHeight, 'hours picker', 5000);
      await take.hold(500);
      if (await browser.execute((s) => document.querySelector(s)?.getAttribute('aria-pressed') === 'true', hour(3))) {
        await take.click(hour(3), 'hour-03-off', { dur: 350 });
        await take.hold(200);
      }
      for (const h of [7, 13, 22]) {
        await take.click(hour(h), `hour-${h}`, { dur: 380 });
        await take.hold(200);
      }
      facts.backupConfig = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().backupGlobalConfig);
      const freq = await boxOf(FREQ);
      const picker = await boxOf('[data-testid="backup-hours-picker"]');
      const crop = await fitCrop(union(sw, freq, picker), { minW: 760 });
      await scan.at(take, 'hours', crop);
      await take.hold(1300);
      const end = take.t(Date.now());
      return { crop, segments: [{ t0: Math.max(0.2, tOn - 0.9), t1: end }], boxes: { sw, freq, picker } };
    }, {
      prepare: async () => {
        facts.backupLocation = await seedBackupDrive();
        await browser.execute(() => window.__SETTINGS_STORE__.getState().setBackupGlobalEnabled?.(false));
        await settingsSetup(L('settings.tab.backup'), L('settings.backup.backupSchedule'));
        await waitPage((s) => !!document.querySelector(s), { timeout: 10000 }, SWITCH);
        await browser.execute((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), SWITCH);
        await browser.pause(800);
      },
    });
    // Off again, so no scheduled run starts under a later take.
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setBackupGlobalEnabled?.(false));
  });
});
