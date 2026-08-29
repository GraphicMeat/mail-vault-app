import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const FILES = execSync("find src -name '*.jsx' -not -path '*__tests__*'", { encoding: 'utf8' })
  .trim().split('\n');

// `x === 1 ? A : B` where A or B is a bare English plural fragment.
const TERNARY = /\{\s*[\w.[\]]+(?:\.length)?\s*[!=]==?\s*1\s*\?[^}]{0,80}\}/g;
const FRAGMENT = /['"](?:s|es|was|were|copy|copies|message|messages|pixel|pixels|second|seconds|has|have)['"]/;

describe('plural forms', () => {
  it('leaves no English plural ternary in JSX', () => {
    const offenders = [];
    for (const f of FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8');
      for (const m of src.matchAll(TERNARY)) {
        if (FRAGMENT.test(m[0])) offenders.push(`${f}: ${m[0].slice(0, 70)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
