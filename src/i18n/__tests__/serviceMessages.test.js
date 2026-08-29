import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import en from '../locales/en.json';

const FILES = execSync(
  "find src/services src/stores src/hooks src/utils -name '*.js' -not -path '*__tests__*'",
  { encoding: 'utf8' }
).trim().split('\n');

const LITERAL = /(?:throw new Error\(|setError\(|showToast\()['"`]([A-Z][^'"`]{8,})['"`]/g;

describe('service-layer messages', () => {
  it('raises no bare English sentence — every message goes through a key', () => {
    const offenders = [];
    for (const f of FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8');
      for (const m of src.matchAll(LITERAL)) offenders.push(`${f}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('gives every errors.* key a non-empty English string', () => {
    const errs = Object.entries(en).filter(([k]) => k.startsWith('errors.'));
    expect(errs.length).toBeGreaterThan(10);
    for (const [k, v] of errs) expect(v, k).toBeTruthy();
  });
});

/**
 * `messageMutations.js` binds `t` twelve times as a loop/callback parameter
 * (tombstones). A plain `import { t }` there is shadowed inside every one of
 * those callbacks, so `t('errors.x')` would call the tombstone rather than the
 * catalog — a TypeError at best, silent nonsense at worst. Such a file must
 * import under an alias.
 */
describe('no module shadows its own catalog import', () => {
  it('never imports bare `t` into a file that also binds `t` locally', () => {
    const offenders = [];
    for (const f of FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8');
      const importsBareT = /import\s*\{[^}]*(^|[^a-zA-Z_$])t\s*(,|\})/m.test(src)
        && !/\bt\s+as\s+\w+/.test(src);
      if (!importsBareT) continue;
      const bindsT = /(?:\bconst|\blet|\bvar)\s+t\b|\(\s*t\s*(?:,|\))|\bt\s*=>/.test(src);
      if (bindsT) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
