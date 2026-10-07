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
 *   D  views, sender-verification, chat-view, scheduled-send   (batch 2; server untouched)
 *   E  email-cleanup, search-local, insights   (batch 2; archives the Newsletter
 *      group, then the whole INBOX, so search and Insights read the vault)
 *   F  privacy-mode, layouts, manual-backup, custom-fields; G ai-writing, tagging-rules
 *   H  quick-actions, explorer-view, column-layout, shortcuts, notification-rules,
 *      templates, tags, radial-menu, snooze, focus-session   (batch 3)
 *
 * Batch 3 STAGED (disclose): quick-actions, column-layout and shortcuts open
 * Settings mid-take and cut the navigation out; templates' template is saved
 * through the settings store; tags' reader button is added through Settings >
 * Quick actions off camera and moved first in the list through the store;
 * shortcuts presses the keys as KeyboardEvents (no on-screen key display);
 * tagging-rules makes its rule off camera and cuts the wait for the verdict.
 *
 * Batch 2 STAGED (disclose): chat-view switches Mail view to Chat through the
 * settings store before the take; scheduled-send's reply is typed and its
 * Later panel opened before the take; email-cleanup's classification runs
 * and its group is selected before the take; search-local and insights cut
 * time (search: the moment the result lines draw, so the "N ms" lane line is
 * never in a frame; insights: the vault read between the click and the page).
 *
 * `FOOTAGE_ONLY=<clip>[,<clip>]` picks the clips; the boot's setup only does
 * what the picked clips need.
 *
 * Locale: rows are found by the demo's own marker subjects in the run's
 * language (lib/mailbox.js footageMarkers), by sender names (not translated),
 * by data-testid and by app labels (L). English-only needles left: the tracker
 * newsletter (extra mail is generated in English) and the search query (the
 * 50k corpus is English with a few planted non-English words). Batch 2 adds
 * none of its own: "Ana Brandt" and "Priya" are sender names; the cleanup
 * "Archive (N)" button (hardcoded English in the app) is found by its classes,
 * and the bulk dialog's "All" preset is a literal in the app.
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
import { execFileSync } from 'node:child_process';
import { ImapFlow } from 'imapflow';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, clickSel, bootToInbox, resetView, beforeTake,
  waitPage, since, openWorkInbox, dismissBulkBubble, setSetting,
} from '../lib/scene.js';
import { closeSettings } from '../../../tests/e2e/helpers.js';
import { footageMarkers } from '../lib/mailbox.js';
import { APP_LOCALE } from '../lib/locale.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const MARK = footageMarkers(APP_LOCALE);
const facts = { locale: APP_LOCALE, markers: MARK };

const ASPECT = 960 / 660;
const CLOSE_SETTINGS = `[data-testid="settings-page"] button[aria-label="${L('common.close')}"]`;
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

/** Settings > nav > the tab whose text starts with `tabLabel` (a tab can carry a count), off camera. */
async function settingsSetupTab(navLabel, tabLabel) {
  await clickSel('[data-testid="open-settings"]');
  await waitPage(settingsOpen, { timeout: 8000 });
  await clickSel('[data-testid="settings-page"] .settings-nav-item', navLabel);
  await waitPage((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
    .some((b) => (b.textContent || '').trim().startsWith(t)), { timeout: 8000 }, tabLabel);
  await clickSel('[data-testid="settings-page"] [role="tab"]', tabLabel);
  await browser.pause(900);
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

// ── Batch 2 helpers ─────────────────────────────────────────────────────────

/** Box (viewport CSS px) of the first `n` visible list rows. */
const rowsBox = (n) => browser.execute((k) => {
  const r = [...document.querySelectorAll('[data-testid="email-row"]')]
    .map((e) => e.getBoundingClientRect()).filter((b) => b.height > 0).slice(0, k);
  return r.length ? { x: r[0].x, y: r[0].y, w: r[0].width, h: r.at(-1).bottom - r[0].y } : null;
}, n);

/** Tag the smallest element under `root` containing `needle` (from boot-a.js). */
function markSmallest(root, needle, tag) {
  return browser.execute((r, n, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const hit = [...document.querySelectorAll(`${r} *`)]
      .filter((el) => el.offsetHeight > 30 && (el.innerText || '').includes(n))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    if (!hit) return false;
    hit.setAttribute('data-footage-target', t);
    return true;
  }, root, needle, tag);
}

/**
 * The whole work INBOX archived once (bulk dialog, All -> Archive) and the
 * search index given time to take it in, so search answers from this computer
 * and Insights reads a complete vault (boot-a.js archiveEverything).
 */
async function archiveAll() {
  if (facts.archivedAll) return;
  facts.archivedAll = true;
  const t0 = Date.now();
  try {
    // The dialog's "All" preset is a literal in the app (not translated).
    await bulkArchive('All');
  } catch (e) {
    facts.archiveAllError = e.message;
    console.error(`[setup] archive all: ${e.message}`);
  }
  facts.archiveAllIndexChipGone = await waitPage(() => !document.querySelector('[data-testid="search-index-chip"]'), { timeout: 240000, interval: 1000 });
  facts.archiveAllSeconds = Number(since(t0));
  await openWorkInbox();
  await quiet({ timeout: 20000 });
  console.log(`[setup] archived everything in ${since(t0)} s (index chip gone: ${facts.archiveAllIndexChipGone})`);
}

/** resetView clicks the search toggle while a search is still active: close the panel for real. */
async function closeSearchPanel() {
  const open = () => browser.execute((s) => !!document.querySelector(s)?.offsetHeight, SEL.searchInput);
  for (let i = 0; i < 3 && (await open()); i++) {
    await browser.pause(400);
    await clickSel(SEL.searchToggle);
    await waitPage((s) => !document.querySelector(s)?.offsetHeight, { timeout: 2500 }, SEL.searchInput);
  }
  await browser.execute(() => document.activeElement?.blur?.());
  await browser.pause(400);
}

/** AI features on with Apple Intelligence (off by default; from ph-ai.js). */
async function aiOn() {
  await browser.execute(() => window.__SETTINGS_STORE__.getState().setAiSettings({ enabled: true, provider: 'appleFm' }));
  const providers = await rpc('ai.providers', {});
  const apple = (providers.ok || []).find?.((p) => p.provider === 'appleFm');
  facts.aiProviders = providers.ok || providers.error;
  if (!apple?.available) throw new Error(`Apple FM not available to the daemon: ${JSON.stringify(providers)}`);
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
      // The list (the count, the sidebar's Vault button) in one crop; the
      // dialog's own crop for the confirm click; a cut-away to the progress
      // bubble (bottom right) for the moment the run completes, which also
      // covers the header's transient partial count.
      const crop = await fitCrop(union(box.count, box.list, box.sources), { minW: 860, pad: 16 });
      const cropConfirm = await fitCrop(union(box.count, box.dialog), { minW: 860, pad: 16 });
      const cropBubble = await fitCrop(box.bubbleDone || box.bubble, { minW: 640, pad: 16 });
      await scan.at(take, 'vault', crop);
      await scan.at(take, 'bubble', cropBubble);
      return {
        crop,
        segments: [
          { t0: t.confirm - 0.8, t1: t.confirm + 0.35, crop: cropConfirm, label: 'confirm' },
          { t0: t.complete - 0.8, t1: t.complete - 0.3, crop, label: 'count-before' },
          { t0: t.complete - 0.3, t1: t.countSettled + 0.03, crop: cropBubble, label: 'complete' },
          { t0: t.countSettled + 0.03, t1: Math.min(t.end, t.vaultShown + 1.5), crop, label: 'count-after-and-vault' },
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

  // ── Batch 2, boot D (nothing changes on the server) ───────────────────────

  // 10. Sender verification: a verified sender, then a Reply-To that goes elsewhere.
  it('sender-verification', async function () {
    const VERIFIED = '[data-testid="sender-verification"][data-status="verified"]';
    const WARNING = '[data-testid="sender-verification"][data-status="warning"]';
    const popover = () => {
      const el = [...document.querySelectorAll('div[data-capture-overlay]')].find((d) => d.getBoundingClientRect().height > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: (el.innerText || '').replace(/\s+/g, ' ') };
    };
    const popoverShown = () => [...document.querySelectorAll('div[data-capture-overlay]')].some((d) => d.getBoundingClientRect().height > 0);
    const header = (s) => browser.execute((sel) => {
      const b = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().height > 0);
      const h = b?.closest('[data-testid="sender-header"]') || b?.parentElement?.parentElement;
      const r = h?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    }, s);
    await shoot(this, 'sender-verification', async (take, scan) => {
      const head1 = await header(VERIFIED);
      await take.hold(700);
      await take.click(VERIFIED, 'badge-verified', { dur: 500 });
      const tBadge1 = take.events.at(-1).t;
      await take.waitFor(popoverShown, 'verified popover', 5000);
      await take.hold(250);
      const pop1 = await browser.execute(popover);
      facts.senderVerifiedPopover = pop1?.text;
      const crop1 = await fitCrop(union(head1, pop1), { minW: 760 });
      await scan.at(take, 'verified', crop1);
      await take.hold(1500);
      // The row's press also closes the popover (its outside-mousedown).
      await take.click('[data-footage-target="replyto-row"]', 'open-replyto', { dur: 550 });
      const tRow = take.events.at(-1).t;
      await take.waitFor((s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0), 'warning badge', 12000, WARNING);
      await take.hold(700);
      const head2 = await header(WARNING);
      await take.click(WARNING, 'badge-warning', { dur: 450 });
      const tBadge2 = take.events.at(-1).t;
      await take.waitFor(popoverShown, 'warning popover', 5000);
      await take.hold(250);
      const pop2 = await browser.execute(popover);
      facts.senderWarningPopover = pop2?.text;
      const crop2 = await fitCrop(union(head2, pop2), { minW: 760 });
      await scan.at(take, 'warning', crop2);
      await take.hold(2100);
      const end = take.t(Date.now());
      console.log(`[footage] sender-verification ${JSON.stringify({ verified: facts.senderVerifiedPopover, warning: facts.senderWarningPopover })}`);
      return {
        crop: crop1,
        segments: [
          { t0: Math.max(0.2, tBadge1 - 1.0), t1: tRow - 0.05, crop: crop1, label: 'verified' },
          { t0: tBadge2 - 0.9, t1: end, crop: crop2, label: 'warning' },
        ],
        boxes: { head1, pop1, head2, pop2 },
      };
    }, {
      prepare: async () => {
        // Ana's Rack & Rind thread (the demo's SPF/DKIM pass) open in the
        // reader; the demo's Reply-To mismatch tagged in the list.
        if (!(await tagRow(MARK.replyTo, 'replyto-row'))) throw new Error(`Reply-To row not on screen: "${MARK.replyTo}"`);
        if (!(await tagRow(MARK.thread, 'ana-thread'))) throw new Error(`thread row not on screen: "${MARK.thread}"`);
        // tagRow clears its own tag only: both stay.
        await clickSel('[data-footage-target="ana-thread"]');
        if (!(await waitPage((s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0), { timeout: 12000 }, VERIFIED))) {
          throw new Error('no verified badge on the opened thread');
        }
        await browser.execute(() => document.activeElement?.blur?.());
        await browser.pause(900);
      },
    });
    await browser.execute(() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  });

  // 11. Chat view: a person, a topic, the conversation as bubbles.
  it('chat-view', async function () {
    const CHAT = '[data-testid="chat-view"]';
    // Sender names are not translated; the topic is the demo's thread marker
    // after "Rack & Rind - " (the patched dash).
    const topic = MARK.thread.split(/\s+[-—]\s+/).pop();
    await shoot(this, 'chat-view', async (take, scan) => {
      const chat = await boxOf(CHAT);
      await take.hold(700);
      if (!(await markSmallest(CHAT, 'Ana Brandt', 'person'))) throw new Error('no Ana Brandt conversation');
      const person = await boxOf('[data-footage-target="person"]');
      await take.click('[data-footage-target="person"]', 'person-ana', { dur: 500 });
      const tPerson = take.events.at(-1).t;
      await take.waitFor((c, n) => [...document.querySelectorAll(`${c} *`)].some((e) => e.offsetHeight > 30 && (e.innerText || '').includes(n)), 'topics', 8000, CHAT, topic);
      await take.hold(650);
      if (!(await markSmallest(CHAT, topic, 'topic'))) throw new Error(`no topic "${topic}"`);
      const topicBox = await boxOf('[data-footage-target="topic"]');
      await take.click('[data-footage-target="topic"]', 'topic', { dur: 450 });
      const tTopic = take.events.at(-1).t;
      await take.waitFor((c, reply) => (document.querySelector(c)?.innerText || '').includes(reply), 'bubbles', 15000, CHAT, L('chat.bubble.reply'));
      const tBubbles = take.t(Date.now());
      await take.hold(300);
      facts.chatView = await browser.execute((c) => (document.querySelector(c)?.innerText || '').replace(/\s+/g, ' ').slice(0, 500), CHAT);
      const crop = await fitCrop(chat, { minW: 1000 });
      await scan.at(take, 'bubbles', crop);
      await take.hold(3000);
      const end = take.t(Date.now());
      // The bubbles sit at both edges of a 1,300 pt pane: the reviewed crops
      // (web-clips.crops.json) show the people list, then each bubble in turn.
      const mid = tBubbles + 0.5 + (end - tBubbles - 0.5) * 0.45;
      return {
        crop,
        segments: [
          { t0: Math.max(0.2, tPerson - 0.9), t1: tTopic + 0.03, label: 'people' },
          { t0: tBubbles + 0.45, t1: mid, label: 'ana' },
          { t0: mid, t1: end, label: 'rowan' },
        ],
        boxes: { chat, person, topic: topicBox },
      };
    }, {
      prepare: async () => {
        // STAGED (disclose): Mail view switched to Chat through the settings
        // store (Settings > Layout > Chat), off camera.
        await setSetting('viewStyle', 'chat');
        if (!(await waitPage((c) => !!document.querySelector(c)?.offsetHeight, { timeout: 10000 }, CHAT))) throw new Error('chat view did not open');
        await browser.pause(1200);
      },
    });
    await setSetting('viewStyle', 'list');
    await browser.pause(600);
  });

  // 12. Scheduled send: Tomorrow 8am, Schedule, Send; it waits in Scheduled.
  // 12. Scheduled send: Tomorrow 8am, Schedule, Send; Scheduled counts it.
  // Three crops: the Later panel's upper part (its last line is the E2E
  // build's "sends the next time you open MailVault", which a release build
  // with the background helper words differently), the compose footer with
  // the armed plan, and the sidebar's Scheduled row once it counts the email.
  // The Scheduled list itself is not filmed: its row joins address and time
  // with an em dash (app copy).
  it('scheduled-send', async function () {
    const PANEL = '[data-testid="compose-schedule-panel"]';
    const SCHED = '.mail-sidebar [data-testid="sidebar-scheduled-btn"]';
    await shoot(this, 'scheduled-send', async (take, scan) => {
      const compose = await boxOf(SEL.compose);
      const panel = await boxOf(PANEL);
      const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
      await take.hold(700);
      await take.click('[data-testid="compose-schedule-preset-tomorrow"]', 'tomorrow-8am', { dur: 500 });
      const tPreset = take.events.at(-1).t;
      await take.waitFor(() => !!(document.querySelector('[data-testid="compose-schedule-time"]')?.dataset.value), 'time picked', 3000);
      await take.hold(300);
      facts.schedulePicked = await browser.execute(() => ({
        time: document.querySelector('[data-testid="compose-schedule-time"]')?.dataset.value || null,
        tz: document.querySelector('[data-testid="compose-schedule-tz"]')?.dataset.value || null,
        sends: document.querySelector('[data-testid="compose-schedule-sends"]')?.innerText || null,
        panel: (document.querySelector('[data-testid="compose-schedule-panel"]')?.innerText || '').replace(/\s+/g, ' '),
      }));
      // The panel down to its "Sends ... your time" line, never the notice under it.
      const sends = await boxOf('[data-testid="compose-schedule-sends"]') || await boxOf('[data-testid="compose-schedule-now"]');
      const W1 = 540, H1 = W1 / ASPECT;
      const cropPanel = { x: Math.round(Math.max(4, Math.min(panel.x + panel.w / 2 - W1 / 2, vp.w - 4 - W1))), y: Math.round(sends.y + sends.h + 6 - H1), w: W1, h: Math.round(H1) };
      await scan.at(take, 'panel', cropPanel);
      await take.hold(600);
      await take.click('[data-testid="compose-schedule-submit"]', 'schedule', { dur: 450 });
      const tSchedule = take.events.at(-1).t;
      await take.waitFor((p) => !document.querySelector(p), 'panel closed', 3000, PANEL);
      await take.hold(300);
      facts.schedulePlan = await browser.execute(() => document.querySelector('[data-testid="compose-send-plan"]')?.innerText || null);
      const plan = await boxOf('[data-testid="compose-send-plan"]');
      const send = await boxOf(SEL.send);
      // The footer out to the compose window's right edge (Schedule send and its chevron).
      const W2 = 640, H2 = W2 / ASPECT;
      const right = compose ? compose.x + compose.w + 8 : send.x + send.w + 60;
      const bottom = compose ? compose.y + compose.h + 8 : send.y + send.h + 24;
      const cropFooter = { x: Math.round(Math.max(4, Math.min(right - W2, vp.w - 4 - W2))), y: Math.round(Math.min(bottom, vp.h - 4) - H2), w: W2, h: Math.round(H2) };
      await scan.at(take, 'plan', cropFooter);
      await take.hold(900);
      await take.click(SEL.send, 'send-scheduled', { dur: 450 });
      const tSend = take.events.at(-1).t;
      await take.waitFor((s) => !document.querySelector(s)?.offsetHeight, 'compose closed', 15000, SEL.compose);
      const tClosed = take.t(Date.now());
      facts.scheduleUndoToast = await browser.execute(() => !!document.querySelector('[data-testid="undo-send-toast"]'));
      await take.waitFor((s) => /\d/.test(document.querySelector(s)?.innerText || ''), 'Scheduled count', 10000, SCHED);
      facts.scheduledCountAt = Number(take.t(Date.now()).toFixed(3));
      facts.scheduledSidebar = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' '), SCHED);
      const btn = await boxOf(SCHED);
      // The sidebar from the Scheduled row down: the list header above it carries today's date.
      const cropSide = { x: 4, y: Math.round(btn.y - 2), w: 640, h: Math.round(640 / ASPECT) };
      await scan.at(take, 'scheduled', cropSide);
      await take.hold(1900);
      const end = take.t(Date.now());
      console.log(`[footage] scheduled-send ${JSON.stringify({ picked: facts.schedulePicked, plan: facts.schedulePlan, undoToast: facts.scheduleUndoToast, sidebar: facts.scheduledSidebar })}`);
      return {
        crop: cropPanel,
        segments: [
          { t0: Math.max(0.2, tPreset - 0.9), t1: tSchedule + 0.03, crop: cropPanel, label: 'panel' },
          { t0: tSchedule + 0.3, t1: tSend + 0.03, crop: cropFooter, label: 'plan' },
          { t0: Math.max(tSend + 0.1, tClosed - 0.05), t1: end, crop: cropSide, label: 'scheduled' },
        ],
        poster: 2.0,
        boxes: { compose, panel, sends, plan, send, btn },
      };
    }, {
      prepare: async () => {
        const mode = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().composeOpenMode);
        if (mode !== 'app') await setSetting('composeOpenMode', 'app');
        await setSetting('composeContextVisible', false);
        // The demo's renewal reply to Priya (as undo-send), first sentence, typed off camera.
        const body = MARK.scheduledReplyBody.split('\n')[0].split(/(?<=[.!?。])\s*/)[0];
        if (!(await tagRow('Priya Raines', 'priya'))) throw new Error('no row from Priya Raines on screen');
        await clickSel('[data-footage-target="priya"]');
        await waitPage((e) => !document.body.innerText.includes(e), { timeout: 10000 }, L('viewer.selectEmailRead'));
        await browser.pause(800);
        if (!(await clickSel('[data-quick-action="reply"]'))) throw new Error('no reply quick action');
        await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 10000 }, SEL.editor);
        await browser.pause(600);
        const prep = new Take('scheduled-send-prep');
        const typed = await prep.typeRich(SEL.editor, body, 'prep', { base: 45, jitter: 10, caret: 'start' });
        facts.scheduleTyped = (typed?.text || '').slice(0, 160);
        await browser.execute(() => document.activeElement?.blur?.());
        await browser.pause(500);
        // The Later panel open on its date-and-time tab, before the take.
        await clickSel('[data-testid="compose-schedule-toggle"]');
        if (!(await waitPage((p) => !!document.querySelector(p)?.offsetHeight, { timeout: 5000 }, PANEL))) throw new Error('schedule panel did not open');
        await clickSel('[data-testid="compose-later-tab-at"]');
        await browser.pause(500);
        if (await browser.execute(() => !!document.querySelector('[data-testid="compose-schedule-locked"]'))) throw new Error('Scheduled Send is locked: the Premium seed did not take');
        if (!(await waitPage(() => !!document.querySelector('[data-testid="compose-schedule-preset-tomorrow"]')?.offsetHeight, { timeout: 5000 }))) throw new Error('no Tomorrow preset');
        await browser.execute(() => document.activeElement?.blur?.());
        await browser.pause(800);
      },
      // The compose window with its open Later panel is the first frame.
      allow: (o) => o.box[2] >= 400 && o.box[3] >= 300,
    });
    // The Scheduled list is a modal: closed, so the next take starts clean.
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await browser.pause(500);
  });

  // ── Batch 2, boot E (email-cleanup archives a group, then everything is archived) ──

  // 13. Email Cleanup: the classifier's Newsletter group, archived in one go.
  it('email-cleanup', async function () {
    const page = '[data-testid="settings-content"][data-page="cleanup"]';
    // "Archive (N)" is hardcoded English in the app: the selection bar's archive
    // button is found by its classes, not its text.
    const ARCHIVE_BTN = `${page} button.rounded-lg.bg-mail-accent-tint`;
    const OVERLAY = `${page} .bg-black\\/40`;
    await shoot(this, 'email-cleanup', async (take, scan) => {
      const content = await boxOf(page);
      const summary = await boxOf('[data-testid="cleanup-summary"]');
      await take.hold(700);
      await take.click(ARCHIVE_BTN, 'archive-group', { dur: 500 });
      const tArchive = take.events.at(-1).t;
      await take.waitFor((o) => !!document.querySelector(o)?.offsetHeight, 'confirm', 5000, OVERLAY);
      await take.hold(700);
      facts.cleanupConfirm = await browser.execute((o) => (document.querySelector(o)?.innerText || '').replace(/\s+/g, ' '), OVERLAY);
      if (!(await markExact(OVERLAY, 'button', L('common.archive'), 'confirm-archive'))) throw new Error('no Archive in the confirmation');
      await take.click('[data-footage-target="confirm-archive"]', 'confirm-archive', { dur: 450 });
      const progress = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        const s = await browser.execute((p, o, a) => ({
          busy: !!document.querySelector(`${p} .animate-spin`), overlay: !!document.querySelector(o),
          selected: !!document.querySelector(a),
        }), page, OVERLAY, ARCHIVE_BTN);
        const tt = Number(take.t(Date.now()).toFixed(3));
        if (!progress.length || JSON.stringify(progress.at(-1).s) !== JSON.stringify(s)) progress.push({ t: tt, s });
        if (!s.busy && !s.overlay && !s.selected) break;
        await browser.pause(80);
      }
      facts.cleanupProgress = progress;
      const done = progress.at(-1);
      if (done.s.busy || done.s.selected) throw new Error(`cleanup archive never finished: ${JSON.stringify(done)}`);
      await take.hold(400);
      facts.cleanupAfter = await browser.execute((p) => (document.querySelector(p)?.innerText || '').replace(/\s+/g, ' ').slice(0, 400), page);
      const rows = await browser.execute((p) => {
        const r = [...document.querySelectorAll(`${p} div[role="button"]`)].map((e) => e.getBoundingClientRect()).filter((b) => b.height > 0).slice(0, 7);
        return r.length ? { x: r[0].x, y: r[0].y, w: r[0].width, h: r.at(-1).bottom - r[0].y } : null;
      }, page);
      const crop = await fitCrop(union(summary, rows), { minW: 900, pad: 12 });
      await scan.at(take, 'after', crop);
      await take.hold(1600);
      const end = take.t(Date.now());
      console.log(`[footage] email-cleanup ${JSON.stringify({ group: facts.cleanupGroup, confirm: facts.cleanupConfirm, progress: progress.slice(0, 8), after: facts.cleanupAfter })}`);
      return { crop, segments: [{ t0: Math.max(0.2, tArchive - 1.0), t1: end }], boxes: { content, summary, rows } };
    }, {
      prepare: async () => {
        const accountId = await browser.execute(() => window.__MAIL_STORE__?.getState?.().activeAccountId);
        const t0 = Date.now();
        facts.cleanupRun = await rpc('classification.run', { accountId });
        let st = null;
        while (Date.now() - t0 < 300000) {
          await browser.pause(1500);
          st = (await rpc('classification.status', {})).ok;
          if (st && st.status !== 'Running' && Date.now() - t0 > 3000) break;
        }
        facts.cleanupStatus = st;
        console.log(`[setup] classified in ${since(t0)} s: ${JSON.stringify(st)}`);
        await settingsSetup(L('settings.tab.cleanup'), null);
        if (!(await waitPage((p) => !!document.querySelector(`${p} input[type="checkbox"]`) && !!document.querySelector('[data-testid="cleanup-summary"]'), { timeout: 30000 }, page))) {
          throw new Error('cleanup results never showed');
        }
        facts.cleanupChips = await browser.execute((p) => [...document.querySelectorAll(`${p} button.rounded-full.border`)].map((b) => b.innerText.trim()), page);
        // The Newsletter group (Promotional when the demo has none), all of it selected.
        let chip = null;
        for (const k of ['newsletter', 'promotional']) {
          const w = `${L(`settings.cleanup.${k}`)} (`;
          if (await clickSel(`${page} button.rounded-full.border`, w)) { chip = w; break; }
        }
        if (!chip) throw new Error(`no newsletter or promotional group: ${JSON.stringify(facts.cleanupChips)}`);
        facts.cleanupGroup = chip;
        await browser.pause(600);
        const selectAll = L('settings.cleanup.selectAllCount').split('(')[0].trim();
        if (!(await clickSel(`${page} button`, selectAll))) throw new Error('no Select All');
        if (!(await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 5000 }, ARCHIVE_BTN))) throw new Error('no archive button after Select All');
        await browser.execute(() => document.activeElement?.blur?.());
        await browser.pause(800);
      },
      allow: (o) => o.role === 'dialog' || (o.box[2] >= 900 && o.box[3] >= 500),
    });
    await dismissBulkBubble();
  });

  // 14. Search on this computer: type, results. The search time ("N ms") is
  // never in the picture: the typing segment ends at the press, before any
  // result line draws, and the results segment is cropped below the lanes row
  // (the take throws if its crop would touch any box that carries a time).
  it('search-local', async function () {
    const Q = process.env.FOOTAGE_LOCAL_QUERY || 'Priya';
    await shoot(this, 'search-local', async (take, scan) => {
      const panel0 = await boxOf('#mail-search-panel');
      const rows0 = await rowsBox(6);
      const cropType = await fitCrop(union(panel0, rows0), { minW: 760 });
      await scan.at(take, 'typing', cropType);
      await take.hold(500);
      await take.click(SEL.searchInput, 'search-box', { dur: 450 });
      const tBox = take.events.at(-1).t;
      await take.hold(200);
      await take.type(SEL.searchInput, Q, 'search-box', { follow: true });
      await take.hold(250);
      // The Search button, not Enter (see search-50k).
      await take.click('#mail-search-panel form button[type="submit"]', 'search-button', { dur: 450 });
      const tSubmit = take.events.at(-1).t;
      await take.waitFor(searchDone, `results for ${Q}`, 30000, Q);
      const tResults = take.t(Date.now());
      await take.hold(350);
      facts.searchLocal = await searchState();
      const timing = await browser.execute(() => {
        const out = [];
        for (const el of document.querySelectorAll('[data-testid="search-lanes"], [data-testid^="search-lane-"], [data-testid="search-duration"]')) {
          const r = el.getBoundingClientRect();
          if (r.height > 0) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
        }
        return out;
      });
      const panel = await boxOf('#mail-search-panel');
      const rows = await rowsBox(9);
      if (!rows) throw new Error('no result rows');
      const floor = Math.max(0, ...timing.map((b) => b.y + b.h), panel ? panel.y + panel.h : 0) + 4;
      // The list column only (no reader beside it), its top at the floor: the
      // floor is measured here, so a locale whose lines wrap moves it down.
      const RW = 700;
      const cropResults = { x: Math.round(Math.max(4, rows.x - 4)), y: Math.ceil(floor), w: RW, h: Math.round(RW / ASPECT * 4) / 4 };
      const hits = timing.filter((b) => b.y + b.h > cropResults.y && b.y < cropResults.y + cropResults.h && b.x + b.w > cropResults.x && b.x < cropResults.x + cropResults.w);
      if (hits.length) throw new Error(`results crop would show the search time: ${JSON.stringify({ cropResults, hits })}`);
      facts.searchLocalTiming = { timing, floor, cropResults };
      await scan.at(take, 'results', cropResults);
      await take.hold(2300);
      const end = take.t(Date.now());
      console.log(`[fact] search-local on screen: ${JSON.stringify(facts.searchLocal)} timing ${JSON.stringify(facts.searchLocalTiming)}`);
      const typing = { t0: Math.max(0.2, tBox - 0.8), t1: tSubmit + 0.02 };
      return {
        crop: cropResults,
        segments: [
          { ...typing, crop: cropType, label: 'typing' },
          { t0: tResults + 0.12, t1: end, crop: cropResults, label: 'results' },
        ],
        poster: typing.t1 - typing.t0 + 1.2,
        boxes: { panel0, rows0, panel, rows },
      };
    }, {
      prepare: async () => {
        await archiveAll();
        facts.searchLocalDry = await dryRun(Q);
        console.log(`[setup] dry run "${Q}": ${JSON.stringify(facts.searchLocalDry)}`);
        await resetView();
        await closeSearchPanel();
        await scopeVault();
        await clickSel(SEL.searchToggle);
        await waitPage((x) => !!document.querySelector(x)?.offsetHeight, { timeout: 5000 }, SEL.searchInput);
        await browser.execute(() => document.activeElement?.blur?.());
        await scopeVault();
        await browser.pause(600);
      },
    });
  });

  // 15. Insights: the vault read into a picture (the read itself is cut).
  it('insights', async function () {
    const PAGE = '[data-testid="insights-page"]';
    const busy = [L('insights.loading').split('{{')[0].trim(), L('insights.querying').replace('…', '').trim()];
    await shoot(this, 'insights', async (take, scan) => {
      const btn = await boxOf(SEL.insights);
      await take.hold(800);
      await take.click(SEL.insights, 'insights', { dur: 500 });
      const tClick = take.events.at(-1).t;
      await take.waitFor((p, words) => {
        const page = document.querySelector(p);
        return page?.dataset.status === 'ready' && !words.some((w) => (page.innerText || '').includes(w));
      }, 'insights ready', 90000, PAGE, busy);
      let tShow = take.t(Date.now());
      // The Sender map's caption carries today's date; Activity does not.
      if ((await browser.execute(() => document.querySelector('[data-testid="insights-tab-activity"]')?.getAttribute('aria-selected'))) !== 'true') {
        await take.click('[data-testid="insights-tab-activity"]', 'tab-activity', { move: false });
        tShow = take.events.at(-1).t;
        await take.waitFor(() => !!document.querySelector('#insights-panel-activity')?.offsetHeight, 'activity panel', 5000);
      }
      await take.hold(400);
      const total = await boxOf('[data-testid="insights-total"]');
      const tabs = await boxOf('.insights-tabs');
      const grid = await boxOf('#insights-panel-activity');
      facts.insights = await browser.execute((p) => {
        const page = document.querySelector(p);
        const txt = (sel) => (page?.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();
        return { total: txt('[data-testid="insights-total"]'), counts: txt('[data-testid="insights-counts"]'), coverage: txt('[data-testid="insights-coverage"]').slice(0, 300), activity: txt('#insights-panel-activity').slice(0, 300) };
      }, PAGE);
      const cropSide = await fitCrop({ x: btn.x, y: btn.y - 200, w: btn.w, h: btn.h + 400 }, { minW: 760 });
      const crop = await fitCrop(union(total, tabs, grid && { ...grid, h: Math.min(grid.h, 480) }), { minW: 860, pad: 16 });
      await scan.at(take, 'activity', crop);
      await take.hold(2600);
      const end = take.t(Date.now());
      take.note('insights', { click: tClick, shown: tShow, why: 'Insights reads the whole vault on every open; the busy panel between the click and the drawn page is cut.' });
      console.log(`[footage] insights ${JSON.stringify(facts.insights)}`);
      return {
        crop,
        segments: [
          { t0: Math.max(0.2, tClick - 1.0), t1: tClick + 0.03, crop: cropSide, label: 'click' },
          { t0: tShow + 0.25, t1: end, crop, label: 'activity' },
        ],
        boxes: { btn, total, tabs, grid },
      };
    }, {
      prepare: async () => {
        await archiveAll();
        await closeSearchPanel();
      },
    });
  });

  // 16. Views: the sidebar's built-in views, each one a different list (boot E,
  // after the whole INBOX is in the vault, so Attachments lists what it holds).
  it('views', async function () {
    const view = (id) => `[data-testid="view-row-builtin-${id}"]`;
    const rowsShown = () => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => r.getBoundingClientRect().height > 0);
    await shoot(this, 'views', async (take, scan) => {
      const list = await boxOf('.sidebar-views-section');
      const t = {};
      await take.hold(700);
      // From Attachments (opened before the take) to Needs reply and back: the
      // loop ends where it starts. Starred is empty on this mailbox.
      for (const id of ['needs-reply', 'attachments']) {
        await take.click(view(id), `view-${id}`, { dur: 450 });
        t[id] = take.events.at(-1).t;
        await take.waitFor(rowsShown, `${id} rows`, 15000);
        facts[`views_${id}`] = await browser.execute(() => ({
          title: (document.querySelector('[data-testid="mailbox-title"]')?.textContent || '').trim(),
          rows: [...document.querySelectorAll('[data-testid="email-row"]')].slice(0, 4).map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 80)),
        }));
        await take.hold(id === 'attachments' ? 2400 : 2000);
      }
      const rows = await rowsBox(9);
      const crop = await fitCrop(union(list, rows), { minW: 760, pad: 12 });
      await scan.at(take, 'views', crop);
      const end = take.t(Date.now());
      // Each switch remounts the search panel (a view is a saved search): about
      // 0.5 s of slide and fade in which the rows pass under the box and the
      // header shows the folder's date range. Cut: only settled states.
      const settle = 0.52;
      return {
        crop,
        segments: [
          { t0: Math.max(0.2, t['needs-reply'] - 0.9), t1: t['needs-reply'] + 0.03, label: 'attachments' },
          { t0: t['needs-reply'] + settle, t1: t.attachments + 0.03, label: 'needs-reply' },
          { t0: t.attachments + settle, t1: end, label: 'attachments-again' },
        ],
        boxes: { list, rows },
      };
    }, {
      prepare: async () => {
        await archiveAll();
        await closeSearchPanel();
        if (!(await browser.execute((s) => !!document.querySelector(s), view('needs-reply')))) throw new Error('no built-in views in the sidebar');
        // The view counts read the search index: let it finish first.
        facts.viewsIndex = await waitForIndex(240000);
        // A view opens the search panel (a view is a saved search): one view open
        // before the take, so the panel is already there and only the list changes.
        await clickSel(view('attachments'));
        await waitPage(() => [...document.querySelectorAll('[data-testid="email-row"]')].some((r) => r.getBoundingClientRect().height > 0), { timeout: 15000 });
        await browser.pause(1500);
        await browser.execute(() => document.activeElement?.blur?.());
        facts.viewsStart = await browser.execute(() => (document.querySelector('[data-testid="mailbox-title"]')?.textContent || '').trim());
      },
    });
  });
  // ── Batch 2, boot F (the demo mailbox without history; nothing deleted) ───

  // 17. Privacy mode: one press and names and addresses are masked.
  it('privacy-mode', async function () {
    const BTN = '.sidebar-footer [data-testid="privacy-button"]';
    const pressed = () => browser.execute((s) => document.querySelector(s)?.getAttribute('aria-pressed'), BTN);
    try {
      await shoot(this, 'privacy-mode', async (take, scan) => {
        const btn = await boxOf(BTN);
        const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
        // The sidebar's lower half with the shield, and the list beside it; clear
        // of the window's rounded bottom-left corner.
        const W = 760, H = W / ASPECT;
        const crop = { x: 24, y: Math.round(Math.min(btn.y + btn.h + 10, vp.h - 4) - H), w: W, h: Math.round(H) };
        await scan.at(take, 'before', crop);
        await take.hold(1000);
        await take.click(BTN, 'privacy-on', { dur: 550 });
        const tOn = take.events.at(-1).t;
        await take.waitFor(() => document.querySelectorAll('.mv-private').length > 0, 'masks', 5000);
        await take.hold(300);
        facts.privacyMasks = await browser.execute(() => document.querySelectorAll('.mv-private').length);
        await scan.at(take, 'masked', crop);
        await take.hold(2700);
        const end = take.t(Date.now());
        return { crop, segments: [{ t0: Math.max(0.2, tOn - 1.3), t1: end }], boxes: { btn } };
      });
    } finally {
      if ((await pressed()) === 'true') await browser.execute((s) => document.querySelector(s)?.click(), BTN);
      await browser.pause(600);
      facts.privacyAfter = await pressed();
    }
  });

  // 18. Light and dark: the sidebar's sun / moon flips the whole window and back.
  it('layouts', async function () {
    const TO_LIGHT = `button[title="${L('sidebar.switchLightMode')}"]`;
    const TO_DARK = `button[title="${L('sidebar.switchDarkMode')}"]`;
    const themeIs = (m) => document.documentElement.dataset.theme === m;
    try {
      await shoot(this, 'layouts', async (take, scan) => {
        const btn = await boxOf(TO_LIGHT);
        const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
        const W = 760, H = W / ASPECT;
        const crop = { x: 24, y: Math.round(Math.min(btn.y + btn.h + 10, vp.h - 4) - H), w: W, h: Math.round(H) };
        await scan.at(take, 'dark', crop);
        await take.hold(900);
        await take.click(TO_LIGHT, 'to-light', { dur: 550 });
        const tLight = take.events.at(-1).t;
        await take.waitFor(themeIs, 'light', 5000, 'light');
        await take.hold(300);
        await scan.at(take, 'light', crop);
        await take.hold(1700);
        await take.click(TO_DARK, 'to-dark', { dur: 450 });
        await take.waitFor(themeIs, 'dark', 5000, 'dark');
        await take.hold(1300);
        const end = take.t(Date.now());
        return { crop, segments: [{ t0: Math.max(0.2, tLight - 1.0), t1: end }], boxes: { btn } };
      });
    } finally {
      // The next take must start dark (Take.start checks FOOTAGE_THEME).
      if (await browser.execute(() => document.documentElement.dataset.theme !== 'dark')) {
        await browser.execute((s) => document.querySelector(s)?.click(), TO_DARK);
        await browser.pause(800);
      }
    }
  });

  // 20. Manual backup: Back up all accounts, progress, done.
  it('manual-backup', async function () {
    const ALL_BTN = '[data-testid="backup-all-button"]';
    const PROGRESS = '[data-testid="backup-all-progress"]';
    await shoot(this, 'manual-backup', async (take, scan) => {
      const btn = await boxOf(ALL_BTN);
      const page = await boxOf('[data-testid="settings-content"][data-page="backup"]');
      await take.hold(800);
      await take.click(ALL_BTN, 'back-up-all', { dur: 500 });
      const tClick = take.events.at(-1).t;
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'progress', 15000, PROGRESS);
      const tProgress = take.t(Date.now());
      const prog = await boxOf(PROGRESS);
      const steps = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 600000) {
        const st = await browser.execute((p, b) => ({
          progress: (document.querySelector(p)?.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
          disabled: !!document.querySelector(b)?.disabled,
        }), PROGRESS, ALL_BTN);
        const tt = Number(take.t(Date.now()).toFixed(3));
        if (!steps.length || steps.at(-1).progress !== st.progress || steps.at(-1).disabled !== st.disabled) steps.push({ t: tt, ...st });
        if (!st.progress && !st.disabled) break;
        await browser.pause(120);
      }
      facts.manualBackupSteps = steps;
      const tDone = steps.at(-1).t;
      if (steps.at(-1).progress || steps.at(-1).disabled) throw new Error(`backup never finished: ${JSON.stringify(steps.at(-1))}`);
      await take.hold(500);
      facts.manualBackupAfter = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').slice(0, 600), '[data-testid="settings-content"][data-page="backup"]');
      const crop = await fitCrop(union(btn, prog), { minW: 760 });
      await scan.at(take, 'done', crop);
      await take.hold(1800);
      const end = take.t(Date.now());
      console.log(`[footage] manual-backup ${JSON.stringify({ steps: steps.slice(0, 12), n: steps.length, after: facts.manualBackupAfter.slice(0, 300) })}`);
      // A long run keeps its first 2 s and its last second (the wait between is cut).
      const long = tDone - tProgress > 4;
      return {
        crop,
        segments: long
          ? [{ t0: Math.max(0.2, tClick - 0.9), t1: tProgress + 1.6, label: 'start' }, { t0: tDone - 1.0, t1: end, label: 'done' }]
          : [{ t0: Math.max(0.2, tClick - 0.9), t1: end }],
        boxes: { btn, prog, page },
      };
    }, {
      prepare: async () => {
        facts.manualBackupLocation = await seedBackupDrive();
        await browser.execute(() => window.__SETTINGS_STORE__.getState().setBackupGlobalEnabled?.(false));
        await settingsSetup(L('settings.tab.backup'), L('settings.backup.backupSchedule'));
        await waitPage((s) => !!document.querySelector(s), { timeout: 10000 }, ALL_BTN);
        await browser.execute((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), ALL_BTN);
        await browser.pause(900);
      },
    });
  });

  // 21. Custom fields: a message gets a stage, a tick and an owner in its field strip.
  it('custom-fields', async function () {
    const STAGE = 'web-stage', DONE = 'web-followup', OWNER = 'web-owner';
    const input = (id) => `[data-testid="field-input-${id}"]`;
    await shoot(this, 'custom-fields', async (take, scan) => {
      await take.hold(700);
      await take.click('[data-footage-target="cf-row"]', 'open-row', { dur: 500 });
      const tOpen = take.events.at(-1).t;
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'field strip', 12000, input(STAGE));
      await take.hold(700);
      const strip = await browser.execute((s) => {
        const el = document.querySelector(s)?.closest('[class*="field-strip"], [data-testid="field-strip"]') || document.querySelector(s)?.parentElement?.parentElement;
        const r = el?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      }, input(STAGE));
      const head = await boxOf('[data-testid="sender-header"]');
      const crop = await fitCrop(union(head, strip), { minW: 760 });
      // A choice of the Stage field: its label, a real press.
      if (!(await markExact(input(STAGE), 'label', 'Approved', 'cf-stage'))) throw new Error('no Approved choice');
      await take.click('[data-footage-target="cf-stage"]', 'stage-approved', { dur: 450 });
      await take.hold(600);
      await take.click(input(DONE), 'follow-up', { dur: 450 });
      await take.hold(500);
      await take.click(input(OWNER), 'owner', { dur: 450 });
      await take.type(input(OWNER), 'Rowan', 'owner', { base: 95, jitter: 25, seed: 4 });
      await browser.execute((s) => document.querySelector(s)?.blur(), input(OWNER));
      await take.hold(300);
      facts.customFieldsAfter = await browser.execute((s) => (document.querySelector(s)?.closest('div')?.parentElement?.innerText || '').replace(/\s+/g, ' ').slice(0, 300), input(STAGE));
      await scan.at(take, 'fields', crop);
      await take.hold(1800);
      const end = take.t(Date.now());
      console.log(`[footage] custom-fields ${JSON.stringify({ after: facts.customFieldsAfter, seed: facts.customFieldsSeed })}`);
      return { crop, segments: [{ t0: Math.max(0.2, tOpen + 0.15), t1: end }], boxes: { head, strip } };
    }, {
      prepare: async () => {
        // STAGED (disclose): three fields made through the daemon (the same
        // `fields.save` Settings > Mail preferences > Fields sends), then that
        // page opened once so the app loads them.
        const accountId = await browser.execute(() => window.__MAIL_STORE__?.getState?.().activeAccountId);
        facts.customFieldsSeed = [
          await rpc('fields.save', { field: { id: STAGE, scope: accountId, name: 'Stage', kind: 'multi_select', position: 0,
            options: [{ id: 'review', label: 'Review', color: '#d97706' }, { id: 'approved', label: 'Approved', color: '#16a34a' }, { id: 'paid', label: 'Paid', color: '#2563eb' }] } }),
          await rpc('fields.save', { field: { id: DONE, scope: accountId, name: 'Follow up', kind: 'checkbox', position: 1, options: [] } }),
          await rpc('fields.save', { field: { id: OWNER, scope: accountId, name: 'Owner', kind: 'text', position: 2, options: [] } }),
        ];
        await settingsSetupTab(L('settings.navigation.mailPreferences'), L('fields.section'));
        await waitPage((s) => !!document.querySelector(s), { timeout: 8000 }, `[data-testid="field-row-${STAGE}"]`);
        await browser.pause(500);
        await resetView();
        if (!(await tagRow('Priya Raines', 'cf-row'))) throw new Error('no row from Priya Raines on screen');
        await browser.pause(500);
      },
    });
  });

  // ── Batch 2, boot G (Apple Intelligence through the FM helper) ────────────

  // 22. AI writing: a rough paragraph, Shorten, the on-device rewrite.
  it('ai-writing', async function () {
    const ROUGH = 'Hi Theo, just checking in to see if there is any chance at all that the box sleeves could be ready by Thursday, '
      + 'since the client prints on Friday and we would really like to have them in hand before then. Thanks so much!';
    const AI = '[data-testid="compose-modal"] [data-testid="ai-compose-actions"] button';
    const CONFIRM = '[data-testid="ai-preview-confirm"]';
    const editorText = (s) => (document.querySelector(s)?.innerText || '').trim();
    await shoot(this, 'ai-writing', async (take, scan) => {
      const compose = await boxOf(SEL.compose);
      await take.hold(700);
      await take.click(AI, 'shorten', { text: L('ai.actions.shorten'), dur: 500 });
      const tShorten = take.events.at(-1).t;
      await take.waitFor((c) => !!document.querySelector(c)?.offsetHeight, 'review dialog', 10000, CONFIRM);
      await take.hold(300);
      facts.aiDialog = await browser.execute(() => {
        const pre = document.querySelector('[data-testid="ai-preview-text"]');
        const box = pre?.closest('[role="dialog"], .mail-dialog') || pre?.parentElement?.parentElement;
        return box ? (box.innerText || '').replace(/\s+/g, ' ') : null;
      });
      const dialog = await browser.execute((c) => {
        const box = document.querySelector(c)?.closest('[role="dialog"], .mail-dialog');
        const r = box?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      }, CONFIRM);
      await take.hold(1100);
      await take.click(CONFIRM, 'review-send', { dur: 450 });
      const g0 = Date.now();
      await take.waitFor((c, s, before) => !document.querySelector(c) && (document.querySelector(s)?.innerText || '').trim() !== before,
        'rewrite in the editor', 120000, CONFIRM, SEL.editor, facts.aiTyped);
      facts.aiGenerateSeconds = Number(since(g0));
      const tDone = take.t(Date.now());
      facts.aiResult = await browser.execute(editorText, SEL.editor);
      const editor = await boxOf(SEL.editor);
      const crop = await fitCrop(union(editor, dialog), { minW: 760 });
      await scan.at(take, 'result', crop);
      await take.hold(2200);
      const end = take.t(Date.now());
      console.log(`[footage] ai-writing ${facts.aiGenerateSeconds} s: ${JSON.stringify({ dialog: facts.aiDialog, result: facts.aiResult })}`);
      const tSend = take.events.at(-1).t;
      // A model slower than 1.5 s: the wait is cut.
      const slow = tDone - tSend > 1.5;
      return {
        crop,
        segments: slow
          ? [{ t0: Math.max(0.2, tShorten - 0.9), t1: tSend + 0.6, label: 'ask' }, { t0: tDone - 0.2, t1: end, label: 'result' }]
          : [{ t0: Math.max(0.2, tShorten - 0.9), t1: end }],
        boxes: { compose, dialog, editor },
      };
    }, {
      prepare: async () => {
        await aiOn();
        const mode = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().composeOpenMode);
        if (mode !== 'app') await setSetting('composeOpenMode', 'app');
        await clickSel('.mail-sidebar .sidebar-compose button');
        await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 10000 }, SEL.editor);
        await browser.pause(600);
        const prep = new Take('ai-writing-prep');
        await prep.type('[data-testid="compose-subject"]', 'Box sleeves', 'prep', { base: 30, jitter: 5 });
        await prep.typeRich(SEL.editor, ROUGH, 'prep', { base: 12, jitter: 4, caret: 'start' });
        facts.aiTyped = await browser.execute(editorText, SEL.editor);
        await browser.execute(() => document.activeElement?.blur?.());
        await waitPage((a, t) => [...document.querySelectorAll(a)].some((b) => b.offsetHeight > 0 && !b.disabled && (b.innerText || '').includes(t)),
          { timeout: 30000 }, AI, L('ai.actions.shorten'));
        await browser.pause(800);
      },
      allow: (o) => o.testid === 'compose-modal' || (o.box[2] >= 400 && o.box[3] >= 300),
    });
  });

  // 23. Tagging rules: a rule in plain words; new mail arrives while another
  // folder is open, and the Inbox shows it already tagged.
  //
  // Why not the Inbox itself (batch 2 tried it): a row's tags are fetched once,
  // when it first renders (tagStore requestRowTags skips a key it holds, and an
  // untagged answer is stored as []), and the Auto Tags worker emits no event
  // when it assigns. A row on screen when the mail lands keeps its empty chip
  // strip for the session. A row rendered after the verdict shows the tag, so
  // the take watches the arrival from another folder, waits (cut) until the
  // daemon holds the tag, then opens the Inbox. Nothing is set through a store
  // or a daemon write: the reads below only decide when to press.
  it('tagging-rules', async function () {
    const CARD = '[data-testid="settings-auto-tags"]';
    const NAME = `${CARD} input[aria-label="${L('autoTag.name')}"]`;
    const NEWTAG = `${CARD} input[aria-label="${L('autoTag.newTagPlaceholder')}"]`;
    const INSTR = `${CARD} textarea[aria-label="${L('autoTag.instruction')}"]`;
    const SUMMARY = `${CARD} details.settings-editor-details > summary`;
    const TOGGLE = '[data-testid="auto-tag-allow-remote"]';
    const CONFIRM = '[data-testid="ai-preview-confirm"]';
    const SAVE = `${CARD} .settings-editor-actions.justify-end button`;
    const INBOX = '[data-testid="folder-row"][data-path="INBOX"]';
    const TAG = process.env.FOOTAGE_TAG_NAME || 'Invoices';
    const SUBJECT = process.env.FOOTAGE_TAG_SUBJECT || 'Invoice 2026-0471 for the October print run';
    // Wordings tried off camera (auto_tags.preview, nothing written) before the
    // rule is typed; the first one Apple Intelligence matches to the demo's
    // invoice-like subjects (and not to the rest) is the one saved.
    const WORDINGS = process.env.FOOTAGE_TAG_RULE ? [process.env.FOOTAGE_TAG_RULE]
      : ['Invoices and bills', 'Invoices, bills and receipts from suppliers', 'Bank statements and invoices I need to pay or file'];
    let RULE_WORDS = WORDINGS[0];
    const work = (browser.demoAccounts || [])[0];
    const msgId = `web-tag-${Date.now()}@skewer.systems`;
    let other = null;
    const deliver = async () => {
      const client = new ImapFlow({ host: '127.0.0.1', port: work.imapPort, secure: false, auth: { user: work.email, pass: work.password }, logger: false });
      await client.connect();
      try {
        const now = new Date();
        // A real PDF attached (the model sees "Has attachments": batch 3's
        // first retake sent the text alone and Apple Intelligence said no).
        const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj '
          + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n').toString('base64');
        const B = `mv-${now.getTime()}`;
        const raw = Buffer.from([
          'From: Skewer Print <billing@skewer.systems>', `To: ${work.name || 'Rowan Marsh'} <${work.email}>`, `Subject: ${SUBJECT}`,
          `Date: ${now.toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${msgId}>`, 'MIME-Version: 1.0',
          `Content-Type: multipart/mixed; boundary="${B}"`, '', `--${B}`,
          'Content-Type: text/plain; charset=utf-8', '', 'Hi Rowan,', '', 'Attached is the invoice for the October print run: 2,400 box sleeves.',
          'Payment is due in 14 days.', '', 'Skewer Print', '', `--${B}`,
          'Content-Type: application/pdf; name="Invoice-2026-0471.pdf"', 'Content-Disposition: attachment; filename="Invoice-2026-0471.pdf"',
          'Content-Transfer-Encoding: base64', '', ...pdf.match(/.{1,76}/g), `--${B}--`, '',
        ].join('\r\n'));
        return await client.append('INBOX', raw, [], now);
      } finally { await client.logout(); }
    };
    // Read-only looks at the daemon's own files (sqlite3 -readonly), for the report.
    const sql = (file, q) => {
      try {
        const db = execFileSync('/usr/bin/find', [browser.footageDataDir || process.env.FOOTAGE_DATA_DIR, '-name', file, '-not', '-path', '*/snapshots/*'], { encoding: 'utf8' }).split('\n').filter(Boolean)[0];
        if (!db) return { error: `no ${file}` };
        return { db, out: execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', db, q], { encoding: 'utf8', timeout: 10000 }).trim() };
      } catch (e) { return { error: String(e?.message || e).slice(0, 300) }; }
    };
    const daemonTags = async (uid) => {
      const r = await rpc('tags.for_messages', { items: [{ accountId: work.id, mailbox: 'INBOX', uid, messageId: `<${msgId}>` }] });
      return r.ok?.tags?.[0] || [];
    };
    const diagnose = async (uid) => {
      facts.tagDecisions = sql('app.db', 'SELECT rule_id, account_id, msg_key, matched, at FROM auto_tag_decisions');
      facts.tagAssignments = sql('app.db', `SELECT * FROM tag_assignments WHERE msg_key = '${msgId}'`);
      facts.tagHeader = sql('custody.db', `SELECT uid, sort_ms, json_extract(header_json, '$.date') AS date, json_extract(header_json, '$.internalDate') AS internal, json_extract(header_json, '$.messageId') AS mid FROM header_cache WHERE mailbox_path = 'INBOX' AND uid = ${Number(uid)}`);
      const rules = (await rpc('auto_tags.list', {})).ok || [];
      facts.tagRuleAtProbe = rules[0] ? { enabledAt: rules[0].enabledAt, provider: rules[0].provider, allowRemote: rules[0].allowRemote } : null;
      if (rules[0]) {
        await browser.setTimeout({ script: 300000 });
        const pv = await rpc('auto_tags.preview', { accountId: work.id, provider: rules[0].provider || { type: 'appleFm' }, limit: 1, ruleId: rules[0].id });
        facts.tagPreview = pv.error ? { error: pv.error } : (pv.ok?.candidates || []).map((c) => ({ subject: c.subject, matched: c.matched, confidence: c.confidence, refused: c.refused }));
      }
      console.log(`[footage] tagging-rules diagnosis ${JSON.stringify({ decisions: facts.tagDecisions, assignments: facts.tagAssignments, header: facts.tagHeader, rule: facts.tagRuleAtProbe, preview: facts.tagPreview })}`);
    };
    await shoot(this, 'tagging-rules', async (take, scan) => {
      // 1. The rule, in Settings > Auto Tags: its name and its plain words. The
      // line under them ("Keep in Inbox · Allow a remote AI provider") stays
      // below the crop.
      await settingsSetup(L('autoTag.tabLabel'), null);
      await waitPage((s) => !!document.querySelector(s), { timeout: 15000 }, CARD);
      await browser.pause(600);
      // Measured once the dialog has stopped scaling in (two equal reads).
      const measure = () => browser.execute((c) => {
        const row = [...document.querySelectorAll(`${c} .space-y-3 > div`)].find((d) => d.querySelector('button[role="switch"]'));
        const instr = row?.querySelector('.truncate + .truncate, .text-xs.truncate');
        const r = row?.getBoundingClientRect(), i = instr?.getBoundingClientRect();
        return r && i ? { x: r.x, y: r.y, w: r.width, h: r.height, instrBottom: i.bottom, instr: (instr.textContent || '').slice(0, 80) } : null;
      }, CARD);
      let ruleBox = await measure();
      for (let k = 0; k < 20; k++) {
        await browser.pause(250);
        const again = await measure();
        if (ruleBox && again && JSON.stringify(again) === JSON.stringify(ruleBox)) break;
        ruleBox = again;
      }
      if (!ruleBox) throw new Error('no rule row in Auto Tags');
      facts.tagRuleBox = ruleBox;
      // The row sits high in Settings: the crop runs from the top of the page
      // down to the instruction line, so it is as tall as that and no taller.
      const H1 = Math.min(480, ruleBox.instrBottom + 2 - 4), W1 = H1 * ASPECT;
      const cropRule = { x: Math.round(ruleBox.x - 16), y: Math.round(ruleBox.instrBottom + 2 - H1), w: Math.round(W1), h: Math.round(H1) };
      if (cropRule.y < 4 || W1 < 400) throw new Error(`rule crop does not fit: ${JSON.stringify(cropRule)}`);
      // The "Allow a remote AI provider" line must sit wholly below the crop.
      const remoteTop = await browser.execute((c, t) => {
        const el = [...document.querySelectorAll(`${c} .space-y-3 div`)].find((d) => d.children.length === 0 && (d.textContent || '').includes(t));
        return el ? el.getBoundingClientRect().top : null;
      }, CARD, L('autoTag.allowRemote'));
      facts.tagRemoteLineTop = remoteTop;
      if (remoteTop != null && remoteTop < cropRule.y + cropRule.h) throw new Error(`remote-provider line inside the rule crop (${remoteTop} < ${cropRule.y + cropRule.h})`);
      await scan.at(take, 'rule', cropRule);
      const tRule0 = take.t(Date.now());
      await take.hold(1900);
      const tRule1 = take.t(Date.now());
      // 2. New mail arrives while another folder is open (cut: delivery and the verdict).
      const t0 = Date.now();
      const appended = await deliver();
      const uid = Number(appended?.uid ?? -1);
      facts.tagAppend = { uid, msgId };
      let tags = [];
      const w0 = Date.now();
      while (Date.now() - w0 < 120000) {
        tags = await daemonTags(uid);
        if (tags.length) break;
        await browser.pause(500);
      }
      facts.tagAssignedMs = tags.length ? Date.now() - t0 : null;
      if (!tags.length) {
        await diagnose(uid);
        throw new Error(`the daemon never tagged the arriving invoice (uid ${uid}) in ${since(w0)} s`);
      }
      await clickSel(CLOSE_SETTINGS);
      await waitPage(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, { timeout: 8000 });
      await browser.execute(() => document.activeElement?.blur?.());
      await browser.pause(600);
      // 3. The Inbox opens: the invoice is there, tagged.
      const inboxRow = await boxOf(INBOX);
      const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const W2 = 760, H2 = W2 / ASPECT;
      const cropSide = { x: 4, y: Math.round(Math.max(4, Math.min(inboxRow.y - H2 / 2, vp.h - 26 - H2))), w: W2, h: Math.round(H2) };
      await scan.at(take, 'other-folder', cropSide);
      const tSide0 = take.t(Date.now());
      await take.hold(500);
      await take.click(INBOX, 'open-inbox', { dur: 600 });
      const tOpen = take.events.at(-1).t;
      const tagged = (s, n) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => r.getBoundingClientRect().height > 0 && (r.innerText || '').includes(s));
        return !!row && (row.innerText || '').includes(n);
      };
      const shown = await waitPage(tagged, { timeout: 10000, interval: 100 }, SUBJECT, TAG);
      facts.tagRow = await browser.execute((s) => ([...document.querySelectorAll('[data-testid="email-row"]')].find((r) => (r.innerText || '').includes(s))?.innerText || '').replace(/\s+/g, ' '), SUBJECT);
      if (!shown) { await diagnose(uid); throw new Error(`Inbox opened but the row shows no ${TAG} chip: ${facts.tagRow}`); }
      const tShown = take.t(Date.now());
      const cropList = await listCrop();
      await scan.at(take, 'tagged', cropList);
      await take.hold(2600);
      const end = take.t(Date.now());
      await diagnose(uid);
      console.log(`[footage] tagging-rules ${JSON.stringify({ assignedMs: facts.tagAssignedMs, shownAfterOpen: Number((tShown - tOpen).toFixed(2)), row: facts.tagRow, other, words: facts.tagRuleWords })}`);
      return {
        crop: cropRule,
        segments: [
          { t0: tRule0 + 0.1, t1: tRule1, crop: cropRule, label: 'rule' },
          { t0: Math.max(tSide0, tOpen - 0.7), t1: tOpen + 0.12, crop: cropSide, label: 'open-inbox' },
          { t0: Math.max(tOpen + 0.13, tShown), t1: end, crop: cropList, label: 'tagged' },
        ],
        poster: 3.6,
        boxes: { ruleBox, inboxRow },
      };
    }, {
      prepare: async () => {
        // STAGED (disclose): the rule is made off camera through Settings >
        // Auto Tags (name, new tag, Apple Intelligence through the "remote
        // provider" switch, the rule in plain words, Enabled, Save); then
        // another folder is opened. The take is the arrival and the Inbox.
        await aiOn();
        await settingsSetup(L('autoTag.tabLabel'), null);
        await waitPage((s) => !!document.querySelector(s), { timeout: 15000 }, CARD);
        await clickSel(`${CARD} button`, L('autoTag.newRule'));
        await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 8000 }, NAME);
        const prep = new Take('tagging-rules-prep');
        await prep.type(NAME, TAG, 'prep', { base: 30, jitter: 5 });
        await prep.type(NEWTAG, TAG, 'prep', { base: 30, jitter: 5 });
        await clickSel(`${CARD} button`, L('autoTag.newTag'));
        if (!(await waitPage((s) => document.querySelector(s)?.value === '', { timeout: 8000 }, NEWTAG))) throw new Error('tag not created');
        await clickSel(SUMMARY);
        await browser.pause(400);
        // Without it the rule saves provider null and the worker asks the
        // local GGUF model, which the mini does not have (AutoTagSettings.jsx:68).
        await clickSel(TOGGLE);
        if (await waitPage((c) => !!document.querySelector(c)?.offsetHeight, { timeout: 8000 }, CONFIRM)) await clickSel(CONFIRM);
        await browser.pause(600);
        // Off camera: which wording the model reads as meant (preview over the
        // newest cached headers; it writes nothing).
        await browser.setTimeout({ script: 600000 });
        facts.tagWordings = [];
        for (const words of WORDINGS) {
          const pv = await rpc('auto_tags.preview', { accountId: work.id, provider: { type: 'appleFm' }, limit: 30,
            rule: { name: TAG, instruction: words, constraints: {}, tagId: 'probe', inboxAction: 'keep', minConfidence: 0.7, allowRemote: true, enabled: false } });
          const rows = pv.ok?.candidates || [];
          const bill = (c) => /invoice|bill|receipt|statement|payment/i.test(c.subject || '');
          const r = { words, error: pv.error || null, n: rows.length,
            hit: rows.filter((c) => bill(c) && c.matched).length, miss: rows.filter((c) => bill(c) && !c.matched).length,
            wrong: rows.filter((c) => !bill(c) && c.matched).length, refused: rows.filter((c) => c.refused).length,
            billSubjects: rows.filter(bill).map((c) => `${c.matched ? '+' : '-'} ${c.subject}`).slice(0, 6) };
          facts.tagWordings.push(r);
          console.log(`[setup] tagging wording ${JSON.stringify(r)}`);
          if (r.hit > 0 && r.wrong <= 1) { RULE_WORDS = words; break; }
        }
        facts.tagRuleWords = RULE_WORDS;
        await prep.type(INSTR, RULE_WORDS, 'prep', { base: 30, jitter: 5 });
        if ((await browser.execute(() => document.querySelector('[data-testid="auto-tag-enabled-editor"]')?.getAttribute('aria-checked'))) !== 'true') {
          await clickSel('[data-testid="auto-tag-enabled-editor"]');
        }
        await browser.pause(400);
        await clickSel(SAVE, L('common.save'));
        await waitPage((s) => !document.querySelector(s), { timeout: 8000 }, NAME);
        facts.tagRules = await rpc('auto_tags.list', {});
        console.log(`[setup] tagging rule: ${JSON.stringify(facts.tagRules).slice(0, 600)}`);
        await resetView();
        await widenList();
        // Another folder of the work account (Sent when there is one).
        other = await browser.execute(() => {
          const rows = [...document.querySelectorAll('[data-testid="folder-row"]')].filter((r) => r.offsetHeight > 0 && r.dataset.path !== 'INBOX');
          const pick = rows.find((r) => /sent/i.test(r.dataset.path)) || rows[0];
          if (!pick) return null;
          pick.setAttribute('data-footage-target', 'tag-other');
          return pick.dataset.path;
        });
        if (!other) throw new Error('no other folder to wait in');
        await clickSel('[data-footage-target="tag-other"]');
        await waitPage((p) => window.__MAIL_STORE__?.getState?.().activeMailbox === p, { timeout: 10000 }, other);
        // The IDLE watcher re-arms on its own; give it time, as batch 2 did.
        await browser.pause(5000);
        await browser.execute(() => document.activeElement?.blur?.());
      },
    });
    await restoreList();
  });

  // ── Batch 3, boot H (the demo mailbox alone; "Change almost anything" and small things) ──

  // List takes: the list pane widened off camera (a remembered pane size, as a
  // drag of the divider would leave it), so a 760 pt crop holds the list and
  // nothing of the sidebar or the empty reader; the crop starts at the list's
  // toolbar, below the header whose date range ends today.
  let savedListWidth = null;
  const widenList = async () => {
    savedListWidth = await browser.execute(() => window.__SETTINGS_STORE__.getState().listPaneSize);
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setListPaneSize(600));
    await browser.pause(700);
  };
  const restoreList = async () => {
    if (savedListWidth != null) await browser.execute((w) => window.__SETTINGS_STORE__.getState().setListPaneSize(w), savedListWidth);
    await browser.pause(500);
  };
  const listCrop = async () => {
    const tb = await boxOf('.mail-list-toolbar');
    const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
    // The pane's own width (the list is at most 600 pt wide): no reader at the right edge.
    const W = Math.round(Math.min(760, Math.max(560, tb.w + 14))), H = W / ASPECT;
    return { x: Math.round(Math.max(4, Math.min(tb.x - 7, vp.w - 4 - W))), y: Math.round(tb.y - 6), w: W, h: Math.round(H) };
  };

  // 24. Quick actions (retake): the reader's toolbar, the Gmail action set, the toolbar again.
  // The same tight crop on the toolbar before and after, the preset press in between.
  it('quick-actions', async function () {
    const BAR = '.email-action-bar';
    const PRESET = '.quick-actions-presets .choice-card-button';
    const barText = () => [...document.querySelectorAll('.email-action-bar [data-quick-action]')]
      .filter((b) => b.offsetHeight > 0).map((b) => b.dataset.quickAction).join(',');
    const openQuickActions = async () => {
      await settingsSetupTab(L('settings.appearance.appearance'), L('quickActions.title'));
      await waitPage(() => !!document.querySelector('.quick-actions-settings')?.offsetHeight, { timeout: 8000 });
      await markExact('.quick-actions-settings', '[role="tab"]', L('quickActions.surface.reader'), 'qa-surface');
      await clickSel('[data-footage-target="qa-surface"]');
      await browser.pause(700);
      await browser.execute(() => document.activeElement?.blur?.());
    };
    await shoot(this, 'quick-actions', async (take, scan) => {
      const bar = await boxOf(BAR);
      const head = await boxOf('[data-testid="sender-header"]');
      const W = Math.min(760, Math.max(560, bar.w * 0.62)), H = W / ASPECT;
      const vpq = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const cropBar = { x: Math.round(Math.min(bar.x - 12, vpq.w - 4 - W)), y: Math.round(Math.max(4, bar.y - 14)), w: Math.round(W), h: Math.round(H) };
      await scan.at(take, 'before', cropBar);
      await take.hold(1700);
      const tBefore = take.t(Date.now());
      // Into Settings (cut from the clip).
      await openQuickActions();
      const presets = await boxOf('.quick-actions-presets');
      const cropSettings = await fitCrop(presets, { minW: 640, pad: 16 });
      await scan.at(take, 'settings', cropSettings);
      await take.hold(500);
      const tSettings = take.t(Date.now());
      await take.click(PRESET, 'preset-gmail', { text: L('quickActions.preset.gmail'), dur: 500 });
      const tPreset = take.events.at(-1).t;
      await take.hold(1000);
      await take.click(CLOSE_SETTINGS, 'close-settings', { dur: 450 });
      const tClose = take.events.at(-1).t;
      await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 8000);
      await take.hold(300);
      facts.quickActionsBarAfter = await browser.execute(barText);
      await scan.at(take, 'after', cropBar);
      await take.hold(2100);
      const end = take.t(Date.now());
      console.log(`[footage] quick-actions ${JSON.stringify({ before: facts.quickActionsBarBefore, after: facts.quickActionsBarAfter })}`);
      if (facts.quickActionsBarAfter === facts.quickActionsBarBefore) throw new Error('the reader toolbar did not change with the preset');
      return {
        crop: cropBar,
        segments: [
          { t0: 0.3, t1: tBefore, crop: cropBar, label: 'before' },
          { t0: Math.max(tSettings, tPreset - 0.8), t1: tClose + 0.03, crop: cropSettings, label: 'preset' },
          { t0: tClose + 0.35, t1: end, crop: cropBar, label: 'after' },
        ],
        poster: 4.2,
        boxes: { bar, head, presets },
      };
    }, {
      prepare: async () => {
        if (!(await tagRow('Priya Raines', 'qa-row'))) throw new Error('no row from Priya Raines on screen');
        await clickSel('[data-footage-target="qa-row"]');
        await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 10000 }, BAR);
        await browser.pause(800);
        await browser.execute(() => document.activeElement?.blur?.());
        facts.quickActionsBarBefore = await browser.execute(barText);
      },
    });
    try {
      await openQuickActions();
      await clickSel(PRESET, L('quickActions.preset.mailvault'));
      await browser.pause(500);
    } catch (e) { facts.quickActionsResetError = e.message; }
  });

  // 25. Explorer: the list switches to Explorer, the mail regroups by month; one group opens.
  it('explorer-view', async function () {
    const EXP = '[data-testid="explorer-view"]';
    await shoot(this, 'explorer-view', async (take, scan) => {
      const bar = await boxOf('.mail-list-toolbar');
      const rows = await rowsBox(8);
      const crop = await listCrop();
      await scan.at(take, 'list', crop);
      await take.hold(900);
      await take.click(SEL.explorer, 'explorer', { dur: 550 });
      const tExp = take.events.at(-1).t;
      await take.waitFor((e) => !!document.querySelector(`${e} [data-testid="explorer-group-row"]`)?.offsetHeight, 'groups', 8000, EXP);
      await take.hold(400);
      facts.explorerGroups = await browser.execute(() => [...document.querySelectorAll('[data-testid="explorer-group-row"]')].slice(0, 8)
        .map((r) => (r.innerText || '').replace(/\s+/g, ' ').slice(0, 60)));
      await scan.at(take, 'groups', crop);
      await take.hold(1300);
      // The first group with more than one message, opened.
      const opened = await browser.execute(() => {
        const rows = [...document.querySelectorAll('[data-testid="explorer-group-row"]')].filter((r) => r.offsetHeight > 0);
        const pick = rows.find((r) => /\b([2-9]|\d\d+)\b/.test(r.innerText || '')) || rows[0];
        const btn = pick?.querySelector('[data-testid="explorer-group-open"]');
        if (!btn) return null;
        btn.setAttribute('data-footage-target', 'exp-group');
        return (pick.innerText || '').replace(/\s+/g, ' ').slice(0, 60);
      });
      if (!opened) throw new Error('no explorer group to open');
      facts.explorerOpened = opened;
      await take.click('[data-footage-target="exp-group"]', 'open-group', { dur: 500 });
      await take.waitFor(() => !!document.querySelector('[data-testid="explorer-back"]')?.offsetHeight, 'inside group', 8000);
      await take.hold(400);
      await scan.at(take, 'inside', crop);
      await take.hold(1700);
      const end = take.t(Date.now());
      console.log(`[footage] explorer-view ${JSON.stringify({ groups: facts.explorerGroups, opened })}`);
      return { crop, segments: [{ t0: Math.max(0.2, tExp - 1.0), t1: end }], boxes: { bar, rows } };
    }, { prepare: widenList });
    await browser.execute((s) => document.querySelector(s)?.click(), SEL.list);
    await restoreList();
    await browser.pause(800);
  });

  // 26. Column layout: three columns, Settings > Layout > "Below the list", the
  // reader moves under the list. Whole-window crops either side of the press.
  it('column-layout', async function () {
    const SEG = '[data-testid="appearance-layout-section"] .settings-segments button';
    await shoot(this, 'column-layout', async (take, scan) => {
      const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
      // The whole window from the list toolbar down (the header above carries today's date).
      const tb = await boxOf('.mail-list-toolbar');
      const top = Math.round(tb.y - 6), hAll = vp.h - 4 - top;
      const cropAll = { x: 4, y: top, w: Math.round(hAll * ASPECT), h: Math.round(hAll) };
      await scan.at(take, 'three', cropAll);
      await take.hold(1500);
      const tBefore = take.t(Date.now());
      await settingsSetupTab(L('settings.appearance.appearance'), L('settings.appearance.layout'));
      await waitPage((s) => !!document.querySelector(s), { timeout: 8000 }, SEG);
      await browser.execute((s, t) => [...document.querySelectorAll(s)].find((b) => (b.textContent || '').includes(t))
        ?.closest('.settings-row, [class*="setting-row"], div')?.scrollIntoView({ block: 'center' }), SEG, L('workspace.belowList'));
      await browser.pause(700);
      const row = await browser.execute((s, t) => {
        const g = document.querySelector(s)?.closest('[role="group"]');
        // The row's own label (the Mail view example above also says "Reading pane").
        const gr = g?.getBoundingClientRect();
        const lab = gr && [...document.querySelectorAll('[data-testid="appearance-layout-section"] *')]
          .filter((e) => e.children.length === 0 && (e.textContent || '').trim() === t)
          .sort((a, b) => Math.abs(a.getBoundingClientRect().y - gr.y) - Math.abs(b.getBoundingClientRect().y - gr.y))[0];
        const rs = [g, lab].filter(Boolean).map((e) => e.getBoundingClientRect());
        // and the row's example below the buttons (it redraws with the choice)
        rs.push({ x: gr.x, y: gr.y, right: gr.right, bottom: gr.bottom + 150 });
        if (!rs.length) return null;
        const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
        const x1 = Math.max(...rs.map((r) => r.right)), y1 = Math.max(...rs.map((r) => r.bottom));
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }, SEG, L('workspace.readingPane'));
      const cropSet = await fitCrop(row, { minW: 640, pad: 24 });
      await scan.at(take, 'setting', cropSet);
      await take.hold(400);
      const tSet = take.t(Date.now());
      await take.click(SEG, 'below-list', { text: L('workspace.belowList'), dur: 500 });
      const tPress = take.events.at(-1).t;
      await take.waitFor(() => window.__SETTINGS_STORE__?.getState?.().layoutMode === 'two-column', 'two-column', 4000);
      await take.hold(900);
      await take.click(CLOSE_SETTINGS, 'close-settings', { dur: 450 });
      const tClose = take.events.at(-1).t;
      await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 8000);
      await take.hold(300);
      facts.columnDivider = await browser.execute(() => document.querySelector('.mail-pane-divider')?.getAttribute('aria-orientation'));
      await scan.at(take, 'two', cropAll);
      await take.hold(2000);
      const end = take.t(Date.now());
      return {
        crop: cropAll,
        segments: [
          { t0: 0.3, t1: tBefore, crop: cropAll, label: 'three' },
          { t0: Math.max(tSet, tPress - 0.8), t1: tClose + 0.03, crop: cropSet, label: 'setting' },
          { t0: tClose + 0.35, t1: end, crop: cropAll, label: 'two' },
        ],
        poster: 4.0,
        boxes: { row },
      };
    }, {
      prepare: async () => {
        await browser.execute(() => window.__SETTINGS_STORE__.getState().setLayoutMode('three-column'));
        if (!(await tagRow('Priya Raines', 'cl-row'))) throw new Error('no row from Priya Raines on screen');
        await clickSel('[data-footage-target="cl-row"]');
        await waitPage(() => !!document.querySelector('.email-action-bar')?.offsetHeight, { timeout: 10000 });
        await browser.pause(800);
        await browser.execute(() => document.activeElement?.blur?.());
      },
    });
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setLayoutMode('three-column'));
    await browser.pause(800);
  });

  // 27. Shortcuts: Star moves from S to L in Settings, then L stars the open message.
  // The chip's recording state ("Press key" with a literal … in en.json) is cut.
  it('shortcuts', async function () {
    const KEY = process.env.FOOTAGE_SHORTCUT_KEY || 'l';
    const label = L('settings.shortcuts.toggleStar');
    const CHIP = `[data-testid="settings-shortcuts"] button[aria-label="${label}: s"]`;
    const STAR = '[data-footage-target="sc-row"] [data-testid="star-toggle"]';
    const starred = () => browser.execute((s) => document.querySelector(s)?.getAttribute('aria-pressed'), STAR);
    await shoot(this, 'shortcuts', async (take, scan) => {
      const chipRow = await browser.execute((s) => {
        const r = document.querySelector(s)?.parentElement?.parentElement?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      }, CHIP);
      const cropChip = await fitCrop(chipRow, { minW: 560, pad: 20 });
      await scan.at(take, 'chip', cropChip);
      await take.hold(800);
      await take.click(CHIP, 'rebind-star', { dur: 550 });
      const tChip = take.events.at(-1).t;
      await browser.pause(250);
      await browser.execute((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })), KEY);
      take.note('key-rebind', Number(take.t(Date.now()).toFixed(3)));
      await take.waitFor((k) => window.__SETTINGS_STORE__?.getState?.().keyboardShortcuts?.toggleStar === k, 'rebound', 4000, KEY);
      await take.waitFor((t, k) => [...document.querySelectorAll('[data-testid="settings-shortcuts"] button')]
        .some((b) => (b.getAttribute('aria-label') || '') === `${t}: ${k}` && !/\\u|…/.test(b.textContent || '')), 'chip shows key', 4000, label, KEY);
      await take.hold(150);
      const tSaved = take.t(Date.now());
      facts.shortcutChip = await browser.execute((t, k) => [...document.querySelectorAll('[data-testid="settings-shortcuts"] button')]
        .find((b) => (b.getAttribute('aria-label') || '') === `${t}: ${k}`)?.textContent, label, KEY);
      await scan.at(take, 'saved', cropChip);
      await take.hold(1100);
      await take.click(CLOSE_SETTINGS, 'close-settings', { dur: 450 });
      const tClose = take.events.at(-1).t;
      await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings closed', 8000);
      const row = await boxOf('[data-footage-target="sc-row"]');
      const head = await boxOf('[data-testid="sender-header"]');
      const cropRow = await listCrop();
      await take.hold(900);
      const before = await starred();
      await browser.execute((k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })), KEY);
      const tKey = take.t(Date.now());
      take.note('key-star', Number(tKey.toFixed(3)));
      await take.waitFor((s, b) => document.querySelector(s)?.getAttribute('aria-pressed') !== b, 'starred', 4000, STAR, before);
      facts.shortcutStar = { before, after: await starred() };
      await scan.at(take, 'starred', cropRow);
      await take.hold(2000);
      const end = take.t(Date.now());
      console.log(`[footage] shortcuts ${JSON.stringify({ chip: facts.shortcutChip, star: facts.shortcutStar })}`);
      return {
        crop: cropChip,
        segments: [
          { t0: Math.max(0.2, tChip - 1.0), t1: tChip, crop: cropChip, label: 'chip' },
          { t0: tSaved, t1: tClose + 0.03, crop: cropChip, label: 'saved' },
          { t0: tClose + 0.4, t1: end, crop: cropRow, label: 'star' },
        ],
        poster: 4.0,
        boxes: { chipRow, row, head },
      };
    }, {
      prepare: async () => {
        await widenList();
        await browser.execute(() => window.__SETTINGS_STORE__.getState().setKeyboardShortcut('toggleStar', 's'));
        // An unstarred message open in the reader.
        const ok = await browser.execute(() => {
          const row = [...document.querySelectorAll('[data-testid="email-row"]')]
            .find((r) => r.offsetHeight > 0 && r.querySelector('[data-testid="star-toggle"]')?.getAttribute('aria-pressed') === 'false' && (r.innerText || '').includes('Priya'))
            || [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => r.offsetHeight > 0 && r.querySelector('[data-testid="star-toggle"]')?.getAttribute('aria-pressed') === 'false');
          if (!row) return false;
          row.setAttribute('data-footage-target', 'sc-row');
          return true;
        });
        if (!ok) throw new Error('no unstarred row with a star toggle');
        await clickSel('[data-footage-target="sc-row"]');
        await waitPage(() => !!document.querySelector('.email-action-bar')?.offsetHeight, { timeout: 10000 });
        await browser.pause(600);
        await settingsSetupTab(L('settings.navigation.mailPreferences'), L('settings.shortcuts.keyboardShortcuts'));
        if (!(await waitPage((s) => !!document.querySelector(s), { timeout: 8000 }, CHIP))) throw new Error(`no chip ${CHIP}`);
        await browser.execute((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), CHIP);
        await browser.pause(700);
        await browser.execute(() => document.activeElement?.blur?.());
      },
    });
    await browser.execute(() => window.__SETTINGS_STORE__.getState().setKeyboardShortcut('toggleStar', 's'));
    if ((await starred()) === 'true') await browser.execute((s) => document.querySelector(s)?.click(), STAR);
    await restoreList();
  });

  // 28. Notification rules: one account's folders opened, Archive added; another account off.
  it('notification-rules', async function () {
    const PAGE = '[data-testid="settings-notifications"]';
    await shoot(this, 'notification-rules', async (take, scan) => {
      const block = await browser.execute((p) => {
        const list = document.querySelector(`${p} .space-y-1`);
        const r = (list?.parentElement || list)?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
      }, PAGE);
      const W = 680, H = W / ASPECT;
      const crop = { x: Math.round(block.x + block.w / 2 - W / 2), y: Math.round(block.y - 14), w: W, h: Math.round(H) };
      await scan.at(take, 'before', crop);
      await take.hold(800);
      if (!(await browser.execute((p) => {
        const btn = document.querySelector(`${p} button[title]`);
        const all = [...document.querySelectorAll(`${p} .space-y-1 > div`)];
        const chev = all[0]?.querySelector('button[title]');
        if (!chev) return false;
        chev.setAttribute('data-footage-target', 'nr-chevron');
        return !!btn;
      }, PAGE))) throw new Error('no Configure folders chevron');
      await take.click('[data-footage-target="nr-chevron"]', 'configure-folders', { dur: 500 });
      const tOpen = take.events.at(-1).t;
      await take.waitFor((p) => !!document.querySelector(`${p} input[type="checkbox"]`)?.offsetHeight, 'folders', 4000, PAGE);
      await take.hold(500);
      if (!(await browser.execute((p) => {
        const lab = [...document.querySelectorAll(`${p} .space-y-1 label`)].find((l) => (l.innerText || '').trim() === 'Archive');
        if (!lab) return false;
        lab.querySelector('input')?.setAttribute('data-footage-target', 'nr-archive');
        return true;
      }, PAGE))) throw new Error('no Archive folder checkbox');
      await take.click('[data-footage-target="nr-archive"]', 'archive-folder', { dur: 500 });
      await take.waitFor(() => !!document.querySelector('[data-footage-target="nr-archive"]')?.checked, 'archive checked', 3000);
      await take.hold(700);
      if (!(await browser.execute((p) => {
        const cards = [...document.querySelectorAll(`${p} .space-y-1 > div`)].filter((c) => c.querySelector('button[role="switch"]'));
        const sw = cards[Math.min(2, cards.length - 1)]?.querySelector('button[role="switch"]');
        if (!sw || cards.length < 2) return false;
        sw.setAttribute('data-footage-target', 'nr-toggle');
        return true;
      }, PAGE))) throw new Error('no second account toggle');
      const TOG = '[data-footage-target="nr-toggle"]';
      await take.click(TOG, 'account-off', { dur: 550 });
      await take.waitFor((s) => document.querySelector(s)?.getAttribute('aria-checked') === 'false', 'account off', 3000, TOG);
      await scan.at(take, 'after', crop);
      await take.hold(1900);
      const end = take.t(Date.now());
      facts.notificationSettings = await browser.execute(() => JSON.stringify(window.__SETTINGS_STORE__.getState().notificationSettings?.accounts || {}).slice(0, 400));
      return { crop, segments: [{ t0: Math.max(0.2, tOpen - 1.0), t1: end }], boxes: { block } };
    }, {
      prepare: async () => {
        await browser.execute(() => window.__SETTINGS_STORE__.getState().setNotificationEnabled?.(true));
        await settingsSetupTab(L('settings.navigation.mailPreferences'), L('settings.notifications.notifications'));
        await waitPage((p) => !!document.querySelector(`${p} button[role="switch"]`), { timeout: 8000 }, PAGE);
        await browser.execute((p) => document.querySelector(`${p} .space-y-1`)?.scrollIntoView({ block: 'center' }), PAGE);
        await browser.pause(800);
        await browser.execute(() => document.activeElement?.blur?.());
      },
      allow: (o) => o.testid === 'settings-page' || (o.box[2] >= 900 && o.box[3] >= 500),
    });
  });

  // 29. Templates: in a new message, Templates, pick one, the text is in.
  it('templates', async function () {
    const NAME = 'Print quote';
    const BODY = 'Thanks for the brief. For 2,400 box sleeves on 350 gsm board the price is 1,180 EUR, ready in eight working days.';
    await shoot(this, 'templates', async (take, scan) => {
      const compose = await boxOf(SEL.compose);
      const crop = await fitCrop(compose, { minW: 760, pad: 8 });
      await scan.at(take, 'empty', crop);
      await take.hold(800);
      await take.click('[data-testid="compose-templates-btn"]', 'templates', { dur: 550 });
      const tBtn = take.events.at(-1).t;
      await take.waitFor(() => !!document.querySelector('[data-testid="compose-template-item"]')?.offsetHeight, 'menu', 4000);
      await take.hold(700);
      await take.click('[data-testid="compose-template-item"]', 'pick', { text: NAME, dur: 500 });
      await take.waitFor((s) => (document.querySelector(s)?.innerText || '').includes('2,400'), 'inserted', 4000, SEL.editor);
      await take.hold(300);
      facts.templateEditor = await browser.execute((s) => (document.querySelector(s)?.innerText || '').slice(0, 200), SEL.editor);
      await scan.at(take, 'inserted', crop);
      await take.hold(2100);
      const end = take.t(Date.now());
      return { crop, segments: [{ t0: Math.max(0.2, tBtn - 1.0), t1: end }], boxes: { compose } };
    }, {
      prepare: async () => {
        // STAGED (disclose): the template saved through the settings store
        // (the same addEmailTemplate Settings > Templates calls); the subject typed off camera.
        await browser.execute((n, b) => {
          const st = window.__SETTINGS_STORE__.getState();
          if (!(st.emailTemplates || []).some((x) => x.name === n)) st.addEmailTemplate(n, b);
        }, NAME, BODY);
        const mode = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().composeOpenMode);
        if (mode !== 'app') await setSetting('composeOpenMode', 'app');
        await setSetting('composeContextVisible', false);
        await clickSel('.mail-sidebar .sidebar-compose button');
        await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 10000 }, SEL.editor);
        await browser.pause(600);
        const prep = new Take('templates-prep');
        await prep.type('[data-testid="compose-subject"]', 'Box sleeves quote', 'prep', { base: 30, jitter: 5 });
        await clickSel(SEL.editor);
        await browser.pause(500);
      },
      allow: (o) => o.testid === 'compose-modal' || (o.box[2] >= 400 && o.box[3] >= 300),
    });
  });

  // 30. Tags: the reader's tag button; the tag lands on the message and its row.
  it('tags', async function () {
    const TAG = process.env.FOOTAGE_TAGS_NAME || 'Receipts';
    const BTN = '.email-action-bar [data-quick-action="tag"]';
    await shoot(this, 'tags', async (take, scan) => {
      const head = await boxOf('[data-testid="sender-header"]');
      const bar = await boxOf('.email-action-bar');
      const row = await boxOf('[data-footage-target="tg-row"]');
      const W = 600, H = W / ASPECT;
      const crop = { x: Math.round(head.x - 4), y: Math.round(head.y - 92), w: W, h: Math.round(H) };
      await scan.at(take, 'before', crop);
      await take.hold(1400);
      await take.click(BTN, 'tag', { dur: 650 });
      const tTag = take.events.at(-1).t;
      await take.waitFor((n) => [...document.querySelectorAll('.local-mail-label')].some((e) => e.offsetHeight > 0 && (e.innerText || '').includes(n)), 'chip', 5000, TAG);
      await take.hold(300);
      facts.tagsChips = await browser.execute(() => [...document.querySelectorAll('.local-mail-label')].filter((e) => e.offsetHeight > 0).map((e) => e.innerText.trim()));
      await scan.at(take, 'tagged', crop);
      await take.hold(2700);
      const end = take.t(Date.now());
      return { crop, segments: [{ t0: Math.max(0.2, tTag - 1.6), t1: end }], boxes: { head, bar, row } };
    }, {
      prepare: async () => {
        // STAGED (disclose): a "Receipts" tag button added to the reader through
        // Settings > Appearance > Quick actions (Apply local label, the name, Add
        // action), then moved to the front of the reader's list through the store.
        await settingsSetupTab(L('settings.appearance.appearance'), L('quickActions.title'));
        await waitPage(() => !!document.querySelector('.quick-actions-settings')?.offsetHeight, { timeout: 8000 });
        await markExact('.quick-actions-settings', '[role="tab"]', L('quickActions.surface.reader'), 'qa-surface');
        await clickSel('[data-footage-target="qa-surface"]');
        await browser.pause(600);
        const sel = await browser.execute((lab) => {
          const el = [...document.querySelectorAll(`.quick-actions-add-row select[aria-label="${lab}"]`)].find((e) => e.offsetHeight > 0);
          if (!el) return 'no select';
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'tag');
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return el.value;
        }, L('quickActions.action'));
        if (sel !== 'tag') throw new Error(`tag action not selectable: ${sel}`);
        await waitPage(() => !!document.querySelector('.quick-actions-parameter input')?.offsetHeight, { timeout: 4000 });
        const prep = new Take('tags-prep');
        await prep.type('.quick-actions-parameter input', TAG, 'prep', { base: 30, jitter: 5 });
        await clickSel(`.quick-actions-add-row button[aria-label="${L('quickActions.addAction')}"]`);
        await browser.pause(1200);
        const moved = await browser.execute(() => {
          const st = window.__SETTINGS_STORE__.getState();
          const cfg = st.quickActions?.defaults?.reader;
          const e = cfg?.entries?.find((x) => x.action === 'tag');
          if (!e) return false;
          st.setQuickActionSurface('reader', null, { ...cfg, entries: [e, ...cfg.entries.filter((x) => x !== e)] });
          return true;
        });
        if (!moved) throw new Error('no tag entry in the reader list after Add action');
        await closeSettings();
        await resetView();
        if (!(await tagRow(MARK.invoice, 'tg-row'))) throw new Error(`invoice row not on screen: ${MARK.invoice}`);
        await clickSel('[data-footage-target="tg-row"]');
        if (!(await waitPage((s) => !!document.querySelector(s)?.offsetHeight, { timeout: 10000 }, BTN))) throw new Error('no tag button in the reader');
        // Opening marks it read a beat later (the toolbar's Mark read turns to Mark unread): settle first.
        await browser.pause(3000);
        await browser.execute(() => document.activeElement?.blur?.());
      },
    });
  });

  // 31. Radial menu: right-click a row, the wheel, Star; the row is starred.
  it('radial-menu', async function () {
    const WEDGE = '.quick-actions-radial button.quick-action-radial-item[data-quick-action="star"]';
    const STAR = '[data-footage-target="rm-row"] [data-testid="star-toggle"]';
    await shoot(this, 'radial-menu', async (take, scan) => {
      const row = await boxOf('[data-footage-target="rm-row"]');
      await take.hold(800);
      await take.rightClick('[data-footage-target="rm-row"]', 'wheel', { dur: 550 });
      const tWheel = take.events.at(-1).t;
      await take.waitFor((w) => !!document.querySelector(w)?.offsetHeight, 'wheel', 4000, WEDGE);
      await take.hold(300);
      const wheel = await boxOf('.quick-actions-radial');
      const crop = await listCrop();
      await scan.at(take, 'wheel', crop);
      await take.hold(700);
      await take.click(WEDGE, 'star', { dur: 450 });
      await take.waitFor((s) => document.querySelector(s)?.getAttribute('aria-pressed') === 'true', 'starred', 4000, STAR);
      await take.hold(300);
      await scan.at(take, 'starred', crop);
      await take.hold(1900);
      const end = take.t(Date.now());
      return { crop, segments: [{ t0: Math.max(0.2, tWheel - 1.0), t1: end }], boxes: { row, wheel } };
    }, {
      prepare: async () => {
        await widenList();
        const ok = await browser.execute(() => {
          const rows = [...document.querySelectorAll('[data-testid="email-row"]')].filter((r) => r.offsetHeight > 0);
          const row = rows.slice(2).find((r) => r.querySelector('[data-testid="star-toggle"]')?.getAttribute('aria-pressed') === 'false');
          if (!row) return false;
          row.setAttribute('data-footage-target', 'rm-row');
          return true;
        });
        if (!ok) throw new Error('no unstarred row');
      },
    });
    await restoreList();
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    if ((await browser.execute((s) => document.querySelector(s)?.getAttribute('aria-pressed'), STAR)) === 'true') await browser.execute((s) => document.querySelector(s)?.click(), STAR);
    await browser.pause(500);
  });

  // 32. Snooze: right-click, Snooze, Tomorrow; the row leaves the Inbox.
  it('snooze', async function () {
    const WEDGE = '.quick-actions-radial button.quick-action-radial-item[data-quick-action="snooze"]';
    await shoot(this, 'snooze', async (take, scan) => {
      const rows = await rowsBox(7);
      const crop = await listCrop();
      const subject = await browser.execute(() => (document.querySelector('[data-footage-target="sn-row"]')?.innerText || '').replace(/\s+/g, ' ').slice(0, 120));
      facts.snoozeRow = subject;
      await take.hold(800);
      await take.rightClick('[data-footage-target="sn-row"]', 'wheel', { dur: 550 });
      const tWheel = take.events.at(-1).t;
      await take.waitFor((w) => !!document.querySelector(w)?.offsetHeight, 'wheel', 4000, WEDGE);
      await take.hold(500);
      await take.click(WEDGE, 'snooze', { dur: 450 });
      await take.waitFor(() => !!document.querySelector('[data-testid="snooze-picker"]')?.offsetHeight, 'picker', 4000);
      await take.hold(500);
      const preset = await browser.execute(() => {
        const b = document.querySelector('[data-testid="snooze-preset-tomorrow"]') || document.querySelector('[data-testid^="snooze-preset-"]:not([data-testid="snooze-preset-custom"])');
        return b?.dataset.testid || null;
      });
      if (!preset) throw new Error('no snooze preset');
      facts.snoozePreset = preset;
      await take.click(`[data-testid="${preset}"]`, 'tomorrow', { dur: 450 });
      await take.waitFor(() => !document.querySelector('[data-footage-target="sn-row"]'), 'row gone', 8000);
      await take.hold(300);
      await scan.at(take, 'gone', crop);
      await take.hold(1800);
      const end = take.t(Date.now());
      return { crop, segments: [{ t0: Math.max(0.2, tWheel - 1.0), t1: end }], boxes: { rows } };
    }, {
      prepare: async () => {
        await widenList();
        if (!(await browser.execute(() => {
          const row = [...document.querySelectorAll('[data-testid="email-row"]')].filter((r) => r.offsetHeight > 0)[2];
          if (!row) return false;
          row.setAttribute('data-footage-target', 'sn-row');
          return true;
        }))) throw new Error('no third row');
      },
    });
    await restoreList();
  });

  // 33. Focus session: the timer, 25 minutes, Start; the window locks with the countdown.
  it('focus-session', async function () {
    await shoot(this, 'focus-session', async (take, scan) => {
      const btn = await boxOf('[data-testid="focus-button"]');
      const vp = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const cropAll = await fitCrop({ x: 0, y: 0, w: vp.w, h: vp.h }, { pad: 0 });
      await take.hold(800);
      await take.click('[data-testid="focus-button"]', 'focus', { dur: 550 });
      const tBtn = take.events.at(-1).t;
      await take.waitFor(() => !!document.querySelector('[data-testid="focus-start"]')?.offsetHeight, 'dialog', 4000);
      if (await browser.execute(() => !!document.querySelector('[data-testid="focus-upsell"]'))) throw new Error('focus session locked: no Premium');
      await take.hold(300);
      const dialog = await boxOf('[data-testid="focus-dialog"]');
      const cropDlg = await fitCrop(union(dialog, btn), { minW: 760, pad: 16 });
      await scan.at(take, 'dialog', cropDlg);
      if (await browser.execute(() => !!document.querySelector('[data-testid="focus-preset-25"]'))) {
        await take.click('[data-testid="focus-preset-25"]', 'preset-25', { dur: 450 });
        await take.hold(400);
      }
      await take.click('[data-testid="focus-start"]', 'start', { dur: 450 });
      const tStart = take.events.at(-1).t;
      await take.waitFor(() => !!document.querySelector('[data-testid="focus-lock"]')?.offsetHeight, 'lock', 5000);
      await take.hold(400);
      facts.focusLock = await browser.execute(() => (document.querySelector('[data-testid="focus-lock"]')?.innerText || '').replace(/\s+/g, ' ').slice(0, 200));
      await scan.at(take, 'lock', cropAll);
      await take.hold(2200);
      const end = take.t(Date.now());
      return {
        crop: cropDlg,
        segments: [
          { t0: Math.max(0.2, tBtn - 0.9), t1: tStart + 0.03, crop: cropDlg, label: 'dialog' },
          { t0: tStart + 0.04, t1: end, crop: cropAll, label: 'lock' },
        ],
        poster: 3.6,
        boxes: { btn, dialog },
      };
    }, { allow: (o) => o.box[2] >= 400 });
    // Unlock early (and confirm), so the boot ends clean.
    try {
      await browser.execute(() => document.querySelector('[data-testid="focus-unlock-early"]')?.click());
      await browser.pause(800);
      await browser.execute(() => document.querySelector('[data-testid="focus-unlock-confirm"]')?.click());
      await browser.pause(800);
    } catch (e) { facts.focusUnlockError = e.message; }
  });
});
