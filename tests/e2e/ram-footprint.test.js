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
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';

const SMALL = Number(process.env.RAM_SMALL_INBOX || 50);
const BIG = Number(process.env.RAM_BIG_INBOX || 10000);
const OUT = process.env.RAM_REPORT || '/tmp/ram-footprint.json';

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
  const total = Math.round(procs.reduce((n, p) => n + p.mb, 0) * 10) / 10;
  const load = execFileSync('uptime', { encoding: 'utf8' }).trim().split('load averages:')[1]?.trim();
  const row = { label, at: new Date().toISOString(), load, total, procs, ...extra };
  samples.push(row);
  console.log(`\n[ram] ${label} — total ${total} MB (load ${load})`);
  for (const p of procs) console.log(`[ram]   ${String(p.mb).padStart(7)} MB  peak ${String(p.peakMB).padStart(7)} MB  ${p.who} [${p.pid}]`);
  return row;
}

/** The store's own count — the list header lies while a drain is still running. */
const listState = () => browser.execute(() => {
  const s = window.__MAIL_STORE__?.getState?.();
  return s ? {
    accountId: s.activeAccountId, mailbox: s.activeMailbox,
    loaded: s.emails?.length ?? null, total: s.totalEmails ?? null,
    hasMore: !!s.hasMoreEmails, cacheMB: Math.round((s.cacheCurrentSizeMB || 0) * 10) / 10,
  } : null;
});

/**
 * Wait until the header drain stops moving. Not "loaded === total": a mailbox
 * can finish short of the server's count (tombstones, an expunge mid-drain),
 * and a measurement that times out waiting for an exact number reports nothing
 * at all. Stable-for-15s is the real "it stopped".
 */
async function waitForDrain(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = -1, lastMoveAt = Date.now();
  for (;;) {
    const s = await listState();
    if (s && s.loaded !== last) { last = s.loaded; lastMoveAt = Date.now(); console.log(`[ram]   drain ${s.loaded}/${s.total}`); }
    if (s && !s.hasMore && Date.now() - lastMoveAt > 15_000) return s;
    if (Date.now() - lastMoveAt > 60_000) { console.warn('[ram] drain stalled — measuring where it stopped'); return s; }
    if (Date.now() > deadline) { console.warn('[ram] drain did not finish in time — measuring where it is'); return s; }
    await browser.pause(3000);
  }
}

describe('memory footprint', () => {
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
    const smallState = await waitForDrain(5 * 60_000);
    sample(`small INBOX drained (${SMALL} fixture)`, { state: smallState });

    await switchToFolder('big@mock.test', 'INBOX');
    const bigState = await waitForDrain(30 * 60_000);
    sample(`big INBOX drained (${BIG} fixture)`, { state: bigState });

    // Scrolling is what runs the body prefetch and churns the virtualizer's
    // rows — the list at rest holds only a window of them. The scroller is the
    // element with the LARGEST scroll range, never the first one found: the
    // sidebar scrolls too and is first in document order.
    for (let step = 0; step < 25; step++) {
      const at = await browser.execute(() => {
        const list = [...document.querySelectorAll('div')]
          .filter((d) => d.clientHeight > 200 && d.scrollHeight - d.clientHeight > 200)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
        if (!list) return null;
        const max = list.scrollHeight - list.clientHeight;
        list.scrollTop = Math.min(list.scrollTop + list.clientHeight, max);
        return { top: Math.round(list.scrollTop), max: Math.round(max) };
      });
      if (!at) { console.warn('[ram] no scroller found'); break; }
      if (step % 5 === 0) console.log(`[ram]   scrolled ${at.top}/${at.max}`);
      if (at.top >= at.max) break;
      await browser.pause(700);
    }
    await browser.pause(20_000);
    sample('big INBOX after scrolling to the end', { state: await listState() });

    // The dwell is where a leak shows. Nothing is driven here on purpose.
    for (const minutes of [3, 3, 4]) {
      await browser.pause(minutes * 60_000);
      sample(`idle +${minutes} min`, { state: await listState() });
    }
  });
});
