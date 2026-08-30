import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') sources(p, out);
    } else if (/\.jsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * A call to the bare identifier `t` with a key literal: `t('a.b')`.
 *
 * The lookbehind is what makes it safe — `split('` and `.t('` are both
 * preceded by a word character or a dot and do not match. An earlier version
 * of this scanner stripped strings and comments first with a regex; on a large
 * file the quote pairing went wrong, swallowed the real calls, and the test
 * passed with the bug still present. Match the narrow shape instead of trying
 * to parse JavaScript.
 */
const callsT = (s) => /(?<![\w.$])t\(\s*['"`]/.test(s);
const hasT = (s) => /import\s*\{[^}]*\bt\b[^}]*\}\s*from/.test(s) || /useT\s*\(\s*\)/.test(s);

// A file that binds `t` locally must import under an alias instead — see
// src/i18n/__tests__/serviceMessages.test.js, which enforces that half.

describe('the translator is in scope wherever it is called', () => {
  /**
   * `t` is a plain module export, so calling it without importing it is a free
   * identifier — a global, as far as the bundler is concerned. The build stays
   * silent and it detonates at runtime instead:
   * `ReferenceError: Can't find variable: t`, thrown during render, which the
   * error boundary shows as "Something went wrong. Please restart the app."
   *
   * `src/utils/emailParser.js` shipped exactly that on the localization branch
   * and took the entire chat view down with it.
   */
  it('has no source file calling t() without importing it or using useT()', () => {
    const offenders = sources(SRC)
      .filter((f) => callsT(readFileSync(f, 'utf-8')) && !hasT(readFileSync(f, 'utf-8')))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it('recognises the offending shape', () => {
    expect(callsT("export const f = () => t('a.b');")).toBe(true);
    expect(hasT("export const f = () => t('a.b');")).toBe(false);
  });

  it('does not flag a method call or split()', () => {
    expect(callsT("x.t('a')")).toBe(false);
    expect(callsT("'a,b'.split(',')")).toBe(false);
    expect(callsT("obj.format('x')")).toBe(false);
  });

  it('flags the real file when its import is removed', () => {
    const src = readFileSync(join(SRC, 'utils/emailParser.js'), 'utf-8');
    const broken = src
      .split('\n')
      .filter((l) => !l.startsWith('import { t as tr } from '))
      .join('\n')
      .replace(/\btr\('/g, "t('");
    expect(callsT(broken)).toBe(true);
    expect(hasT(broken)).toBe(false);
    // ...and the shipped file is clean because it calls through the alias.
    expect(callsT(src)).toBe(false);
  });
});
