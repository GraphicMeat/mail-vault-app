import { test, expect } from 'vitest';

/**
 * The extraction pass must never run when the attachments toggle is off —
 * mirrors src-daemon/src/search_index.rs's worker loop. The worker's gate is
 * covered by no unit test today; this grep-guard is the only automated check
 * that the `if config.attachments` gate around `run_pending_extractions(`
 * still exists.
 */
const fs = require('fs');

test('run_pending_extractions is only called inside an attachments-enabled branch', () => {
  const src = fs.readFileSync('src-daemon/src/search_index.rs', 'utf8');
  const callSite = src.indexOf('run_pending_extractions(');
  expect(callSite).toBeGreaterThan(-1);
  const before = src.slice(Math.max(0, callSite - 400), callSite);
  expect(before).toMatch(/attachments/);
});
