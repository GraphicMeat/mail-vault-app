#!/usr/bin/env node
/**
 * The gate for the string extraction. Two checks, both mechanical, because the
 * hand-written key list is what went wrong last time:
 *
 *   strings — user-facing literals still hardcoded in JSX. The text regex is
 *             whole-file and `\s*`-tolerant on purpose: a line-based grep cannot
 *             see a text node whose `>` and text sit on different lines, and 14
 *             of Sidebar's 54 strings were exactly that shape.
 *   hooks   — components that call t(...) but never call useT(). Placing hooks
 *             from a scan taken BEFORE the last extraction pass shipped a
 *             `ReferenceError: t is not defined` in Plan 1.
 *
 * Usage: node scripts/i18n-audit.mjs strings|hooks [file ...]
 * Exits 1 if anything is found, so a task can gate its own commit on it.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const TEXT = /(>)(\s*)([A-Za-z][A-Za-z0-9 ,.'!?:%\-—’]*?)(\s*)(<)/g;
const PROP = /\b(?:title|aria-label|placeholder|alt)="([A-Za-z][^"]{1,})"/g;

// JSX text that is markup or code, not prose for a human.
const IGNORE = /^(https?|www\.|[A-Za-z]+\(|\d+$)/;

// `T.jsx` documents the `<0>…</0>` slot syntax in its own comments and JSDoc,
// which reads as a text node to the pattern above. Excluding the file is
// honest; loosening the pattern to accommodate it would blind the audit
// everywhere else.
const IGNORE_FILES = new Set(['src/i18n/T.jsx']);

function jsxStrings(src) {
  const out = [];
  for (const m of src.matchAll(TEXT)) {
    const v = m[3].trim();
    if (v && !IGNORE.test(v)) out.push(v);
  }
  for (const m of src.matchAll(PROP)) out.push(m[1]);
  return out;
}

/**
 * Top-level component declarations. The repo uses eleven spellings; all of them
 * must match, because a declaration this misses silently reassigns its t()
 * calls to the PREVIOUS component and the gap goes unreported.
 *
 *   function X                       const X =
 *   export function X                export const X =
 *   export default function X        const X = memo(function X
 *   export const X = memo(function X export const X = React.memo(function X
 *   export const X = forwardRef(function X                const X = forwardRef(function X
 *   const X = React.memo(function X
 */
const DECL = /^(?:export\s+)?(?:default\s+)?(?:const\s+([A-Z][A-Za-z0-9_]*)\s*=|(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*))/;

function declarations(src) {
  const d = [];
  src.split('\n').forEach((l, i) => {
    const m = DECL.exec(l);
    if (m) d.push({ line: i + 1, name: m[1] || m[2] });
  });
  return d;
}

function hookGaps(src) {
  const lines = src.split('\n');
  const decls = declarations(src);
  const owner = (n) => [...decls].reverse().find(d => d.line <= n)?.name ?? '<module>';
  const uses = new Set();
  const hooked = new Set();
  lines.forEach((l, i) => {
    if (/(?<![A-Za-z0-9_.])t\(\s*['"`]/.test(l)) uses.add(owner(i + 1));
    if (/\bconst\s+t\s*=\s*useT\(\)/.test(l)) hooked.add(owner(i + 1));
  });
  return [...uses].filter(n => !hooked.has(n));
}

const [mode, ...args] = process.argv.slice(2);
const files = args.length ? args
  : execSync("find src -name '*.jsx' -not -path '*__tests__*'", { encoding: 'utf8' }).trim().split('\n');

let bad = 0;
for (const f of files) {
  if (IGNORE_FILES.has(f)) continue;
  const src = readFileSync(f, 'utf8');
  const found = mode === 'hooks' ? hookGaps(src) : jsxStrings(src);
  if (found.length) {
    bad += found.length;
    console.log(`${f}  (${found.length})`);
    for (const x of found) console.log('   ', JSON.stringify(x));
  }
}
console.log(bad ? `\n${mode}: ${bad} finding(s)` : `${mode}: clean`);
process.exit(bad ? 1 : 0);
