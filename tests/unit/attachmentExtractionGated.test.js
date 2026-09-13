import { test, expect } from 'vitest';

/**
 * The extraction pass must never run when the attachments toggle is off —
 * mirrors src-tauri/src/search_index.rs's worker loop, which is invisible to
 * `cargo test -p mailvault` (CI never runs it). This grep-guard is the only
 * automated check that the `if config.attachments` gate around
 * `run_pending_extractions(` still exists.
 */
const fs = require('fs');

test('run_pending_extractions is only called inside an attachments-enabled branch', () => {
  const src = fs.readFileSync('src-tauri/src/search_index.rs', 'utf8');
  const callSite = src.indexOf('run_pending_extractions(');
  expect(callSite).toBeGreaterThan(-1);
  const before = src.slice(Math.max(0, callSite - 400), callSite);
  expect(before).toMatch(/attachments/);
});
