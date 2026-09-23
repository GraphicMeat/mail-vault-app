import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { listSourceFiles } from '../../../scripts/lib/sourceFiles.mjs';
import en from '../locales/en.json';

/**
 * catalogs.test.js proves every locale matches en.json. Nothing proved en.json
 * holds every key the code asks for: `t()` falls back to the raw key, so a
 * missing one renders "settings.cleanup.px" on screen (or, in that case, as an
 * iframe's CSS height) with every test green.
 */
const FILES = listSourceFiles(['src'], ['.js', '.jsx'], { exclude: ['__tests__', '.test.'] });

const KEY = String.raw`([a-zA-Z][\w-]*(?:\.[\w-]+)+)`;
// t('a.b'), tr('a.b'), tErr('a.b'), translated('a.b', ...), labelKey: 'a.b', ...
const LITERAL = [
  new RegExp(String.raw`(?:^|[^\w.$])(?:t|tr|tErr|translated)\(\s*(['"])${KEY}\1`, 'g'),
  new RegExp(String.raw`\b\w+Key\s*[:=]\s*(['"])${KEY}\1`, 'g'),
  // Service errors travel as bare catalog keys and are translated at render.
  new RegExp(String.raw`(['"])(errors\.[\w.-]+)\1`, 'g'),
];
// t(`views.op.${op}`): the static head must prefix at least one real key.
const TEMPLATE = /(?:^|[^\w.$])(?:t|tr|tErr)\(\s*`([^`$]*)\$\{/g;

const namespaces = new Set(Object.keys(en).map(k => k.split('.')[0]));
const has = k => k in en || `${k}_other` in en || `${k}_one` in en;

function scan() {
  const missing = [];
  const deadPrefixes = [];
  for (const f of FILES) {
    const src = readFileSync(f, 'utf8');
    const line = i => src.slice(0, i).split('\n').length;
    for (const re of LITERAL) for (const m of src.matchAll(re)) {
      const k = m[2];
      if (namespaces.has(k.split('.')[0]) && !has(k)) missing.push(`${f}:${line(m.index)} ${k}`);
    }
    for (const m of src.matchAll(TEMPLATE)) {
      const head = m[1];
      if (head && !Object.keys(en).some(k => k.startsWith(head))) {
        deadPrefixes.push(`${f}:${line(m.index)} ${head}\${...}`);
      }
    }
  }
  return { missing, deadPrefixes };
}

describe('every key the code asks for exists in en.json', () => {
  const { missing, deadPrefixes } = scan();

  it('resolves every literal t() / *Key / errors.* key', () => {
    expect(missing).toEqual([]);
  });

  it('resolves the static head of every template key', () => {
    expect(deadPrefixes).toEqual([]);
  });
});
