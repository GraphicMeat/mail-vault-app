#!/usr/bin/env node
/**
 * The gate for the string extraction.
 *
 * 2026-08-30: the text class had no `\n`, so a JSX text node that WRAPPED
 * across lines was invisible to it — the whole-file `\s*` only ever covered
 * whitespace around the node, never inside it. ExportUpsellModal's intro
 * paragraph sat hardcoded through the entire drain that way. Two checks, both mechanical, because the
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

/**
 * 2026-08-30, second pass: the class was an ALLOW-list of characters, so every
 * string carrying one it did not name was invisible — an ellipsis ("Loading
 * message…"), a slash ("Verifying IMAP/SMTP…"), parentheses ("Every hour (when
 * idle)"), an entity ("Can&rsquo;t reach the server"), a quote. Eight live
 * strings hid behind that list while the gate reported clean. It is now a
 * DENY-list: any run of text between a tag and the next `<` or `{`, minus the
 * shapes IGNORE names as code. A node that ends at `{` is text too —
 * "System Default ({navigator.language})" never reached a `<` at all.
 */
const TEXT = /(?<![=!\-|&+*/])([>}])(\s*)([A-Za-z0-9][^<>{};=]*?)(\s*)([<{])/g;
const PROP = /\b(?:title|aria-label|placeholder|alt)="([A-Za-z][^"]{1,})"/g;

/**
 * A capitalized literal in a ternary that a JSX expression renders — the shape
 * of `{x ? 'You' : getSenderName(e)}`. LITERAL below excludes every quoted
 * string on purpose; this narrow re-admission is the one that is safely
 * extractable, because the literal IS the whole rendered value. The leading
 * `{` is what keeps it off `const mbox = a === 'UNIFIED' ? 'INBOX' : a` and
 * off a console.log argument — neither is rendered.
 */
const TERNARY = /\{[^{}\n]*\?\s*'([A-Z][A-Za-z0-9 ,.!?%\-—’]*)'\s*:/g;

// JSX text that is markup or code, not prose for a human. The deny-list class
// above lets far more through, so this carries the weight the class used to:
// a JS keyword, an operator, a call, a numeric comparison. It ends with the
// proper nouns that are the same word in all nine languages — the alternative
// is nine catalog entries reading "IMAP".
//
// Deliberately NOT here: a bare one-word node. `^\w+$` would be a tempting
// filter, and it silently swallowed "emails", "folders", "selected" and 35
// other real fragments that sit after a `{count}` — the audit's own fixture
// (`<span>up</span>`) is the guard against re-adding it.
const IGNORE = /^(https?|www\.|[A-Za-z][\w.]*\(|\d+$)|&&|\|\||\?\.|^[A-Za-z_$][\w$.]*[)\]]|^(?:else|return|try|catch|finally|do|while|if|for|const|let|var|export|function|class|static|await|switch|case|new|typeof|async|import)\b|^\d+\s*[?)\]},]|^(?:Google|Microsoft|Yahoo|MailVault|IMAP|SMTP|OAuth2)$/;

// `T.jsx` documents the `<0>…</0>` slot syntax in its own comments and JSDoc,
// which reads as a text node to the pattern above. Excluding the file is
// honest; loosening the pattern to accommodate it would blind the audit
// everywhere else.
const IGNORE_FILES = new Set(['src/i18n/T.jsx']);

/**
 * HTML held in a JS string literal — `'<p>Text</p>'` in an array, a template
 * literal building an email body — is byte-identical to a JSX text node. It is
 * NOT extractable the same way: injecting `{t(…)}` there either breaks the
 * quoting or, worse, compiles fine and renders `{t('compose.x')}` as visible
 * text in a sent email. That actually happened once here and survived both a
 * green build and 1796 passing tests.
 *
 * The extractor refuses to edit inside a literal, so the audit must refuse to
 * report inside one — otherwise the drain check can never reach clean. Strings
 * in literals are localized by hand with `${t(…)}` in a template literal.
 */
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

function literalRanges(src) {
  return [...src.matchAll(LITERAL)].map(m => [m.index, m.index + m[0].length]);
}

/**
 * Comments, blanked in place so every index still lines up. A JSDoc block that
 * names a component reads as a text node to a pattern that only knows the
 * angle brackets around it, and the widened
 * class above admits far more of them than the old one did. The prose in a
 * comment is not shipped, so it is not a finding.
 */
function stripComments(src, ranges) {
  const inLit = (i) => ranges.some(([a, b]) => i >= a && i < b);
  let out = src.split('');
  for (let i = 0; i < src.length - 1; i++) {
    if (src[i] !== '/' || inLit(i)) continue;
    if (src[i + 1] === '/') {
      for (let j = i; j < src.length && src[j] !== '\n'; j++) out[j] = ' ';
    } else if (src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let j = i; j < stop; j++) if (src[j] !== '\n') out[j] = ' ';
      i = stop;
    }
  }
  return out.join('');
}

function jsxStrings(rawSrc) {
  const ranges = literalRanges(rawSrc);
  const src = stripComments(rawSrc, ranges);
  // The line number is what makes a finding actionable — the value alone can
  // appear four times in one file.
  const lineAt = (i) => rawSrc.slice(0, i).split('\n').length;
  const inLiteral = (i) => ranges.some(([a, b]) => i >= a && i < b);
  const out = [];
  for (const m of src.matchAll(TEXT)) {
    const v = m[3].trim();
    if (v && !IGNORE.test(v) && !inLiteral(m.index)) out.push({ line: lineAt(m.index), v });
  }
  for (const m of src.matchAll(PROP)) if (!inLiteral(m.index)) out.push({ line: lineAt(m.index), v: m[1] });
  for (const m of src.matchAll(TERNARY)) if (!IGNORE.test(m[1])) out.push({ line: lineAt(m.index), v: m[1] });
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
// Lowercase helpers are declarations too. Omitting them blames their t() calls
// on whatever Capitalized thing was declared above, which is how a real gap can
// read as clean — and how a helper can be told it needs a hook it cannot hold.
const DECL = /^(?:export\s+)?(?:default\s+)?(?:class\s+([A-Z][A-Za-z0-9_]*)|const\s+([A-Za-z_$][\w$]*)\s*=|(?:async\s+)?function\s+([A-Za-z_$][\w$]*))/;

function declarations(src) {
  const d = [];
  src.split('\n').forEach((l, i) => {
    const m = DECL.exec(l);
    if (!m) return;
    // `const LABEL = 'x'` is data, not a component. Only a declaration that is
    // actually a function can be one — and only a function can hold a hook.
    const isFn = !!m[3] || /=>|\bfunction\b/.test(l);
    d.push({ line: i + 1, name: m[1] || m[2] || m[3], isClass: !!m[1], isFn });
  });
  return d;
}

function hookGaps(src) {
  const lines = src.split('\n');
  const decls = declarations(src);
  const find = (n) => [...decls].reverse().find(d => d.line <= n);
  const owner = (n) => find(n)?.name ?? '<module>';
  // A class component cannot call a hook. It uses the module-level `t` instead,
  // which works because the active catalog is module state — it just will not
  // re-render on a locale change.
  const importsT = /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"][^'"]*i18n/.test(src);
  const isClassAt = (n) => !!find(n)?.isClass;
  // A plain helper (lowercase name) or a module-scope call cannot hold a hook.
  // Both are satisfied by the module-level `t` import, which works because the
  // active catalog is module state. Only a CAPITALIZED component needs useT(),
  // because only a component re-renders — and the subscription is the point.
  const needsHook = (n) => {
    const d = find(n);
    if (!d) return !importsT;              // module scope: the import is enough
    if (d.isClass) return !importsT;       // a class cannot call a hook
    // React's own rule: only a Capitalized name is a component. A lowercase
    // helper is an ordinary function and may not call a hook at all.
    if (!d.isFn || !/^[A-Z]/.test(d.name)) return !importsT;
    return true;                           // a component: needs the subscription
  };
  const uses = new Set();
  const hooked = new Set();
  lines.forEach((l, i) => {
    if (/(?<![A-Za-z0-9_.])t\(\s*['"`]/.test(l) && needsHook(i + 1)) uses.add(owner(i + 1));
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
    for (const x of found) console.log('   ', x.line ? `${x.line}` : '', JSON.stringify(x.v ?? x));
  }
}
console.log(bad ? `\n${mode}: ${bad} finding(s)` : `${mode}: clean`);
process.exit(bad ? 1 : 0);
