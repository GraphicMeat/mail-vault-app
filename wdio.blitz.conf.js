// The Blitz e2e conf: runs the Blitz-only specs, with the shared conf's default
// mock accounts. connected-blitz-interactions measures the iframe and Blitz on
// the same messages; connected-blitz-surfaces draws every email-body surface
// through Blitz (the Blitz fixture folder on luke); connected-blitz-preview
// draws the Cleanup preview; connected-blitz-perf is the thread and chat perf
// gate (20 bodies, iframe against Blitz, plan D Task 14).
//
// Out of the `connected-ci` selection on purpose: interactions carries a
// perf.foreground fold-paint gate a debug build misses on every run (a known,
// permanent red that would hide the reds that rotate between battery runs) and
// downloads Lora and Merriweather from fonts.googleapis.com, which that suite's
// "no real credentials or network" promise rules out; surfaces scrolls a
// 100-message chat and waits out a 240 s worker idle-out; perf is a debug-build
// timing gate. The shared conf's
// `exclude` keeps `--suite connected-ci` and the full run off them; this conf
// clears that list and selects the specs by name.
//
// Runs on the Mac mini only, one app instance at a time:
//   npm run build:e2e && npx wdio run wdio.blitz.conf.js [--spec <spec>]
// CI never selects it.
import { config as base } from './wdio.conf.js';

// Read by the shared conf's onPrepare, which runs after this module: luke's
// mock server then carries the Blitz fixture folder (mockImap.js blitzMailbox).
process.env.MV_BLITZ_FIXTURE = '1';

export const config = {
  ...base,
  exclude: [],
  specs: [
    './tests/e2e/connected-blitz-interactions.test.js',
    './tests/e2e/connected-blitz-surfaces.test.js',
    './tests/e2e/connected-blitz-preview.test.js',
    './tests/e2e/connected-blitz-perf.test.js',
  ],
  suites: {},
};
