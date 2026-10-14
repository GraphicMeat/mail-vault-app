// The parity harness's report bookkeeping (tests/e2e/connected-blitz-parity.test.js),
// kept pure so it has its own vitest. A run's report must never read as green when a
// case was not measured: a case that throws is a failed case, and the totals say how
// many cases were expected. No imports: the e2e runner (node) uses this file too.

/** One case's line in report.json, from compareFixture's result. */
export function caseSummary({ fixture, mode, width }, result) {
  return {
    fixture, mode, width,
    compared: result.compared,
    passed: result.passed,
    failing: result.failing.length,
    known: result.known.length,
  };
}

/** The line for a case that threw before it could be compared (no Blitz root, an
 * inspect error, a timeout): compared 0, failed, with the error text. */
export function failedCase({ fixture, mode, width }, error) {
  const text = String((error && error.message) || error || 'unknown error').split('\n')[0];
  return { fixture, mode, width, compared: 0, passed: false, failing: 0, known: 0, error: text };
}

/** Totals for report.json. `complete` is the gate: at least one case was expected, and every expected case ran and passed. */
export function reportTotals(cases, expected) {
  const passed = cases.filter((c) => c.passed).length;
  return { cases: cases.length, expected, passed, complete: expected > 0 && cases.length === expected && passed === expected };
}

/** Ids asked for in MV_PARITY_ONLY that the manifest does not have (a typo runs nothing). */
export function unknownFixtureIds(only, manifest) {
  const ids = new Set(manifest.fixtures.map((f) => f.id));
  return only.filter((id) => !ids.has(id));
}
