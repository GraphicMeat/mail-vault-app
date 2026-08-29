import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

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

describe('the whole app stays drained', () => {
  it('has no hardcoded JSX strings anywhere', () => {
    expect(audit('strings', [])).toBe('');
  });

  it('has no component calling t() without useT()', () => {
    expect(audit('hooks', [])).toBe('');
  });
});
