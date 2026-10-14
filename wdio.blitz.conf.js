// The Blitz interactions e2e conf: runs the one spec that measures the iframe
// and Blitz on the same messages, with the shared conf's default mock accounts.
//
// Out of the `connected-ci` selection on purpose: it carries a perf.foreground
// fold-paint gate a debug build misses on every run (a known, permanent red
// that would hide the reds that rotate between battery runs), and it downloads
// Lora and Merriweather from fonts.googleapis.com, which that suite's "no real
// credentials or network" promise rules out. This conf selects it by name.
//
// Runs on the Mac mini only, one app instance at a time: `npm run test:e2e:blitz`.
// Matches no suite glob, so CI never selects it.
import { config as base } from './wdio.conf.js';

export const config = {
  ...base,
  exclude: [],
  specs: ['./tests/e2e/connected-blitz-interactions.test.js'],
  suites: {},
};
