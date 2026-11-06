#!/usr/bin/env node
// Decides the mobile perf gate from an app log on stdin and prints the verdict as JSON.
//
//   node scripts/mobile-perf-verdict.mjs [--expect N] [--run-status RC] < log
//
// The log can be scripts/mobile-run.sh output, `adb logcat`, or lines copied from Console.app:
// whatever precedes `MV_MOBILE ` on a line is ignored. The LAST `MV_MOBILE {"perf":…}` line is the
// record; earlier ones (a first launch) are reported under `runs` but do not decide.
//
// The verdict is recomputed from the numbers with src/mobile/gate.js, the same limits the app
// uses, and the app's own `pass` must agree with it.
//
// Exit 0: pass. Exit 1: the measurement fails the gate (or the app and the numbers disagree).
// Exit 2: no measurement: no perf line, fewer perf lines than --expect, a line that is not JSON, a
// seedError / engineError line, or --run-status non-zero (the run timed out or failed, so even a
// passing line already in the log does not count).
import { gateVerdict, wholeRunReasons } from '../src/mobile/gate.js';

const PASS = 0;
const FAIL = 1;
const NO_MEASUREMENT = 2;

function parseArgs(argv) {
  const args = { expect: 1, runStatus: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--expect' && v !== undefined) { args.expect = Number(v); i++; }
    else if (a === '--run-status' && v !== undefined) { args.runStatus = Number(v); i++; }
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(args.expect) || args.expect < 1) throw new Error('--expect must be a positive integer');
  return args;
}

const measured = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The gate for one perf object, from its numbers. */
export function judgeRun(perf) {
  const reasons = [];
  for (const key of ['frameP95', 'tapToPaint', 'rows', 'blankFrames']) {
    if (!measured(perf[key])) reasons.push(`${key} not measured (${JSON.stringify(perf[key] ?? null)})`);
  }
  if (perf.tapStat !== 'max') reasons.push(`tapStat is ${JSON.stringify(perf.tapStat ?? null)}, the gate needs "max"`);
  // An unmeasured number already failed above; 0 keeps the limit check from repeating it.
  reasons.push(...gateVerdict({
    frameP95: measured(perf.frameP95) ? perf.frameP95 : 0,
    tapToPaint: measured(perf.tapToPaint) ? perf.tapToPaint : 0,
  }).reasons);
  reasons.push(...wholeRunReasons({ rows: perf.rows, reachedEnd: perf.reachedEnd, blankFrames: perf.blankFrames }));
  const computed = reasons.length === 0;
  if (perf.pass !== computed) {
    reasons.push(`app and numbers disagree: app pass ${JSON.stringify(perf.pass ?? null)}, numbers say ${computed}`);
  }
  if (Array.isArray(perf.reasons)) for (const r of perf.reasons) reasons.push(`app: ${r}`);
  return { pass: computed && perf.pass === true, reasons };
}

export function decide(text, { expect = 1, runStatus = 0 } = {}) {
  const noMeasurement = [];
  const runs = [];
  for (const raw of text.split(/\r?\n/)) {
    const at = raw.indexOf('MV_MOBILE ');
    if (at < 0) continue;
    const body = raw.slice(at + 'MV_MOBILE '.length).trim();
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      noMeasurement.push(`a MV_MOBILE line is not JSON: ${body.slice(0, 120)}`);
      continue;
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      noMeasurement.push(`a MV_MOBILE line is not a JSON object: ${body.slice(0, 120)}`);
      continue;
    }
    for (const key of ['seedError', 'engineError']) {
      if (key in msg) noMeasurement.push(`${key}: ${JSON.stringify(msg[key])}`);
    }
    if ('perf' in msg) {
      const perf = msg.perf;
      if (perf === null || typeof perf !== 'object' || Array.isArray(perf)) {
        noMeasurement.push(`perf is not an object: ${JSON.stringify(perf)}`);
        continue;
      }
      runs.push({ perf, ...judgeRun(perf) });
    }
  }
  if (runStatus !== 0) noMeasurement.push(`the run exited ${runStatus} (timeout or failure), so no line in it counts`);
  if (runs.length === 0) noMeasurement.push('no MV_MOBILE perf line in the log');
  else if (runs.length < expect) noMeasurement.push(`${runs.length} perf line(s), expected ${expect} (a later launch never reported)`);

  const last = runs.at(-1);
  const summary = runs.map((r) => ({
    pass: r.pass, frameP95: r.perf.frameP95 ?? null, tapToPaint: r.perf.tapToPaint ?? null, reasons: r.reasons,
  }));
  if (noMeasurement.length) {
    return { exit: NO_MEASUREMENT, verdict: 'no-measurement', pass: false, reasons: noMeasurement, record: last?.perf ?? null, runs: summary };
  }
  return {
    exit: last.pass ? PASS : FAIL,
    verdict: last.pass ? 'pass' : 'fail',
    pass: last.pass,
    reasons: last.reasons,
    record: last.perf,
    runs: summary,
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`mobile-perf-verdict: ${e.message}`);
    process.exit(64);
  }
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  const result = decide(text, args);
  const { exit, ...out } = result;
  process.stdout.write(`${JSON.stringify({ ...out, exit }, null, 2)}\n`);
  process.exitCode = exit;
}

main();
