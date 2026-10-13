// The Blitz renderer is a removable module: only the app entry may import it,
// and the module itself must not be reached by relative paths from core. This
// test passes trivially once the module is deleted.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..');               // src/
const MODULE = join(SRC, 'features', 'blitz');
const ENTRIES = new Set(['main.jsx'].map(f => join(SRC, f)));

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') yield* walk(p); }
    else if (/\.(js|jsx|mjs)$/.test(name)) yield p;
  }
}

describe('Blitz module boundary', () => {
  it('only the entry imports src/features/blitz', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(MODULE + sep) || ENTRIES.has(file) || file.includes(`${sep}__tests__${sep}`)) continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*features\/blitz[^'"]*['"]|import\(\s*['"][^'"]*features\/blitz/.test(text)) offenders.push(relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });
});
