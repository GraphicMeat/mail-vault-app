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
 * Both modes mount what the real surface mounts: the bubble document
 * (buildChatBubbleDocument, collapsedMax 400) for the chat, the iframe
 * template with the fold scripts (foldQuotes, signatureDisplay) for the thread.
 * An iframe counts as painted only once its srcdoc document has loaded (not the
 * initial about:blank).
 *
 * Each surface also runs a DIAGNOSTIC control, logged as `[blitzperf-control]`
 * and not part of the gate: only the bodies that intersect the box mount (the
 * count the gate saw visible), so no body below the fold opens.
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

  before(async () => {
    await waitForApp();
    // The probe is installed lazily by the e2e build's module entry.
    await browser.waitUntil(() => browser.execute(() => !!window.__MV_BLITZ_PERF__?.run), { timeout: 30_000, timeoutMsg: 'window.__MV_BLITZ_PERF__ never installed' });
  });

  for (const [surface, width] of [['thread', 680], ['bubble', 300]]) {
    it(`${surface}: 20 messages first paint within the gate`, async () => {
      const run = (mode, limit = null) => browser.executeAsync((htmls, width, mode, surface, limit, done) => {
        window.__MV_BLITZ_PERF__.run({ htmls, width, mode, surface, limit }).then(done, e => done({ error: String(e?.message || e) }));
      }, htmls, width, mode, surface, limit);
      const series = async (limit) => {
        const cold = { iframe: await run('iframe', limit), blitz: await run('blitz', limit) }; // discarded, but must not have errored
        const res = { iframe: [], blitz: [] };
        for (let i = 0; i < 7; i++) { res.iframe.push(await run('iframe', limit)); res.blitz.push(await run('blitz', limit)); }
        const sum = {
          iframeP50: median(res.iframe.map(r => r.ms)), blitzP50: median(res.blitz.map(r => r.ms)),
          iframeGap: Math.max(...res.iframe.map(r => r.longestGapMs)), blitzGap: Math.max(...res.blitz.map(r => r.longestGapMs)),
          visible: res.blitz.map(r => r.visible), opens: res.blitz.map(r => r.opens), drawn: res.blitz.map(r => r.drawn),
        };
        const errs = [cold.iframe, cold.blitz, ...res.iframe, ...res.blitz].filter(r => r.error);
        return { cold, res, sum, errs };
      };

      // The gate: the plan's scenario, 20 bodies.
      const gate = await series(null);
      log(`${surface}-cold`, gate.cold);
      log(surface, { ...gate.sum, runs: gate.res });
      // The diagnostic control, NOT part of the gate: only the bodies that intersect the box mount (what the gate
      // saw visible), so nothing below the fold opens. Logged before any assertion so a gate failure still reports it.
      const control = await series(gate.res.blitz[0].visible);
      console.log(`[blitzperf-control] ${surface}-cold ${JSON.stringify(control.cold)}`);
      console.log(`[blitzperf-control] ${surface} ${JSON.stringify({ ...control.sum, runs: control.res })}`);

      expect(gate.errs).toEqual([]);
      expect(control.errs).toEqual([]);
      // A cache-hit run must fail loudly: every body a Blitz run drew was a fresh render.open, and every visible body drew.
      for (const r of [...gate.res.blitz, ...control.res.blitz]) {
        expect(r.visible).toBeGreaterThan(0);
        expect(r.opens).toBe(r.drawn);
        expect(r.opens).toBeGreaterThanOrEqual(r.visible);
        expect(r.visibleDocs).toBe(r.visible);
      }
      const { iframeP50: ip, blitzP50: bp, iframeGap: ig, blitzGap: bg } = gate.sum;
      expect(bp).toBeLessThanOrEqual(Math.max(1.25 * ip, ip + 150));
      expect(bp).toBeLessThanOrEqual(1500);
      expect(bg).toBeLessThanOrEqual(Math.max(ig, 50));
    });
  }
});
