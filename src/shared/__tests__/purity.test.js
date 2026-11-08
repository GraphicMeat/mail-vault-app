// @vitest-environment node
// src/shared is imported by both apps, so it may import nothing outside itself.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('..', import.meta.url));

describe('src/shared purity', () => {
  it('imports only bare relative siblings', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(3);
    const bad = [];
    for (const f of files) {
      const src = readFileSync(dir + f, 'utf8');
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        if (!/^\.\/[\w-]+(\.js)?$/.test(m[1])) bad.push(`${f}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
