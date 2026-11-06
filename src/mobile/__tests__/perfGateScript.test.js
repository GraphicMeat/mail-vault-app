// @vitest-environment node
// scripts/mobile-perf-verdict.mjs reads a log on stdin and decides the perf gate from the last
// `MV_MOBILE {"perf":…}` line: exit 0 pass, 1 fail, 2 no measurement (rerun; also any script
// error). It recomputes the verdict from the numbers (src/mobile/gate.js) and never trusts the
// app's `pass` alone.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FRAME_P95_LIMIT_MS, TAP_LIMIT_MS, PERF_ROWS } from '../perf.js';
import * as gate from '../gate.js';

const ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(ROOT, 'scripts/mobile-perf-verdict.mjs');

const PASSING = {
  blankFrames: 0, frameMax: 53, frameP50: 17, frameP95: 17, frames: 7593, pass: true, reachedEnd: true,
  reasons: [], rowHeight: 76, rows: 10000, scrollPxPerFrame: 100, tapP50: 17, tapP95: 17, tapStat: 'max',
  tapToPaint: 21, taps: 20, webview: 'Mozilla/5.0 (iPhone)',
};
const perfLine = (over = {}) => `MV_MOBILE ${JSON.stringify({ perf: { ...PASSING, ...over } })}`;
const PING = 'MV_MOBILE {"ping":{"engine":"0.1.0","schema":1}}';

function verdict(lines, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input: lines.join('\n') + '\n', encoding: 'utf8' });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // RED: no script, no JSON. The assertions on `out` below fail with the stderr in view.
  }
  return { code: r.status, out, stderr: r.stderr };
}

describe('mobile-perf-verdict', () => {
  it('a passing perf line exits 0', () => {
    const { code, out, stderr } = verdict([PING, perfLine()]);
    expect(out, stderr).toMatchObject({ verdict: 'pass', pass: true, reasons: [] });
    expect(out.record.frameP95).toBe(17);
    expect(code).toBe(0);
  });

  it('reads the line out of logcat / Console prefixes', () => {
    const { code, out } = verdict([`I MailVault: ${PING}`, `11-06 10:00:00.000  1234  1234 I MailVault: ${perfLine()}`]);
    expect(out).toMatchObject({ verdict: 'pass' });
    expect(code).toBe(0);
  });

  it('failing numbers exit 1 with the reason', () => {
    const { code, out } = verdict([PING, perfLine({ tapToPaint: 140, pass: false, reasons: ['tap'] })]);
    expect(out).toMatchObject({ verdict: 'fail', pass: false });
    expect(out.reasons.join(' ')).toMatch(/tap to paint 140/);
    expect(code).toBe(1);
  });

  it('app pass:true with frameP95 25 exits 1: the numbers win, and the disagreement is named', () => {
    const { code, out } = verdict([perfLine({ frameP95: 25 })]);
    expect(out).toMatchObject({ verdict: 'fail', pass: false });
    expect(out.reasons.join(' ')).toMatch(/frame p95 25/);
    expect(out.reasons.join(' ')).toMatch(/disagree/);
    expect(code).toBe(1);
  });

  it('app pass:false with passing numbers exits 1 (disagreement)', () => {
    const { code, out } = verdict([perfLine({ pass: false })]);
    expect(out.pass).toBe(false);
    expect(out.reasons.join(' ')).toMatch(/disagree/);
    expect(code).toBe(1);
  });

  it('unmeasured numbers (-1) never pass, even though -1 is under every limit: no measurement, exit 2', () => {
    const { code, out } = verdict([perfLine({ frameP95: -1, tapToPaint: -1, pass: true })]);
    expect(out).toMatchObject({ verdict: 'no-measurement', pass: false });
    expect(out.reasons.join(' ')).toMatch(/frameP95 not measured/);
    expect(out.reasons.join(' ')).toMatch(/tapToPaint not measured/);
    expect(code).toBe(2);
  });

  it('a missing number is no measurement, exit 2', () => {
    const { rows: _rows, ...noRows } = PASSING;
    const { code, out } = verdict([`MV_MOBILE ${JSON.stringify({ perf: noRows })}`]);
    expect(out.verdict).toBe('no-measurement');
    expect(out.reasons.join(' ')).toMatch(/rows not measured/);
    expect(code).toBe(2);
  });

  it('a non-finite number (1e999 parses to Infinity) is no measurement, exit 2', () => {
    const line = perfLine().replace('"blankFrames":0', '"blankFrames":1e999');
    expect(line).toContain('1e999');
    const { code, out } = verdict([line]);
    expect(out.verdict).toBe('no-measurement');
    expect(out.reasons.join(' ')).toMatch(/blankFrames not measured/);
    expect(code).toBe(2);
  });

  it('a whole run is required: rows, reachedEnd, blankFrames, tapStat max', () => {
    const { code, out } = verdict([perfLine({ rows: 250, reachedEnd: false, blankFrames: 3, tapStat: 'p95' })]);
    const all = out.reasons.join(' | ');
    expect(all).toMatch(/250 rows/);
    expect(all).toMatch(/did not reach the last row/);
    expect(all).toMatch(/3 scroll frames/);
    expect(all).toMatch(/tapStat/);
    expect(code).toBe(1);
  });

  it('a probe-failed line (no numbers) is no measurement, exit 2, with the app reason kept', () => {
    const line = `MV_MOBILE ${JSON.stringify({ perf: { pass: false, reasons: ['probe failed: list not mounted'], webview: 'x' } })}`;
    const { code, out } = verdict([line]);
    expect(out).toMatchObject({ verdict: 'no-measurement', pass: false });
    expect(out.reasons.join(' ')).toMatch(/probe failed: list not mounted/);
    expect(code).toBe(2);
  });

  it('a probe-failed reason makes even a line with numbers no measurement, exit 2', () => {
    const { code, out } = verdict([perfLine({ pass: false, reasons: ['probe failed: timeout'] })]);
    expect(out.verdict).toBe('no-measurement');
    expect(out.reasons.join(' ')).toMatch(/probe failed: timeout/);
    expect(code).toBe(2);
  });

  it('an unmeasured first launch does not decide: a measured last line still does', () => {
    const { code, out } = verdict([perfLine({ frameP95: -1, pass: false }), perfLine()], ['--expect', '2']);
    expect(out.verdict).toBe('pass');
    expect(out.runs[0].pass).toBe(false);
    expect(code).toBe(0);
  });

  it('the last perf line is the record: a passing first run does not rescue a failing second', () => {
    const { code, out } = verdict([perfLine(), PING, perfLine({ frameP95: 33, pass: false })], ['--expect', '2']);
    expect(out.runs).toHaveLength(2);
    expect(out.runs[0].pass).toBe(true);
    expect(out.pass).toBe(false);
    expect(out.record.frameP95).toBe(33);
    expect(code).toBe(1);
  });

  it('no perf line exits 2', () => {
    const { code, out } = verdict([PING]);
    expect(out).toMatchObject({ verdict: 'no-measurement', pass: false });
    expect(code).toBe(2);
  });

  it('an empty log exits 2', () => {
    const { code, out } = verdict([]);
    expect(out.verdict).toBe('no-measurement');
    expect(code).toBe(2);
  });

  it('fewer perf lines than launches expected exits 2 (a later launch never reported)', () => {
    const { code, out } = verdict([PING, perfLine(), PING], ['--expect', '2']);
    expect(out.verdict).toBe('no-measurement');
    expect(out.reasons.join(' ')).toMatch(/1 perf line.*expected 2/);
    expect(code).toBe(2);
  });

  it('a timed-out or failed run (non-zero run status) exits 2 even with a passing line in the log', () => {
    const { code, out } = verdict([PING, perfLine()], ['--run-status', '1']);
    expect(out.verdict).toBe('no-measurement');
    expect(out.reasons.join(' ')).toMatch(/run exited 1/);
    expect(code).toBe(2);
  });

  it('a seedError line exits 2', () => {
    const { code, out } = verdict([`MV_MOBILE ${JSON.stringify({ seedError: 'disk full' })}`, PING, perfLine()]);
    expect(out.verdict).toBe('no-measurement');
    expect(out.reasons.join(' ')).toMatch(/seedError.*disk full/);
    expect(code).toBe(2);
  });

  it('an engineError line exits 2', () => {
    const { code, out } = verdict([`MV_MOBILE ${JSON.stringify({ engineError: 'app data dir' })}`]);
    expect(out.verdict).toBe('no-measurement');
    expect(code).toBe(2);
  });

  it('a malformed (truncated) perf line exits 2', () => {
    const { code, out } = verdict([PING, perfLine().slice(0, 80)]);
    expect(out.verdict).toBe('no-measurement');
    expect(out.reasons.join(' ')).toMatch(/not JSON/);
    expect(code).toBe(2);
  });

  it('a bare error line (perf.report or a page load failed) exits 2', () => {
    const { code, out } = verdict([PING, `MV_MOBILE ${JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } })}`]);
    expect(out.verdict).toBe('no-measurement');
    expect(out.reasons.join(' ')).toMatch(/error.*boom/);
    expect(code).toBe(2);
  });

  it('an unknown argument exits 2, never 1', () => {
    const { code, out, stderr } = verdict([perfLine()], ['--expcet', '2']);
    expect(stderr).toMatch(/unknown argument --expcet/);
    expect(out).toMatchObject({ verdict: 'no-measurement', pass: false });
    expect(code).toBe(2);
  });

  it('a bad --expect value exits 2', () => {
    const { code } = verdict([perfLine()], ['--expect', 'two']);
    expect(code).toBe(2);
  });

  it('a crash (gate.js cannot be loaded) exits 2, never 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-verdict-'));
    try {
      const copy = join(dir, 'mobile-perf-verdict.mjs');
      copyFileSync(SCRIPT, copy);
      const r = spawnSync(process.execPath, [copy], { input: `${perfLine()}\n`, encoding: 'utf8' });
      expect(r.stderr).toMatch(/mobile-perf-verdict/);
      expect(r.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a perf value that is not an object exits 2', () => {
    const { code, out } = verdict(['MV_MOBILE {"perf":"fast"}']);
    expect(out.verdict).toBe('no-measurement');
    expect(code).toBe(2);
  });
});

describe('one source of thresholds', () => {
  it('perf.js re-exports the limits gate.js holds', () => {
    expect(FRAME_P95_LIMIT_MS).toBe(gate.FRAME_P95_LIMIT_MS);
    expect(TAP_LIMIT_MS).toBe(gate.TAP_LIMIT_MS);
    expect(PERF_ROWS).toBe(gate.PERF_ROWS);
  });

  it('the verdict script imports gate.js instead of restating the limits', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/import\(['"]\.\.\/src\/mobile\/gate\.js['"]\)/);
    expect(src).not.toMatch(/\b(20|100|10_?000)\b/);
  });

  it('gate.js is plain Node ESM (the script can import it outside vite)', () => {
    const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(resolve(ROOT, 'src/mobile/gate.js')).href)}).then(m => console.log(m.FRAME_P95_LIMIT_MS))`], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe(String(gate.FRAME_P95_LIMIT_MS));
  });
});
