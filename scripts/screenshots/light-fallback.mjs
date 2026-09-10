/**
 * Drop the light half of a screenshot placement whose light capture is missing.
 *
 * Every `<picture>` on the site pairs a dark `<source>` with a light `<img>`.
 * A shot that skipped in a capture run has no `-light-*.webp` on disk, and
 * `i18n.mjs verify` — which the deploy runs before it rsyncs — fails on a
 * missing image, so one skipped shot would break the whole deploy rather than
 * one picture. Unwrap those back to the plain dark `<img>` they were before.
 *
 *   node scripts/screenshots/light-fallback.mjs            # rewrite
 *   node scripts/screenshots/light-fallback.mjs --check     # report only
 *
 * English pages only: the localized pages are generated from these, and
 * `localizeShot` already falls back to the English file per locale.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../website');
const SKIP = new Set(['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt-br', 'zh',
  'node_modules', 'i18n', 'assets', 'api', 'src', 'screenshots', 'oauth']);
const CHECK = process.argv.includes('--check');

function pages(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) pages(full, out); }
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const exists = (url) => fs.existsSync(path.join(ROOT, url.split(/[?#]/)[0].replace(/^\//, '')));

const PICTURE = /<picture><source\b[^>]*\bdata-shot-dark\b[^>]*>(<img\b[^>]*>)<\/picture>/g;
const attr = (tag, name) => (new RegExp(`\\s${name}="([^"]*)"`).exec(tag) || [])[1];

let unwrapped = 0;
const missing = new Set();

for (const page of pages()) {
  const html = fs.readFileSync(page, 'utf8');
  const next = html.replace(PICTURE, (whole, img) => {
    const light = attr(img, 'src');
    if (!light || exists(light)) return whole;
    missing.add(light);
    const source = /<source\b[^>]*>/.exec(whole)[0];
    const darkSet = attr(source, 'srcset') || '';
    const darkSrc = darkSet.split(',').map((s) => s.trim().split(/\s+/)[0])
      .find((u) => u.includes('-1440.')) || darkSet.split(',')[0].trim().split(/\s+/)[0];
    unwrapped++;
    return img
      .replace(/\ssrc="[^"]*"/, ` src="${darkSrc}"`)
      .replace(/\ssrcset="[^"]*"/, darkSet ? ` srcset="${darkSet}"` : '');
  });
  if (next !== html && !CHECK) fs.writeFileSync(page, next);
}

for (const url of [...missing].sort()) console.log(`missing light capture: ${url}`);
console.log(`${CHECK ? 'would unwrap' : 'unwrapped'} ${unwrapped} picture(s)`);
if (CHECK && unwrapped) process.exitCode = 1;
