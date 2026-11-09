// @vitest-environment node
// No price is written in the mobile app: amounts come from the store at run time. The sources are
// always checked; the built bundle (`npm run mobile:build:web`, `dist-mobile`) is checked when it
// exists, which is how the build job runs this.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = path.resolve(here, '..');
const DIST = path.resolve(here, '../../../dist-mobile');

// 5.99 / 39.99, and any currency amount: a symbol or code next to a number (decimals, a symbol in
// front of a euro-style digit, a whole amount with a period word). `"$1"` in a regex replacement
// is not a price.
const PRICE = new RegExp([
  String.raw`(?<![\d.])(?:5[.,]99|39[.,]99)(?!\d)`,
  String.raw`[$€£¥₩]\s?\d+[.,]\d{2}(?!\d)`,
  String.raw`(?<![\d.])\d+[.,]\d{2}\s?[$€£¥₩]`,
  String.raw`[€£¥₩]\s?\d`,
  String.raw`\d\s?[€£¥₩]`,
  String.raw`\$\s?\d+(?=\s?(?:\/|per\b|a\b|USD|EUR))`,
  String.raw`\b(?:USD|EUR|GBP)\s?\d`,
  String.raw`\d\s?(?:USD|EUR|GBP)\b`,
].join('|'));

/** Each file with its first match and the text around it, so a failure says what it found. */
function offenders(list) {
  const out = [];
  for (const f of list) {
    const text = readFileSync(f, 'utf8');
    const m = PRICE.exec(text);
    if (m) out.push(`${path.basename(f)}: ${JSON.stringify(text.slice(Math.max(0, m.index - 30), m.index + 30))}`);
  }
  return out;
}

function files(dir, ok) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' || n === 'fixtures' ? [] : files(p, ok);
    return ok(n) ? [p] : [];
  });
}

describe('no hard-coded prices', () => {
  it('the mobile sources contain none', () => {
    expect(offenders(files(SRC, (n) => /\.(jsx?|css)$/.test(n) && !/\.test\./.test(n)))).toEqual([]);
  });

  it.skipIf(!existsSync(DIST))('the built bundle contains none', () => {
    const built = files(DIST, (n) => /\.(js|html|css)$/.test(n));
    expect(built.length).toBeGreaterThan(0);
    expect(offenders(built)).toEqual([]);
  });
});
