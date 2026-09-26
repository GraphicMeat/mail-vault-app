// What the app actually costs in memory, measured instead of asserted.
//
// Reports `Physical footprint` and its peak — the number Activity Monitor's
// "Memory" column shows — for every process the app owns. WKWebView is always
// out of process, so the JS heap, the DOM and decoded images live in
// `com.apple.WebKit.WebContent`, a SIBLING of the app whose parent is launchd:
// reading the `mailvault` pid alone measures the shell and misses everything
// this is about. Attribution is by "appeared with the app", which is only sound
// because the mini runs one app instance at a time.
//
// Two accounts, one small INBOX and one large, so the per-header cost is a
// subtraction rather than a guess. Asserts nothing: it prints a table.
//
// On Windows the same run reads the private working set instead (winMemory.js),
// and with RAM_SHOTS_DIR set it photographs the window at each checkpoint.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { windowsSample, captureWindow } from './winMemory.js';

const SMALL = Number(process.env.RAM_SMALL_INBOX || 50);
const BIG = Number(process.env.RAM_BIG_INBOX || 10000);
const OUT = process.env.RAM_REPORT || join(tmpdir(), 'ram-footprint.json');
const SHOTS = process.env.RAM_SHOTS_DIR;
const IS_WIN = process.platform === 'win32';

const WEBKIT = ['com.apple.WebKit.WebContent', 'com.apple.WebKit.Networking', 'com.apple.WebKit.GPU'];

function pgrep(pattern, exact) {
  try {
    return execFileSync('pgrep', exact ? ['-x', pattern] : ['-f', pattern], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map(Number);
  } catch { return []; } // pgrep exits non-zero when nothing matches
}

const MB = { K: 1 / 1024, M: 1, G: 1024 };
const toMB = (m) => (m ? Math.round(parseFloat(m[1]) * MB[m[2]] * 10) / 10 : null);

/** Current and peak physical footprint of one pid, or null if it died meanwhile. */
function footprint(pid) {
  try {
    const out = execFileSync('/usr/bin/vmmap', ['--summary', String(pid)],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return {
      mb: toMB(out.match(/Physical footprint:\s+([\d.]+)([KMG])/)),
      peakMB: toMB(out.match(/Physical footprint \(peak\):\s+([\d.]+)([KMG])/)),
    };
  } catch { return null; }
}

const procName = (pid) => {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim().split('/').pop();
  } catch { return '(gone)'; }
};

const samples = [];

/** One row per live process, plus the runner's load — a loaded mini is not a clean read. */
function sample(label, extra = {}) {
  if (IS_WIN) return record(label, windowsSample(process.cwd()), `free ${Math.round(freemem() / 1048576)} MB`, extra);
  const pids = [
    ...pgrep('mailvault', true).map((pid) => ({ pid, who: 'mailvault (app)' })),
    ...pgrep('mailvault-daemon', true).map((pid) => ({ pid, who: 'mailvault-daemon' })),
    ...WEBKIT.flatMap((n) => pgrep(n, false).map((pid) => ({ pid, who: procName(pid) }))),
  ];
  const seen = new Map();
  for (const p of pids) if (!seen.has(p.pid)) seen.set(p.pid, p);

  const procs = [];
  for (const { pid, who } of seen.values()) {
    const f = footprint(pid);
    if (f && f.mb !== null) procs.push({ pid, who, ...f });
  }
  const load = execFileSync('uptime', { encoding: 'utf8' }).trim().split('load averages:')[1]?.trim();
  return record(label, procs, load, extra);
}

function record(label, procs, load, extra) {
  const total = Math.round(procs.reduce((n, p) => n + (p.mb || 0), 0) * 10) / 10;
  const row = { label, at: new Date().toISOString(), load, total, procs, ...extra };
  samples.push(row);
  console.log(`\n[ram] ${label} — total ${total} MB (load ${load})`);
  for (const p of procs) console.log(`[ram]   ${String(p.mb).padStart(7)} MB  peak ${String(p.peakMB ?? p.peakWsMB).padStart(7)} MB  ${p.who} [${p.pid}]`);
  return row;
}

/** Windows only: the app window at this checkpoint, native frame and all. */
function shoot(name) {
  if (!IS_WIN || !SHOTS) return;
  const app = samples.at(-1)?.procs.find((p) => p.who === 'mailvault');
  if (!app) return;
  mkdirSync(SHOTS, { recursive: true });
  try { console.log(`[ram] shot ${name}: ${captureWindow(app.pid, join(SHOTS, `${name}.png`))}`); }
  catch (e) { console.warn(`[ram] shot ${name} failed: ${e.message}`); }
}

/** The store's own count — the list header lies while a drain is still running. */
const listState = () => browser.execute(() => {
  const s = window.__MAIL_STORE__?.getState?.();
  return s ? {
    accountId: s.activeAccountId, mailbox: s.activeMailbox,
    loaded: s.emails?.length ?? null, total: s.totalEmails ?? null,
    hasMore: !!s.hasMoreEmails, cacheMB: Math.round((s.cacheCurrentSizeMB || 0) * 10) / 10,
    pipelines: window.__PIPELINES__?.() ?? null,
  } : null;
});

/**
 * Scroll the message list to its end. The list is virtualized and the header
 * drain is driven by reaching the bottom, so a mailbox loads 500 at a time and
 * only while something asks for more — a spec that merely waits sees the drain
 * stop at the first page and reads it as "loaded".
 *
 * The scroller is the element with the LARGEST scroll range, never the first
 * one found: the sidebar scrolls too and is first in document order.
 */
const scrollListToEnd = () => browser.execute(() => {
  const list = [...document.querySelectorAll('div')]
    .filter((d) => d.clientHeight > 200 && d.scrollHeight - d.clientHeight > 200)
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  if (!list) return null;
  const max = list.scrollHeight - list.clientHeight;
  list.scrollTop = max;
  return { top: Math.round(list.scrollTop), max: Math.round(max) };
});

/**
 * Drive the drain to the end and return the state it settled at.
 *
 * Not "loaded === total" as the only exit: a mailbox can finish short of the
 * server's count (tombstones, an expunge mid-drain), and a measurement that
 * times out waiting for an exact number reports nothing at all.
 */
async function drainWholeMailbox(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = -1, lastMoveAt = Date.now();
  for (;;) {
    await scrollListToEnd();
    const s = await listState();
    if (s && s.loaded !== last) {
      if (s.loaded - last > 400 || last < 0) console.log(`[ram]   drain ${s.loaded}/${s.total}`);
      last = s.loaded; lastMoveAt = Date.now();
    }
    if (s && !s.hasMore && Date.now() - lastMoveAt > 10_000) return s;
    if (Date.now() - lastMoveAt > 120_000) { console.warn(`[ram] drain stuck at ${s?.loaded}/${s?.total} — measuring there`); return s; }
    if (Date.now() > deadline) { console.warn(`[ram] drain out of time at ${s?.loaded}/${s?.total}`); return s; }
    await browser.pause(1500);
  }
}

// pgrep + vmmap on macOS, the perf classes on Windows; nothing reads Linux.
(process.platform === 'darwin' || IS_WIN ? describe : describe.skip)('memory footprint', () => {
  before(async () => {
    await waitForApp();
    await waitForEmails();
  });

  after(() => {
    writeFileSync(OUT, JSON.stringify({ small: SMALL, big: BIG, samples }, null, 2));
    console.log(`\n[ram] wrote ${OUT}`);
  });

  it('measures the app across mailbox sizes and an idle dwell', async () => {
    sample('launch (first paint)', { state: await listState() });

    await switchToFolder('small@mock.test', 'INBOX');
    sample(`small INBOX drained (${SMALL} fixture)`, { state: await drainWholeMailbox(5 * 60_000) });
    shoot('small-inbox');

    // Immediately either side of the switch, so the peak delta belongs to the
    // large account's cold read and not to anything that came after it. The
    // app shell relays every daemon payload, and the cold read asks for the
    // whole mailbox in one response.
    sample('before switching to the big account', { state: await listState() });
    await switchToFolder('big@mock.test', 'INBOX');
    // The spike lives inside the first sync, so one sample either side of it
    // cannot say what allocated. Watch it at 5 s while it happens, with the
    // pipeline's held-row count alongside.
    for (let i = 0; i < 20; i++) {
      sample(`sync +${i * 5}s`, { state: await listState() });
      await browser.pause(5000);
    }

    const bigState = await drainWholeMailbox(25 * 60_000);
    sample(`big INBOX drained (${BIG} fixture)`, { state: bigState });
    shoot('big-inbox');

    // A second pass over a fully loaded list: this is what runs the body
    // prefetch and churns the virtualizer's rows.
    for (let step = 0; step < 40; step++) {
      // `step` has to be an argument: the function body is serialized into the
      // page, where nothing from this scope exists.
      const at = await browser.execute((n) => {
        const list = [...document.querySelectorAll('div')]
          .filter((d) => d.clientHeight > 200 && d.scrollHeight - d.clientHeight > 200)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
        if (!list) return null;
        const max = list.scrollHeight - list.clientHeight;
        list.scrollTop = n === 0 ? 0 : Math.min(list.scrollTop + list.clientHeight, max);
        return { top: Math.round(list.scrollTop), max: Math.round(max) };
      }, step);
      if (!at) { console.warn('[ram] no scroller found'); break; }
      await browser.pause(700);
    }
    await browser.pause(20_000);
    sample('big INBOX after a scroll pass', { state: await listState() });

    // The dwell is where a leak shows, and it only means something once the
    // drain is finished — otherwise loading eats the window.
    for (const minutes of [3, 3, 4]) {
      await browser.pause(minutes * 60_000);
      sample(`idle +${minutes} min`, { state: await listState() });
    }
    shoot('idle');
  });
});
