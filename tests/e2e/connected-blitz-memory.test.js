/**
 * E2E: what the app and its helpers hold in memory while the same mail is read
 * through the iframe (MV_MEM_MODE=web) and through Blitz (MV_MEM_MODE=blitz).
 *
 * One mode per run, each on a freshly launched app: a WebContent process does
 * not hand its heap back, so flipping the setting inside one run would credit
 * the second mode with the first one's growth. memory-job.sh runs web, blitz,
 * web, blitz and prints every `[blitzmem]` line.
 *
 * The workload is identical: the Blitz folder on luke (mockImap.js blitzMailbox),
 * list view, open the 3-message thread, open the tall mail, switch to chat, open
 * the 100-message conversation, scroll it end to end, then idle. After each
 * step the processes are sampled with `ps` (RSS, KB), three samples two seconds
 * apart, median per process:
 *   shell     the app's own process
 *   daemon    mailvault-daemon (sync, storage, indexing)
 *   worker    mailvault-daemon --render-worker (Blitz only)
 *   webcontent, gpu, networking   the WebKit helpers
 * The WebKit helpers are not children of the app, so they are attributed by
 * name: the mini runs one app instance at a time, and the process list of
 * every sample is logged so a stray WebKit process from elsewhere shows.
 *
 * RSS counts shared pages in every process it maps and is not the Activity
 * Monitor "Memory" column (physical footprint): read the web-against-blitz
 * difference, not the absolute figure.
 *
 * Out of connected-ci: wdio.blitz.conf.js selects it by name. Mac only.
 */
import { execFileSync } from 'node:child_process';
import { waitForApp, waitForEmails, switchToFolder } from './helpers.js';
import { BLITZ_FOLDER, BLITZ_THREAD_SUBJECT, BLITZ_CHAT_NAME, BLITZ_TALL_SUBJECT } from './mockImap.js';

// blitz-gpu: Blitz with Settings' graphics-card switch on (render workers spawn with --gpu).
const MODE = ['blitz', 'blitz-gpu'].includes(process.env.MV_MEM_MODE) ? process.env.MV_MEM_MODE : 'web';
const RENDERER = MODE === 'web' ? 'web' : 'blitz';
const log = (phase, v) => console.log(`[blitzmem] ${JSON.stringify({ mode: MODE, phase, ...v })}`);
const setStore = (patch) => browser.execute((p) => window.__SETTINGS_STORE__.setState(p), patch);

const CLASSES = [
  ['worker', (c) => /mailvault-daemon\b.*--render-worker/.test(c)],
  ['daemon', (c) => /mailvault-daemon\b/.test(c)],
  ['shell', (c) => /\/mailvault(\s|$)/.test(c)],
  ['webcontent', (c) => /com\.apple\.WebKit\.WebContent/.test(c)],
  ['gpu', (c) => /com\.apple\.WebKit\.GPU/.test(c)],
  ['networking', (c) => /com\.apple\.WebKit\.Networking/.test(c)],
];

/** `ps` etime ([[dd-]hh:]mm:ss) in seconds. */
function etimeSeconds(t) {
  const [d, rest] = t.includes('-') ? t.split('-') : ['0', t];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(d) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * The WebKit helpers are not children of the app, and a box that ran other WebKit apps holds their (older,
 * sometimes multi-GB) helpers too. A helper counts only if it started no earlier than the app's own shell
 * process, the youngest `mailvault` on the box. `stray` lists the ones left out, so the filter is visible.
 */
function sample() {
  const out = execFileSync('ps', ['-axo', 'pid=,etime=,rss=,command='], { encoding: 'utf8', maxBuffer: 16 << 20 });
  const all = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const hit = CLASSES.find(([, test]) => test(m[4]));
    if (hit) all.push({ pid: Number(m[1]), age: etimeSeconds(m[2]), cls: hit[0], kb: Number(m[3]) });
  }
  const shellAge = Math.min(...all.filter((p) => p.cls === 'shell').map((p) => p.age), Infinity);
  const by = {};
  const procs = [];
  const stray = [];
  for (const p of all) {
    const webkit = ['webcontent', 'gpu', 'networking'].includes(p.cls);
    if (webkit && Number.isFinite(shellAge) && p.age > shellAge + 2) { stray.push({ pid: p.pid, cls: p.cls, mb: Math.round(p.kb / 1024), ageS: p.age }); continue; }
    by[p.cls] = (by[p.cls] || 0) + p.kb;
    procs.push({ pid: p.pid, cls: p.cls, mb: Math.round(p.kb / 1024) });
  }
  return { by, procs, stray };
}

/** The "Physical footprint" vmmap reports for a pid (what Activity Monitor calls Memory), in MB, or null. */
function footprintMb(pid) {
  try {
    const out = execFileSync('vmmap', ['-summary', String(pid)], { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 60_000 });
    const m = out.match(/Physical footprint:\s+([\d.]+)([KMG])/);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024 }[m[2]]));
  } catch { return null; }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(phase) {
  const runs = [];
  for (let i = 0; i < 3; i++) { runs.push(sample()); await browser.pause(2000); }
  const mb = {};
  for (const [cls] of CLASSES) {
    const v = runs.map((r) => r.by[cls] || 0);
    if (v.some(Boolean)) mb[cls] = Math.round(median(v) / 1024);
  }
  mb.total = Object.values(mb).reduce((a, b) => a + b, 0);
  const page = await browser.execute(() => ({
    iframes: document.querySelectorAll('iframe').length,
    tiles: document.querySelectorAll('[data-testid="blitz-tile"]').length,
    blitzBodies: document.querySelectorAll('[data-renderer="blitz"]').length,
  }));
  const last = runs[runs.length - 1];
  const fp = {};
  for (const p of last.procs.filter((p) => ['webcontent', 'gpu'].includes(p.cls))) fp[p.cls] = (fp[p.cls] || 0) + (footprintMb(p.pid) ?? 0);
  log(phase, { mb, footprintMb: fp, page, procs: last.procs, stray: last.stray });
  return mb;
}

/**
 * What the WebContent process holds, by VM region (MV_MEM_PROFILE=1): `vmmap -summary` of the biggest
 * WebContent pid, plus what the page itself counts. vmmap needs the task port of another process, which
 * the OS may refuse; the refusal is logged and the page counts still are.
 */
async function profile(phase) {
  const procs = sample().procs.filter((p) => p.cls === 'webcontent').sort((a, b) => b.mb - a.mb);
  const pid = procs[0]?.pid;
  let regions = null;
  let error = null;
  if (pid) {
    for (const cmd of [['vmmap', ['-summary', String(pid)]], ['footprint', [String(pid)]]]) {
      try {
        const out = execFileSync(cmd[0], cmd[1], { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 60_000 });
        regions = { tool: cmd[0], text: out.split('\n').filter((l) => l.trim()).slice(0, 60).join('\n') };
        break;
      } catch (e) { error = `${cmd[0]}: ${String(e?.stderr || e?.message || e).slice(0, 300)}`; }
    }
  }
  const page = await browser.execute(() => ({
    domNodes: document.getElementsByTagName('*').length,
    images: document.images.length,
    styleSheets: document.styleSheets.length,
    fonts: document.fonts?.size ?? null,
    scripts: document.scripts.length,
    resources: performance.getEntriesByType('resource').length,
    transferKB: Math.round(performance.getEntriesByType('resource').reduce((a, r) => a + (r.encodedBodySize || 0), 0) / 1024),
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  }));
  log(`profile-${phase}`, { pid, regions, error, page });
}

async function clickRow(subject, thread = false) {
  await browser.waitUntil(() => browser.execute((subject, thread) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')].find((r) => r.offsetHeight > 0
      && (r.textContent || '').includes(subject) && (!thread || Number(r.getAttribute('data-thread-count') || 1) > 1));
    if (row) row.click();
    return !!row;
  }, subject, thread), { timeout: 30_000, interval: 300, timeoutMsg: `row ${subject} not found` });
}

async function openChat(name, subject) {
  await browser.waitUntil(() => browser.execute((name) => {
    const hit = [...document.querySelectorAll('[data-testid="sender-row"]')].find((el) => el.offsetHeight > 0 && (el.textContent || '').includes(name));
    if (hit) hit.click();
    return !!hit;
  }, name), { timeout: 30_000, interval: 300, timeoutMsg: `chat correspondent ${name} not found` });
  await browser.waitUntil(() => browser.execute((subject) => {
    const hit = [...document.querySelectorAll('[role="button"]')].find((el) => el.getAttribute('data-testid') !== 'sender-row'
      && el.offsetHeight > 0 && (el.textContent || '').includes(subject) && el.querySelector('h3'));
    if (hit) hit.click();
    return !!hit;
  }, subject), { timeout: 30_000, interval: 300, timeoutMsg: `chat topic ${subject} not found` });
}

/** Every body in `scope` has drawn: a loaded iframe document, or a decoded Blitz tile. */
const bodiesDrawn = (scope) => browser.execute((scope, mode) => {
  const host = document.querySelector(scope) || document;
  if (mode !== 'web') {
    const bodies = [...host.querySelectorAll('[data-renderer="blitz"]')];
    return bodies.length > 0 && bodies.some((b) => { const t = b.querySelector('[data-testid="blitz-tile"]'); return t && t.complete && t.naturalWidth > 0; });
  }
  const frames = [...host.querySelectorAll('iframe[sandbox]')];
  return frames.length > 0 && frames.some((f) => { try { return f.contentDocument?.readyState === 'complete' && (f.contentDocument.body?.textContent || '').length > 0; } catch { return false; } });
}, scope, MODE);

async function waitDrawn(scope) {
  await browser.waitUntil(() => bodiesDrawn(scope), { timeout: 30_000, interval: 300, timeoutMsg: `${MODE}: nothing drew in ${scope}` });
  await browser.pause(1500);
}

describe(`Memory while reading (${MODE})`, function () {
  this.timeout(900_000);
  const luke = () => browser.mockAccounts[0].email;

  before(async () => {
    await waitForApp();
    await waitForEmails();
    await browser.setTimeout({ script: 180_000 });
    await browser.setWindowSize(1280, 900);
    await browser.pause(2500);
    await browser.execute(() => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Dismiss')?.click());
    await setStore({ emailRenderer: RENDERER, blitzGpu: MODE === 'blitz-gpu', viewStyle: 'list' });
    await switchToFolder(luke(), BLITZ_FOLDER);
  });

  it('reads the same mail through the iframe or Blitz and samples memory after each step', async () => {
    const mb = {};
    mb.start = await measure('start');
    if (process.env.MV_MEM_PROFILE === '1') await profile('start');

    await clickRow(BLITZ_THREAD_SUBJECT, true);
    await waitDrawn('.thread-reader');
    mb.thread = await measure('thread');

    await clickRow(BLITZ_TALL_SUBJECT);
    await waitDrawn('body');
    mb.tall = await measure('tall');

    await setStore({ viewStyle: 'chat' });
    await openChat(BLITZ_CHAT_NAME, 'Blitz chat check');
    await waitDrawn('body');
    await browser.execute(async () => {
      const scroller = [...document.querySelectorAll('.overflow-y-auto')].find((el) => el.querySelector('[role="group"]'));
      scroller.scrollTop = 0;
      for (let y = 0; y <= scroller.scrollHeight; y += 400) { scroller.scrollTop = y; await new Promise((r) => setTimeout(r, 50)); }
      scroller.scrollTop = scroller.scrollHeight;
    });
    await browser.pause(3000);
    mb.chat = await measure('chat-scrolled');

    await browser.pause(15_000);
    mb.idle = await measure('chat-idle');
    if (process.env.MV_MEM_PROFILE === '1') await profile('idle');

    log('summary', { mb });
    // The workload must really have used the renderer under test, or the comparison is void.
    const page = await browser.execute(() => ({
      iframes: document.querySelectorAll('iframe[sandbox]').length,
      blitz: document.querySelectorAll('[data-renderer="blitz"]').length,
    }));
    if (MODE === 'blitz-gpu') {
      // The GPU run must really have drawn on the GPU: a worker spawned with --gpu, and the GPU not given up.
      const ps = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 16 << 20 });
      expect(ps).toMatch(/mailvault-daemon\b.*--render-worker --gpu/);
      const status = await browser.executeAsync((done) => {
        window.__TAURI__.core.invoke('daemon_rpc', { method: 'render.gpuStatus', params: {} }).then(done).catch((e) => done({ __error: String((e && e.message) || e) }));
      });
      log('gpu-status', { status });
      expect(status?.active).toBe(true);
    }
    if (RENDERER === 'blitz') { expect(page.blitz).toBeGreaterThan(0); expect(page.iframes).toBe(0); } else { expect(page.blitz).toBe(0); expect(page.iframes).toBeGreaterThan(0); }
  });

  after(async () => {
    try { await setStore({ emailRenderer: 'web', blitzGpu: false, viewStyle: 'list' }); } catch { /* app gone */ }
  });
});
