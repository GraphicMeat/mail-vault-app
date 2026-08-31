import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import baseline from './audit-baseline.json';

const AUDIT = resolve(process.cwd(), 'scripts/i18n-audit.mjs');

// The extraction is finished, so the allowlist is gone: the audit now runs
// over every non-test .jsx under src/. A NEW hardcoded string anywhere in the
// app fails here.

function audit(mode, files) {
  try {
    execFileSync('node', [AUDIT, mode, ...files], { encoding: 'utf8' });
    return '';
  } catch (e) {
    return e.stdout || String(e);
  }
}

// `strings` mode prints one unindented "path  (N)" header per file, then one
// indented `JSON.stringify(x)` line per finding under it (see i18n-audit.mjs's
// own console.log calls) — never a raw newline, since JSON.stringify escapes
// them, so every finding is exactly one line here regardless of how many
// source lines its JSX text node spanned.
function parseFindings(output) {
  const findings = [];
  let file = null;
  for (const line of output.split('\n')) {
    if (/^\S/.test(line)) {
      const header = /^(.+?)\s+\(\d+\)$/.exec(line);
      file = header ? header[1] : null; // null on the trailing "strings: N finding(s)" line
      continue;
    }
    const trimmed = line.trim();
    if (file && trimmed.startsWith('"')) findings.push({ file, string: JSON.parse(trimmed) });
  }
  return findings;
}

// audit-baseline.json is KNOWN, pre-existing debt (see the comment at its own
// top) — a ceiling, not a target. This checks the current findings are a
// SUBSET of it: anything already listed is free, anything new fails. Counted,
// not just a Set, so a second copy of an already-known string pasted into the
// same file still counts as new.
function newFindings(current, known) {
  const key = (f) => JSON.stringify([f.file, f.string]);
  const allowed = new Map();
  for (const f of known) allowed.set(key(f), (allowed.get(key(f)) || 0) + 1);
  const seen = new Map();
  return current.filter((f) => {
    const k = key(f);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return n > (allowed.get(k) || 0);
  });
}

describe('the whole app stays drained', () => {
  it('adds no hardcoded JSX strings beyond the known baseline', () => {
    const current = parseFindings(audit('strings', []));
    const fresh = newFindings(current, baseline.findings);
    expect(fresh.map((f) =>
      `${f.file}: hardcoded string ${JSON.stringify(f.string)} — wrap it in t(), or if ` +
      'it truly cannot be localized yet, add it to src/i18n/__tests__/audit-baseline.json ' +
      'with a reason in the PR. This is NOT a way to silence this failure.'
    )).toEqual([]);
  });

  it('has no component calling t() without useT()', () => {
    expect(audit('hooks', [])).toBe('');
  });
});
