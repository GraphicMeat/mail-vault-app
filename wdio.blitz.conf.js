// The Blitz interactions e2e conf: runs the one spec that measures the iframe
// and Blitz on the same messages, with the shared conf's default mock accounts.
//
// Out of the `connected-ci` selection on purpose: it carries a perf.foreground
// fold-paint gate a debug build misses on every run (a known, permanent red
// that would hide the reds that rotate between battery runs), and it downloads
// Lora and Merriweather from fonts.googleapis.com, which that suite's "no real
// credentials or network" promise rules out. The shared conf's `exclude` keeps
// `--suite connected-ci` and the full run off it; this conf clears that list
// and selects the spec by name.
//
// Runs on the Mac mini only, one app instance at a time:
//   npm run build:e2e && npx wdio run wdio.blitz.conf.js
// CI never selects it.
import { config as base } from './wdio.conf.js';

export const config = {
  ...base,
  exclude: [],
  specs: ['./tests/e2e/connected-blitz-interactions.test.js'],
  suites: {},
};
