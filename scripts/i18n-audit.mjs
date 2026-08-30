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

// Deny-list, not allow-list: a JSX text node is whatever sits between `>` and
// `<` that isn't itself markup or a JS expression. The old allow-list class
// hid every node with one character outside its set — "1×1" (U+00D7),
// "(when idle)", "…" — while reporting a single brand-name false positive for
// the whole app. `<>{}` are the non-negotiable markup/expression boundaries;
// `[]=`` and `\` are additional denies for a different false-positive this
// class change opens up: a `>`/`<` that is really a JS comparison operator or
// an arrow (`=>`), which then runs on to the NEXT real tag and swallows the
// JS between them as "text". Confirmed by grep against every .jsx in this
// repo: no real UI copy uses `[`, `]`, a bare `=`, a backtick or a backslash
// (HTML entities like `&rsquo;` and literal `&` DO appear in real copy, so
// `&` and `;` stay allowed — denying them would hide exactly what STEP 1 is
// meant to surface). It still can't tell a comparison `>`/`<` from a tag
// boundary on sight — `count > 0 && (<Foo/>)` opens a match on the operator,
// same as a real tag would — so the IGNORE step below carries that one
// specific, extremely common React idiom; anything odder-shaped than that
// is left as noise a human skims past, same tradeoff the `hooks` mode makes.
// literalRanges/inLiteral still exempts string-literal content.
const TEXT = /(>)(\s*)([^<>{}[\]=`\\]*?)(\s*)(<)/g;
const PROP = /\b(?:title|aria-label|placeholder|alt)="([A-Za-z][^"]{1,})"/g;

// JSX text that is markup or code, not prose for a human.
//   - `\d+$`            a bare number: never worth a translator's time.
//   - `[^A-Za-z0-9]*$`  a run with no letter or digit at all — "(", ":",
//                       ") : (", a lone "•" or "⚠". This is the other shape
//                       `=>`/`?`/`:` leave behind: an arrow's `>`, or a
//                       ternary's own `) : (` between its two JSX branches,
//                       opens a match on a non-tag `>`/`<` that runs to the
//                       next real tag, but the JS syntax it swallows has no
//                       alphanumeric in it. A real string always has one.
//   - `&&`/`||` + `(`   the `cond && (<Tag/>)` conditional-render idiom —
//                       same false-match cause, one digit short of the rule
//                       above (`"0 && ("` has a "0" in it).
//   - `) : (`           the same ternary boundary, unanchored, for when a
//                       `/* comment */` sits right after it on the false
//                       branch — the comment's own words give the run an
//                       alnum, so the rule above doesn't fire, but ") : ("
//                       is still in there and no prose sentence contains it.
//   - `\breturn\s*\(?$` a store-selector line (`useX(s => s.y)`) or an early
//                       `if (…) return <Icon/>;` opens a match on its own
//                       `>` (an arrow, or a self-closing tag swallowed by the
//                       next rule down) that runs to the component's next
//                       `return` — same false-match cause, longer run. Always
//                       lowercase and lands at the very end, so it can't
//                       collide with a real "Return" button label.
//   - `\d+\s*\?\s*\(?$` the `cond ? (<Tag/>) : (<Tag/>)` idiom's OTHER
//                       opening, `? (` instead of `) : (` — same shape as the
//                       `&&`/`||` rule, one operator over.
//   - `^\).*\?\(?$`     a CHAINED ternary's middle branch: `a ? (<A/>) : b ?
//                       (<B/>) : (<C/>)`. No real sentence starts with a bare
//                       ")" immediately followed by ":", so anchoring on that
//                       is enough regardless of what the condition expression
//                       between the ":" and the "?" looks like.
// None of these are TEXT character-class denies, because none of them are a
// character prose can never use — `(`, `:`, digits and `&`/`|` all appear in
// real copy. They're only code here as a *shape*, which is what IGNORE is for.
const IGNORE = /^(https?|www\.|[A-Za-z]+\(|\d+$|[^A-Za-z0-9]*$)|(?:&&|\|\|)\s*\(|\)\s*:\s*\(|\breturn\s*\(?$|\d+\s*\?\s*\(?$|^\)[\s\S]*\?\s*\(?$/;

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

function jsxStrings(src) {
  const ranges = literalRanges(src);
  const inLiteral = (i) => ranges.some(([a, b]) => i >= a && i < b);
  const out = [];
  for (const m of src.matchAll(TEXT)) {
    const v = m[3].trim();
    if (v && !IGNORE.test(v) && !inLiteral(m.index)) out.push(v);
  }
  for (const m of src.matchAll(PROP)) if (!inLiteral(m.index)) out.push(m[1]);
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
    for (const x of found) console.log('   ', JSON.stringify(x));
  }
}
console.log(bad ? `\n${mode}: ${bad} finding(s)` : `${mode}: clean`);
process.exit(bad ? 1 : 0);
