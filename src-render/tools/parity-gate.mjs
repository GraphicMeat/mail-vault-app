// The parity gate on a written report: exit 0 only for a complete run in which every
// case passed (src/features/blitz/parity/report.js reportGate). Usage: node parity-gate.mjs <report.json>
import { readFileSync } from 'node:fs';
import { reportGate } from '../../src/features/blitz/parity/report.js';

let report = null;
try { report = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch { /* unreadable: not a pass */ }
const t = (report && report.totals) || {};
console.error(`parity gate: ${t.passed ?? '?'} of ${t.cases ?? '?'} cases passed, ${t.expected ?? '?'} planned, complete ${t.complete ?? 'unknown'}`);
process.exit(reportGate(report) ? 0 : 1);
