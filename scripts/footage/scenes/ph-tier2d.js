/**
 * Product Hunt tour, Tier 2 batch D (docs/product-hunt-demo-script.md rows
 * 27 to 30), dark: one app boot, one `it` (one .mov) per clip.
 *
 *   c27-jump-to-month        the list timeline (toolbar "Timeline"): the rail on the list's LEFT edge,
 *                            hover it, press a 2024 month, the list pages in and lands there
 *   c28-undo-send            Settings > Mail preferences > Behavior: Send Delay 30 s; reply to Theo,
 *                            Send, the "Sending in" toast, Undo, the reply is back in compose
 *   c29-focus-session        (Premium) sidebar footer "Focus session": 45 min, Start, the lock and its
 *                            countdown, a real arrival held ("1 notification waiting"), Unlock early
 *   c30-notification-rules   Settings > Mail preferences > Notifications: quiet hours, a priority
 *                            sender added, the decision log refreshed with a real arrival
 *
 * Arrivals are real: the spec APPENDs a message to the mock IMAP server over a
 * plain IMAP session (imapAppend), the daemon's IDLE watcher sees it, and the
 * app's change feed raises the notification, which the notification policy
 * decides and logs. Nothing is injected into the page. Staged config (set
 * through the settings store before c30's take): the priority sender
 * tenderloin.type and the muted Studio Accounts account.
 *
 * Order matters: c29's arrivals feed c30's log, and c30 adds mail to the work
 * INBOX, so it stays last. `FOOTAGE_ONLY=c27-jump-to-month` limits a run.
 *
 * Helpers are copied from ph-tier2a.js on purpose: importing a spec would
 * register its clips in this run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { Take, pointer, OUT_DIR } from '../lib/footage.js';
import {
  L, SEL, probe, quiet, bootToInbox, resetView, beforeTake,
  waitPage, since, setSetting,
} from '../lib/scene.js';

const ONLY = (process.env.FOOTAGE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (clip) => !ONLY.length || ONLY.includes(clip);
const EXPECT_TOTAL = Number(process.env.FOOTAGE_EXPECT_TOTAL || 0);
const facts = {};

// ── Take plumbing (from ph-tier2a.js) ───────────────────────────────────────

async function finish(take, clip) {
  const rec = await take.stop();
  if (rec.delivered < 10) throw new Error(`${clip}: only ${rec.delivered} pictures delivered in ${rec.seconds}s`);
  console.log(`[footage] ${clip}: ${rec.seconds.toFixed(2)} s, pointer ${pointer()}`);
  return rec;
}

/**
 * One clip: back to the plain inbox (timeline off unless the clip turns it
 * on), wait for a quiet frame, record `body`. `onError` runs before the abort
 * (a take that dies after Send must still undo it).
 */
async function shoot(ctx, clip, body, { prepare, onError } = {}) {
  if (!want(clip)) ctx.skip();
  await unlockFocus();
  await resetView();
  await setSetting('listTimelineVisible', false);
  if (prepare) await prepare();
  await beforeTake(clip);
  const take = new Take(clip);
  await take.start();
  try {
    await body(take);
    return await finish(take, clip);
  } catch (e) {
    facts[`${clip}Error`] = String(e?.message || e);
    if (onError) { try { await onError(); } catch (e2) { facts[`${clip}OnError`] = String(e2?.message || e2); } }
    await take.abort();
    throw e;
  }
}

/** Tag the first visible `selector` whose text contains `needle`, for a Take to click by selector. */
function tagFirst(selector, needle, tag) {
  return browser.execute((s, n, t) => {
    document.querySelectorAll(`[data-footage-target="${t}"]`).forEach((el) => el.removeAttribute('data-footage-target'));
    const hit = [...document.querySelectorAll(s)]
      .find((el) => el.getBoundingClientRect().height > 0 && (!n || (el.innerText || '').includes(n)));
    if (!hit) return false;
    hit.setAttribute('data-footage-target', t);
    return true;
  }, selector, needle, tag);
}

/** The search index chip gone for 8 s in a row, up to 3 min (from ph-tier2a.js). */
async function indexSettled() {
  const t0 = Date.now();
  let clearSince = Date.now();
  while (Date.now() - t0 < 180000) {
    const chip = await browser.execute(() => !!document.querySelector('[data-testid="search-index-chip"]'));
    if (chip) clearSince = Date.now();
    else if (Date.now() - clearSince > 8000) break;
    await browser.pause(1000);
  }
  console.log(`[setup] index settled after ${since(t0)} s`);
  return Number(since(t0));
}

const COMPOSE_BTN = '.mail-sidebar .sidebar-compose button';
const settingsOpen = () => !!document.querySelector('[data-testid="settings-page"]')?.offsetHeight;
const visible = (s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0);

/** Compose opens in the main window (not a separate one the recorder cannot see). */
async function composeInApp() {
  const mode = await browser.execute(() => window.__SETTINGS_STORE__?.getState?.().composeOpenMode);
  if (mode !== 'app') await setSetting('composeOpenMode', 'app');
  return mode;
}

/** Settings > `navLabel` (> `tabLabel`), by real clicks; the search field's focus ring blurred. */
async function toSettingsPage(take, navLabel, tabLabel, ready, what, ...args) {
  await take.click('[data-testid="open-settings"]', 'settings');
  await take.waitFor(settingsOpen, 'settings', 8000);
  await browser.execute(() => document.activeElement?.blur?.());
  await take.hold(600);
  await take.reveal('[data-testid="settings-page"] .settings-nav-item', 'nav-reveal', { text: navLabel, ms: 600 });
  await take.click('[data-testid="settings-page"] .settings-nav-item', 'nav', { text: navLabel });
  if (tabLabel) {
    await take.waitFor((t) => [...document.querySelectorAll('[data-testid="settings-page"] [role="tab"]')]
      .some((b) => (b.innerText || '').trim() === t), `${what} tab`, 8000, tabLabel);
    await take.hold(500);
    await take.click('[data-testid="settings-page"] [role="tab"]', 'tab', { text: tabLabel });
  }
  await take.waitFor(ready, what, 15000, ...args);
  await browser.execute(() => document.activeElement?.blur?.());
}

async function closeSettingsByClick(take) {
  const sel = await browser.execute((c) => {
    for (const s of [`[data-testid="settings-page"] button[aria-label="${c}"]`, `[data-testid="settings-page"] button[title="${c}"]`]) {
      if ([...document.querySelectorAll(s)].some((b) => b.offsetHeight > 0)) return s;
    }
    return null;
  }, L('common.close'));
  if (sel) await take.click(sel, 'settings-close');
  else {
    take.cut('settings-close', 'settings closed with Escape');
    await browser.execute(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  }
  await take.waitFor(() => !document.querySelector('[data-testid="settings-page"]')?.offsetHeight, 'settings to close', 6000);
}

/**
 * A native <select> set the way React hears it (value setter, then change).
 * The cursor travels there first, so the change reads as a pick on the
 * control; the native menu itself never draws (as ph-tier1 setControl).
 */
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

// ── Real arrivals through the mock IMAP server ──────────────────────────────

const RFC3501_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
const internalDate = (d) => `${p2(d.getUTCDate())}-${RFC3501_MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} `
  + `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
let appendSeq = 0;

/** A plain-text message from `from` to the account, dated now. */
function rawMessage(account, from, subject, body) {
  const now = new Date();
  const domain = (/@([^>\s]+)/.exec(from) || [])[1] || 'example.invalid';
  appendSeq += 1;
  return {
    date: now,
    raw: [
      `From: ${from}`,
      `To: ${account.name} <${account.email}>`,
      `Subject: ${subject}`,
      `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <ph2d-${now.getTime()}-${appendSeq}@${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
      '',
    ].join('\r\n'),
  };
}

/**
 * LOGIN + APPEND (unread, dated now) + LOGOUT on the account's mock IMAP
 * port: what any other mail client or a delivering server does. The app hears
 * it through its own IDLE watcher.
 */
function imapAppend(account, from, subject, body, { mailbox = 'INBOX', timeout = 15000 } = {}) {
  const { raw, date } = rawMessage(account, from, subject, body);
  const size = Buffer.byteLength(raw, 'utf8');
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: account.imapPort });
    let buf = '';
    let step = 0;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`APPEND "${subject}" timed out at step ${step}: ${buf.slice(-300)}`)); }, timeout);
    const fail = (msg) => { clearTimeout(timer); sock.destroy(); reject(new Error(`APPEND "${subject}": ${msg}`)); };
    const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    sock.on('error', (e) => fail(String(e?.message || e)));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (step === 0 && /^\* OK/m.test(buf)) {
        step = 1; buf = '';
        sock.write(`a1 LOGIN ${q(account.email)} ${q(account.password)}\r\n`);
      } else if (step === 1 && /^a1 /m.test(buf)) {
        if (!/^a1 OK/m.test(buf)) { fail(`LOGIN refused: ${buf.trim()}`); return; }
        step = 2; buf = '';
        sock.write(`a2 APPEND ${q(mailbox)} ${q(internalDate(date))} {${size}}\r\n`);
      } else if (step === 2 && /^\+/m.test(buf)) {
        step = 3; buf = '';
        sock.write(raw);
        sock.write('\r\n');
      } else if ((step === 2 || step === 3) && /^a2 /m.test(buf)) {
        if (!/^a2 OK/m.test(buf)) { fail(`refused: ${buf.trim()}`); return; }
        const ok = (/^a2 OK.*$/m.exec(buf) || [''])[0].trim();
        step = 4;
        sock.write('a3 LOGOUT\r\n');
        clearTimeout(timer);
        setTimeout(() => sock.destroy(), 300);
        resolve({ at: Date.now(), ok, size });
      }
    });
  });
}

const accountAt = (i) => {
  const a = (browser.demoAccounts || [])[i];
  if (!a?.imapPort) throw new Error(`demo account ${i} has no imapPort: ${JSON.stringify(a)}`);
  return a;
};

/** The message is in the open list's store (the work INBOX is the open list). */
const inStore = (subj) => (window.__MAIL_STORE__?.getState?.().sortedEmails || []).some((e) => (e.subject || '').includes(subj));

/** APPEND to the work INBOX and wait until the app has it; the latency goes to facts. */
async function deliverToWork(key, from, subject, body, { timeout = 30000 } = {}) {
  const t0 = Date.now();
  const r = await imapAppend(accountAt(0), from, subject, body);
  const landed = await waitPage(inStore, { timeout, interval: 200 }, subject);
  facts[`arrival_${key}`] = { subject, appendMs: r.at - t0, landedMs: landed ? Date.now() - r.at : null, ok: r.ok };
  console.log(`[setup] arrival ${key}: ${JSON.stringify(facts[`arrival_${key}`])}`);
  return landed;
}

/** A running focus session ended through its own controls (setup only): it is persisted and covers the window. */
async function unlockFocus() {
  const locked = await browser.execute(() => !!document.querySelector('[data-testid="focus-lock"]'));
  if (!locked) return false;
  for (const s of ['[data-testid="focus-unlock-early"]', '[data-testid="focus-unlock-confirm"]']) {
    await browser.execute((sel) => document.querySelector(sel)?.click(), s);
    await browser.pause(500);
  }
  await browser.execute((d) => {
    const b = [...document.querySelectorAll('[data-testid="focus-early"] button')].find((x) => (x.innerText || '').includes(d));
    b?.click();
  }, L('focus.earlyDismiss'));
  await browser.pause(600);
  const still = await browser.execute(() => !!document.querySelector('[data-testid="focus-lock"]'));
  console.log(`[setup] focus lock ended by its controls; still locked: ${still}`);
  return true;
}

// ── The timeline rail ───────────────────────────────────────────────────────

const RAIL = '[data-testid="date-scrubber-rail"]';

/** Fractions down the rail of its year labels, e.g. { 2026: 0, 2025: 0.12, ... }. */
const railYears = (s) => {
  const rail = document.querySelector(s);
  if (!rail) return null;
  const out = {};
  for (const el of rail.querySelectorAll(':scope > div')) {
    const span = el.querySelector('span');
    const txt = (span?.textContent || '').trim();
    if (!/^\d{4}$/.test(txt)) continue;
    out[txt] = parseFloat(el.style.top) / 100;
  }
  return out;
};

/**
 * The pointer on the rail, in page events the rail's own handlers read
 * (no buttons: hover and its month label; `drag`: press, travel, release).
 * x sits on the rail's line. `edge` first wakes the rail from the list's
 * left gutter, as a real pointer arriving there does.
 */
function pageRail(sel, fromF, toF, ms, mode, done) {
  const rail = document.querySelector(sel);
  if (!rail) { done({ error: `no ${sel}` }); return; }
  const r = rail.getBoundingClientRect();
  const x = r.left + 35;
  const yAt = (f) => r.top + Math.max(0.003, Math.min(0.997, f)) * r.height;
  const ev = (y, buttons) => ({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y,
    button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window });
  // A synthetic pointer is not one WebKit tracks, so a capture request for it
  // may throw; the handler must still run to its end, as for a real press.
  let captureError = null;
  if (!rail.__footageCapture) {
    const orig = rail.setPointerCapture?.bind(rail);
    rail.setPointerCapture = (id) => { try { orig?.(id); } catch (e) { captureError = String(e?.message || e); } };
    rail.__footageCapture = true;
  }
  const y0 = yAt(fromF), y1 = yAt(toF);
  if (mode === 'edge') {
    const list = document.querySelector('.mail-list-with-timeline');
    list?.dispatchEvent(new PointerEvent('pointermove', ev(y0, 0)));
  }
  const at = Date.now();
  const drag = mode === 'drag';
  if (drag) rail.dispatchEvent(new PointerEvent('pointerdown', ev(y0, 1)));
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
  const start = performance.now();
  const step = () => {
    const p = ms > 0 ? Math.min(1, (performance.now() - start) / ms) : 1;
    const y = y0 + (y1 - y0) * ease(p);
    rail.dispatchEvent(new PointerEvent('pointermove', ev(y, drag ? 1 : 0)));
    if (p < 1) { requestAnimationFrame(step); return; }
    setTimeout(() => {
      if (drag) rail.dispatchEvent(new PointerEvent('pointerup', ev(y1, 0)));
      requestAnimationFrame(() => done({ at, end: Date.now(), from: { x, y: y0 }, to: { x, y: y1 },
        box: { x: r.x, y: r.y, w: r.width, h: r.height }, captureError,
        label: (rail.querySelector('.left-full')?.innerText || '').trim(), valuetext: rail.getAttribute('aria-valuetext') }));
    }, drag ? 160 : 0);
  };
  requestAnimationFrame(step);
}

async function railMove(take, fromF, toF, ms, mode, label) {
  const r = await browser.executeAsync(pageRail, RAIL, fromF, toF, ms, mode);
  if (r.error) throw new Error(`rail ${label}: ${r.error}`);
  take.log({ t: take.t(r.at), type: 'move', ...(mode === 'drag' ? { drag: true } : {}), x: r.to.x, y: r.to.y, from: r.from,
    bbox: r.box, label, dur: (r.end - r.at) / 1000 });
  if (mode === 'drag') take.log({ t: take.t(r.end), type: 'click', x: r.to.x, y: r.to.y, bbox: r.box, label: `${label}-release` });
  take.cursor = { x: r.to.x, y: r.to.y };
  return r;
}

/**
 * The pointer leaves the rail and the list's edge for a row. React reads its
 * onPointerLeave from pointerout/pointerover pairs, not from pointerleave.
 */
const railLeave = (s) => {
  const rail = document.querySelector(s);
  const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => r.getBoundingClientRect().height > 0) || document.body;
  const b = row.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, view: window };
  rail?.dispatchEvent(new PointerEvent('pointerout', { ...base, relatedTarget: row }));
  rail?.dispatchEvent(new PointerEvent('pointerleave', { ...base, bubbles: false, relatedTarget: row }));
  row.dispatchEvent(new PointerEvent('pointerover', { ...base, relatedTarget: rail }));
  document.querySelector('.mail-list-with-timeline')?.dispatchEvent(new PointerEvent('pointermove', base));
  return !rail?.querySelector('.left-full');
};

const railState = (s) => {
  const rail = document.querySelector(s);
  const pinned = [...document.querySelectorAll('[data-testid="list-month-header"], [aria-hidden="true"]')]
    .map((e) => (e.innerText || '').trim()).filter((t) => /\b20\d\d\b/.test(t)).slice(0, 3);
  return { valuetext: rail?.getAttribute('aria-valuetext') || '', pill: (document.querySelector('[data-testid="date-scrubber-pill"]')?.innerText || '').trim(),
    pinned, rows: (window.__MAIL_STORE__?.getState?.().sortedEmails || []).length };
};

// ── The clips ───────────────────────────────────────────────────────────────

describe('footage: Product Hunt tier 2d', function () {
  this.timeout(1800000);

  before(async function () {
    mkdirSync(OUT_DIR, { recursive: true });
    const t0 = Date.now();
    facts.boot = await bootToInbox({ expectTotal: EXPECT_TOTAL });
    facts.bootSeconds = Number(since(t0));
    facts.accounts = (browser.demoAccounts || []).map((a) => ({ id: a.id, email: a.email, name: a.name, imapPort: a.imapPort }));
    // The account rows' data-usage hover card never gets its stats in the
    // harness and sat on "Loading..." under a resting pointer (ph-tier2a).
    await setSetting('transferHoverEnabled', false);
    await resetView();
    const left = await quiet({ timeout: 90000 });
    console.log(`[setup] done in ${since(t0)} s; overlays left: ${JSON.stringify(left)}; ${JSON.stringify(await probe())}`);
  });

  after(async function () {
    writeFileSync(join(OUT_DIR, 'ph-tier2d.facts.json'), JSON.stringify(facts, null, 2));
  });

  // 27. Jump-to-month timeline.
  it('c27-jump-to-month', async function () {
    const TOGGLE = '[data-testid="timeline-toggle"]';
    await shoot(this, 'c27-jump-to-month', async (take) => {
      await take.hold(1200);
      await take.click(TOGGLE, 'timeline-on');
      await take.waitFor((s) => !!document.querySelector(s), 'rail', 5000, RAIL);
      await take.hold(400);
      const years = await browser.execute(railYears, RAIL);
      facts.c27YearsLive = years;
      const f24 = years?.['2024'];
      const target = f24 != null ? (years['2023'] != null ? f24 + (years['2023'] - f24) * 0.45 : f24 + 0.03) : 0.9;
      facts.c27Target = target;
      // The pointer comes to the list's left edge, the rail wakes, and the
      // hover label runs down the months.
      await take.moveTo(RAIL, 'rail');
      await railMove(take, 0.04, 0.04, 0, 'edge', 'rail-edge');
      await take.hold(500);
      const hover = await railMove(take, 0.04, target, 1900, 'hover', 'rail-hover');
      facts.c27HoverLabel = hover.label;
      await take.hold(700);
      const press = await railMove(take, target - 0.015, target, 450, 'drag', 'rail-press');
      facts.c27Press = { label: press.label, valuetext: press.valuetext, captureError: press.captureError };
      // An unloaded month pages mail in on the release, then the list lands.
      await take.waitFor((s) => (document.querySelector(s)?.getAttribute('aria-valuetext') || '').includes('2024'),
        'landed in 2024', 30000, RAIL);
      facts.c27Landed = await browser.execute(railState, RAIL);
      take.note('landed', { at: Number(take.t(Date.now()).toFixed(3)), ...facts.c27Landed });
      await take.hold(700);
      await take.moveTo(SEL.row, 'off-rail', { dur: 500 });
      facts.c27LabelGone = await browser.execute(railLeave, RAIL);
      await take.hold(1300);
      facts.c27LabelGoneLater = await browser.execute((r) => !document.querySelector(r)?.querySelector('.left-full'), RAIL);
      await take.scrollEase(SEL.row, 520, 'list-down', { ms: 2200 });
      await take.hold(1500);
      facts.c27End = await browser.execute(railState, RAIL);
      console.log(`[footage] c27 ${JSON.stringify({ years, target, hover: hover.label, landed: facts.c27Landed, end: facts.c27End })}`);
    }, {
      prepare: async () => {
        facts.c27ToggleVisible = await browser.execute((s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0), TOGGLE);
        if (!facts.c27ToggleVisible) throw new Error('no visible timeline toggle in the list toolbar');
        // Probe the rail once (the histogram path: 2024 must be on it), then off again so the toggle is clicked live.
        await setSetting('listTimelineVisible', true);
        await waitPage((s) => !!document.querySelector(s), { timeout: 5000 }, RAIL);
        await browser.pause(2500);
        facts.c27YearsProbe = await browser.execute(railYears, RAIL);
        facts.c27SegmentsMax = await browser.execute((s) => document.querySelector(s)?.getAttribute('aria-valuemax'), RAIL);
        console.log(`[setup] c27 rail years ${JSON.stringify(facts.c27YearsProbe)}, segments ${facts.c27SegmentsMax}`);
        await setSetting('listTimelineVisible', false);
        await browser.pause(800);
      },
    });
  });

  // 28. Undo Send.
  it('c28-undo-send', async function () {
    const SECTION = '[data-testid="settings-undo-send"]';
    const DELAY = `${SECTION} select`;
    const BODY = 'Perfect, the PDFs will be with you by Thursday noon.';
    const TOAST = '[data-testid="undo-send-toast"]';
    await shoot(this, 'c28-undo-send', async (take) => {
      await take.hold(1000);
      await toSettingsPage(take, L('settings.navigation.mailPreferences'), L('generalSettings.behavior'),
        (s) => !!document.querySelector(s)?.offsetHeight, 'behavior page', SECTION);
      await take.reveal(SECTION, 'sending', { ms: 900 });
      await take.hold(700);
      facts.c28Delay = await setSelect(take, DELAY, '30', 'send-delay');
      await take.hold(1300);
      await closeSettingsByClick(take);
      await take.hold(600);
      await take.click('[data-footage-target="theo"]', 'row-theo');
      await take.waitFor((e) => !document.body.innerText.includes(e), 'message open', 10000, L('viewer.selectEmailRead'));
      await take.hold(900);
      await take.click('[data-quick-action="reply"]', 'reply');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'compose', 10000, SEL.editor);
      await take.hold(600);
      await take.moveTo(SEL.editor, 'body');
      await take.typeRich(SEL.editor, BODY, 'reply-body', { base: 55, jitter: 20, seed: 8, caret: 'start' });
      await take.hold(700);
      await take.click(SEL.send, 'send');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'undo toast', 10000, TOAST);
      facts.c28ToastFirst = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' '), TOAST);
      await take.hold(2900);
      facts.c28ToastLater = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' '), TOAST);
      await take.click(SEL.undoSend, 'undo');
      await take.waitFor((s, e, b) => !document.querySelector(s) && (document.querySelector(e)?.innerText || '').includes(b),
        'reply back in compose', 10000, TOAST, SEL.editor, BODY.slice(0, 20));
      await take.hold(2000);
      facts.c28After = await browser.execute((e) => ({ editor: (document.querySelector(e)?.innerText || '').slice(0, 160),
        subject: document.querySelector('[data-testid="compose-subject"]')?.value || null }), SEL.editor);
      console.log(`[footage] c28 ${JSON.stringify({ delay: facts.c28Delay, first: facts.c28ToastFirst, later: facts.c28ToastLater, after: facts.c28After })}`);
    }, {
      prepare: async () => {
        facts.c28ComposeMode = await composeInApp();
        await setSetting('sendDelay', 15);
        const ok = await tagFirst(SEL.row, 'Press slot Friday', 'theo') || await tagFirst(SEL.row, '', 'theo');
        if (!ok) throw new Error('no row to reply to');
        facts.c28Row = await browser.execute(() => (document.querySelector('[data-footage-target="theo"]')?.innerText || '').replace(/\s+/g, ' ').slice(0, 90));
      },
      // Never let a failed take deliver: the hold window is still open.
      onError: async () => {
        const undone = await browser.execute((s) => { const b = document.querySelector(s); if (b) b.click(); return !!b; }, SEL.undoSend);
        facts.c28UndoneOnError = undone;
      },
    });
  });

  // 29. Focus session (Premium).
  it('c29-focus-session', async function () {
    const LOCK = '[data-testid="focus-lock"]';
    await shoot(this, 'c29-focus-session', async (take) => {
      await take.hold(1100);
      await take.click('[data-testid="focus-button"]', 'focus-session');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'focus dialog', 6000, '[data-testid="focus-dialog"]');
      if (await browser.execute(() => !!document.querySelector('[data-testid="focus-upsell"]'))) throw new Error('focus dialog shows the upsell: the Premium seed did not take');
      await take.hold(1300);
      await take.click('[data-testid="focus-preset-45"]', 'preset-45');
      await take.hold(900);
      await take.click('[data-testid="focus-start"]', 'start');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'focus lock', 6000, LOCK);
      facts.c29LockStart = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' '), LOCK);
      // A real arrival while the lock is up: the policy holds it.
      const arrival = imapAppend(accountAt(0), 'Dario Vella <dario@rackandrind.com>', 'Rack & Rind: final cut approved',
        'Final cut is approved. Delivery files land Monday.');
      await take.hold(1500);
      const t0 = Date.now();
      const held = await waitPage(() => !!document.querySelector('[data-testid="focus-held"]'), { timeout: 15000, interval: 150 });
      facts.c29Held = { shown: held, waitedMs: Date.now() - t0, append: await arrival.then((r) => r.ok, (e) => String(e?.message || e)) };
      take.note('held', { at: Number(take.t(Date.now()).toFixed(3)), ...facts.c29Held });
      facts.c29LockHeld = await browser.execute((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' '), LOCK);
      await take.hold(2200);
      await take.click('[data-testid="focus-unlock-early"]', 'unlock-early');
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'confirm', 4000, '[data-testid="focus-unlock-confirm"]');
      await take.hold(1400);
      await take.click('[data-testid="focus-unlock-confirm"]', 'unlock-anyway');
      await take.waitFor((s) => !document.querySelector(s), 'lock gone', 5000, LOCK);
      await take.waitFor((s) => !!document.querySelector(s)?.offsetHeight, 'early dialog', 4000, '[data-testid="focus-early"]');
      await take.hold(1700);
      await take.click('[data-testid="focus-early"] button', 'early-dismiss', { text: L('focus.earlyDismiss') });
      await take.waitFor((s) => !document.querySelector(s)?.offsetHeight, 'early dialog closed', 4000, '[data-testid="focus-early"]');
      await take.hold(1300);
      console.log(`[footage] c29 ${JSON.stringify({ start: facts.c29LockStart, held: facts.c29Held, lockHeld: facts.c29LockHeld })}`);
      if (!held) throw new Error(`no "notification waiting" line within 15 s: ${JSON.stringify(facts.c29Held)}`);
    }, {
      prepare: async () => {
        // Proves the arrival path once, off camera, and gives c30's log a plain "Delivered" row.
        const ok = await deliverToWork('probe', 'Nell Okafor <nell@smokehouse.design>', 'Smokehouse moodboard, round two',
          'Round two of the moodboard is up. Warmer greys this time.');
        if (!ok) throw new Error(`the probe arrival never reached the list: ${JSON.stringify(facts.arrival_probe)}`);
        await browser.pause(1500);
        facts.c29IndexSettled = await indexSettled();
        await resetView();
      },
      onError: unlockFocus,
    });
  });

  // 30. Notification rules: quiet hours, priority senders, mutes, the decision log.
  it('c30-notification-rules', async function () {
    const NOTIF = '[data-testid="settings-notifications"]';
    const ALLOW = '[data-testid="settings-notification-allowlist"]';
    const LOG = '[data-testid="settings-notification-decision-log"]';
    const QUIET = `${NOTIF} button[role="switch"][aria-label="${L('notifyPolicy.quietHours.title')}"]`;
    const SENDER_INPUT = `${ALLOW} input[aria-label="${L('notifyPolicy.allowlist.placeholder')}"]`;
    const VIP = 'ana@sizzlemedia.co';
    const VIP_SUBJECT = 'Sizzle reel: two cuts to pick from';
    const logRows = (s) => [...document.querySelectorAll(`${s} .border-b`)].map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim());
    await shoot(this, 'c30-notification-rules', async (take) => {
      await take.hold(1000);
      await toSettingsPage(take, L('settings.navigation.mailPreferences'), L('settings.notifications.notifications'),
        (s) => !!document.querySelector(s)?.offsetHeight, 'notifications page', NOTIF);
      await take.hold(900);
      // The work account's row: its folders and quiet hours.
      if (!(await tagFirst(`${NOTIF} button.text-left`, '', 'acct-work'))) throw new Error('no account row');
      await take.click('[data-footage-target="acct-work"]', 'account-work');
      await take.waitFor(visible, 'quiet hours switch', 4000, QUIET);
      await take.reveal(QUIET, 'quiet', { ms: 800 });
      await take.hold(600);
      await take.click(QUIET, 'quiet-hours-on');
      await take.waitFor(() => [...document.querySelectorAll('input[type="time"]')].some((e) => e.offsetHeight > 0), 'quiet window', 4000);
      facts.c30Quiet = await browser.execute(() => [...document.querySelectorAll('input[type="time"]')].map((e) => e.value));
      await take.hold(1300);
      // A priority sender, typed and added.
      await take.reveal(ALLOW, 'priority', { ms: 900 });
      await take.hold(500);
      await take.click(SENDER_INPUT, 'sender-field');
      await take.type(SENDER_INPUT, VIP, 'sender', { base: 70, jitter: 20, seed: 12 });
      await take.hold(300);
      await take.click(`${ALLOW} button[type="submit"]`, 'add');
      await take.waitFor((s, v) => (document.querySelector(s)?.innerText || '').includes(v) && !document.querySelector(`${s} input[aria-label]`)?.value,
        'sender added', 4000, ALLOW, VIP);
      await browser.execute(() => document.activeElement?.blur?.());
      // She writes in; the log says why it notified.
      const arrival = imapAppend(accountAt(0), `Ana Brandt <${VIP}>`, VIP_SUBJECT, 'Two cuts of the sizzle reel are up. Pick one by Friday?');
      await take.hold(700);
      await take.reveal(LOG, 'log', { ms: 1000 });
      facts.c30RowsBefore = await browser.execute(logRows, LOG);
      await take.hold(1500);
      facts.c30Append = await arrival.then((r) => r.ok, (e) => String(e?.message || e));
      facts.c30Landed = await waitPage(inStore, { timeout: 15000, interval: 200 }, VIP_SUBJECT);
      await browser.pause(700);
      await take.click(`${LOG} button`, 'refresh', { text: L('notifyPolicy.log.refresh') });
      await take.waitFor((s) => [...document.querySelectorAll(`${s} .border-b`)][0]?.innerText?.includes('Ana Brandt'), 'Ana on top', 5000, LOG)
        .catch(() => { facts.c30AnaMissing = true; });
      await take.hold(3000);
      facts.c30RowsAfter = await browser.execute(logRows, LOG);
      console.log(`[footage] c30 ${JSON.stringify({ quiet: facts.c30Quiet, before: facts.c30RowsBefore, after: facts.c30RowsAfter, landed: facts.c30Landed })}`);
    }, {
      prepare: async () => {
        // Staged config, then real arrivals decided under it, one at a time
        // (one change-feed reply per arrival, so one log row each).
        const ids = (browser.demoAccounts || []).map((a) => a.id);
        await browser.execute((billing) => {
          const s = window.__SETTINGS_STORE__.getState();
          if (!s.notificationSettings?.enabled) s.setNotificationEnabled?.(true);
          if (!(s.notificationSettings?.importantSenders || []).some((e) => e.match === 'tenderloin.type')) s.addImportantSender('tenderloin.type', true);
          s.setAccountNotificationEnabled(billing, false);
        }, ids[2]);
        const ok = await deliverToWork('priya', 'Priya Raines <priya@tenderloin.type>', 'Signed licence attached',
          'Signed and attached. Five seats from Monday.');
        if (!ok) console.warn('[setup] c30: the priority arrival never reached the list');
        await browser.pause(1500);
        const t0 = Date.now();
        facts.arrival_muted = await imapAppend(accountAt(2), "Butcher's Ledger <statements@butchersledger.co>", 'October statement is ready',
          'Your October statement is ready.').then((r) => ({ ok: r.ok, appendMs: r.at - t0 }), (e) => ({ error: String(e?.message || e) }));
        await browser.pause(6000);
        facts.c30NotificationSettings = await browser.execute(() => window.__SETTINGS_STORE__.getState().notificationSettings);
        facts.c30IndexSettled = await indexSettled();
        await resetView();
      },
    });
  });
});
