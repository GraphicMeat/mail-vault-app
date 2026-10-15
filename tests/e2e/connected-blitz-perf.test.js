/**
 * E2E: the Blitz thread and chat perf gate (plan D Task 14). It decides whether
 * the render worker pool grows to two (Task 15).
 *
 * 20 corpus bodies stacked in a scroll box (thread 680 px wide, chat 300 px),
 * timed from mount until every body in the box's viewport has painted, once
 * through the iframe and once through Blitz. One cold run per mode is
 * discarded, then 7 runs per mode, alternating. Pass needs all three:
 *   Blitz p50 <= max(1.25 x iframe p50, iframe p50 + 150 ms)
 *   Blitz p50 <= 1500 ms
 *   Blitz longest main-thread gap <= max(iframe longest gap, 50 ms)
 *
 * The probe (src/features/blitz/surfaces/perfProbe.jsx) must not time registry
 * cache hits: it closes the deferred docs before and after every Blitz run and
 * makes every body's html unique to its run. Each Blitz run reports `opens`
 * (new render docs it created) and `drawn` (bodies that ended with a doc); the
 * spec fails loudly unless they are equal and cover every visible body.
 *
 * A debug build (build:e2e): the numbers are debug numbers, as plan C's fold
 * perf numbers were. Every measurement is logged as `[blitzperf] <tag> <json>`
 * because the job clone is deleted after the run.
 *
 * Out of connected-ci (the shared conf's `exclude`): a debug-build timing gate.
 * wdio.blitz.conf.js selects it by name.
 */
import { waitForApp } from './helpers.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Plan B's corpus (tests/fixtures/blitz-corpus/manifest.json: { fixtures: [{ id, file }] }).
const CORPUS = join(resolve(import.meta.dirname, '../..'), 'tests/fixtures/blitz-corpus');
const MANIFEST = JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8'));

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const log = (tag, v) => console.log(`[blitzperf] ${tag} ${JSON.stringify(v)}`);

describe('Blitz thread and chat perf gate', function () {
  this.timeout(900_000);
  const htmls = MANIFEST.fixtures.slice(0, 20).map(f => readFileSync(join(CORPUS, f.file), 'utf8'));
  while (htmls.length < 20) htmls.push(...htmls.slice(0, 20 - htmls.length));

  before(async () => { await waitForApp(); await browser.execute(() => window.__SETTINGS_STORE__.setState({ emailRenderer: 'blitz' })); });
  after(async () => { await browser.execute(() => window.__SETTINGS_STORE__.setState({ emailRenderer: 'web' })); });

  for (const [surface, width] of [['thread', 680], ['bubble', 300]]) {
    it(`${surface}: 20 messages first paint within the gate`, async () => {
      const run = (mode) => browser.executeAsync((htmls, width, mode, surface, done) => {
        window.__MV_BLITZ_PERF__.run({ htmls, width, mode, surface }).then(done, e => done({ error: String(e?.message || e) }));
      }, htmls, width, mode, surface);
      const cold = { iframe: await run('iframe'), blitz: await run('blitz') }; // discarded
      log(`${surface}-cold`, cold);
      const res = { iframe: [], blitz: [] };
      for (let i = 0; i < 7; i++) { res.iframe.push(await run('iframe')); res.blitz.push(await run('blitz')); }
      const errs = [...res.iframe, ...res.blitz].filter(r => r.error);
      const ip = median(res.iframe.map(r => r.ms));
      const bp = median(res.blitz.map(r => r.ms));
      const ig = Math.max(...res.iframe.map(r => r.longestGapMs));
      const bg = Math.max(...res.blitz.map(r => r.longestGapMs));
      log(surface, {
        iframeP50: ip, blitzP50: bp, iframeGap: ig, blitzGap: bg,
        visible: res.blitz.map(r => r.visible), opens: res.blitz.map(r => r.opens), drawn: res.blitz.map(r => r.drawn), runs: res,
      });
      expect(errs).toEqual([]);
      // A cache-hit run must fail loudly: every body a Blitz run drew was a fresh render.open, and every visible body drew.
      for (const r of res.blitz) {
        expect(r.visible).toBeGreaterThan(0);
        expect(r.opens).toBe(r.drawn);
        expect(r.opens).toBeGreaterThanOrEqual(r.visible);
        expect(r.visibleDocs).toBe(r.visible);
      }
      expect(bp).toBeLessThanOrEqual(Math.max(1.25 * ip, ip + 150));
      expect(bp).toBeLessThanOrEqual(1500);
      expect(bg).toBeLessThanOrEqual(Math.max(ig, 50));
    });
  }
});
