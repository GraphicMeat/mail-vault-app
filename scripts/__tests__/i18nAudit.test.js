import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const AUDIT = resolve(process.cwd(), 'scripts/i18n-audit.mjs');

function run(mode, file) {
  try { execFileSync('node', [AUDIT, mode, file], { encoding: 'utf8' }); return ''; }
  catch (e) { return e.stdout || String(e); }
}

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  const f = join(dir, 'F.jsx');
  writeFileSync(f, body);
  return f;
}

/**
 * The gate needs its own gate. `export default function X()` was missing from
 * the declaration pattern, which silently attributed that component's t() calls
 * to whatever was declared above it — so a real hook gap read as clean.
 */
const FORMS = {
  'function X': 'function X() {',
  'export function X': 'export function X() {',
  'export default function X': 'export default function X() {',
  'const X =': 'const X = () => {',
  'export const X =': 'export const X = () => {',
  'const X = memo(function X': 'const X = memo(function X() {',
  'export const X = memo(function X': 'export const X = memo(function X() {',
  'export const X = React.memo(function X': 'export const X = React.memo(function X() {',
  'export const X = forwardRef(function X': 'export const X = forwardRef(function X() {',
};

describe('i18n-audit hooks mode', () => {
  for (const [label, decl] of Object.entries(FORMS)) {
    it(`reports a missing useT in: ${label}`, () => {
      const f = fixture(`${decl}\n  return <span>{t('a.b')}</span>;\n}\n`);
      expect(run('hooks', f)).toMatch(/1 finding/);
    });

    it(`stays clean when that form has the hook: ${label}`, () => {
      const f = fixture(`${decl}\n  const t = useT();\n  return <span>{t('a.b')}</span>;\n}\n`);
      expect(run('hooks', f)).toBe('');
    });
  }
});

describe('i18n-audit strings mode', () => {
  it('finds a multi-line text node, which no line-based grep can see', () => {
    const f = fixture('function X() {\n  return (\n    <p>\n      Hello there\n    </p>\n  );\n}\n');
    expect(run('strings', f)).toMatch(/Hello there/);
  });

  it('finds a two-character text node', () => {
    const f = fixture('function X() {\n  return <span>up</span>;\n}\n');
    expect(run('strings', f)).toMatch(/"up"/);
  });

  it('is clean once every string is a t() call', () => {
    const f = fixture("function X() {\n  return <span title={t('a.b')}>{t('c.d')}</span>;\n}\n");
    expect(run('strings', f)).toBe('');
  });
});

/**
 * 2026-10-08: three text shapes the pattern could not see, 18 live strings
 * hid behind them (see audit-baseline.json's _comment), and a fourth shape,
 * a `label:` literal in a data array a component maps over, never was a JSX
 * text node at all (BulkOperationsModal's `{ type: 'all', label: 'All' }`).
 */
describe('i18n-audit strings mode, shapes that used to hide', () => {
  it('finds text after a self-closing tag', () => {
    const f = fixture('function X({ n }) {\n  return <button><Trash2 size={13} /> Delete ({n})</button>;\n}\n');
    expect(run('strings', f)).toMatch(/Delete \(/);
  });

  it('finds text after a self-closing tag on the next line', () => {
    const f = fixture('function X() {\n  return (\n    <button>\n      <Icon />\n      Save draft\n    </button>\n  );\n}\n');
    expect(run('strings', f)).toMatch(/Save draft/);
  });

  it('finds text that starts with punctuation', () => {
    const f = fixture('function X({ name }) {\n  return <p>{name} — wrote this</p>;\n}\n');
    expect(run('strings', f)).toMatch(/wrote this/);
  });

  it('finds a parenthesised suffix after a closing tag', () => {
    const f = fixture('function X() {\n  return <label><b>{t(\'a.b\')}</b> (optional)</label>;\n}\n');
    expect(run('strings', f)).toMatch(/\(optional\)/);
  });

  it('finds text holding an HTML entity', () => {
    const f = fixture('function X() {\n  return <p>Can&rsquo;t reach the server</p>;\n}\n');
    expect(run('strings', f)).toMatch(/Can&rsquo;t reach the server/);
  });

  it('finds text that starts with an entity', () => {
    const f = fixture('function X() {\n  return <p>&mdash; Not available</p>;\n}\n');
    expect(run('strings', f)).toMatch(/Not available/);
  });

  it('leaves entity-only glyphs alone', () => {
    const f = fixture('function X() {\n  return <span>&nbsp;</span>;\n}\n');
    expect(run('strings', f)).toBe('');
  });

  it('leaves punctuation-only separators between JSX branches alone', () => {
    const f = fixture('function X({ a }) {\n  return (\n    <div>\n      {a ? (\n        <A />\n      ) : (\n        <B />\n      )}\n    </div>\n  );\n}\n');
    expect(run('strings', f)).toBe('');
  });

  it('finds prose that holds a semicolon', () => {
    const f = fixture('function X() {\n  return <p>Works offline; no account required</p>;\n}\n');
    expect(run('strings', f)).toMatch(/no account required/);
  });

  it('does not read a statement after a semicolon as prose', () => {
    const f = fixture('function X({ a }) {\n  const y = a ? 1 : 2;\n  setPosition(y);\n  return <div>{y}</div>;\n}\n');
    expect(run('strings', f)).toBe('');
  });

  it('finds a label: literal in a data array', () => {
    const f = fixture("const PRESETS = [{ type: 'all', label: 'All' }];\nfunction X() {\n  return <ul>{PRESETS.map(p => <li key={p.type}>{p.label}</li>)}</ul>;\n}\n");
    expect(run('strings', f)).toMatch(/"All"/);
  });

  it('finds a double-quoted label: literal', () => {
    const f = fixture('const PRESETS = [{ type: "all", label: "Everything" }];\nfunction X() {\n  return <ul>{PRESETS.map(p => <li>{p.label}</li>)}</ul>;\n}\n');
    expect(run('strings', f)).toMatch(/Everything/);
  });

  it('is clean when the label is a t() call', () => {
    const f = fixture("function X() {\n  const t = useT();\n  const PRESETS = [{ type: 'all', label: t('a.all') }];\n  return <ul>{PRESETS.map(p => <li>{p.label}</li>)}</ul>;\n}\n");
    expect(run('strings', f)).toBe('');
  });
});

describe('i18n-audit and the extractor agree about string literals', () => {
  it('does not report HTML held in a single-quoted string', () => {
    const f = fixture("function X() {\n  const body = ['<p>Hello there</p>'].join('');\n  return <div>{body}</div>;\n}\n");
    expect(run('strings', f)).toBe('');
  });

  it('does not report HTML held in a template literal', () => {
    const f = fixture('function X() {\n  const h = `<p><strong>Original Message</strong></p>`;\n  return <div>{h}</div>;\n}\n');
    expect(run('strings', f)).toBe('');
  });

  it('still reports a real JSX text node in the same file as a literal', () => {
    const f = fixture("function X() {\n  const h = '<p>In a literal</p>';\n  return <div>Real text node</div>;\n}\n");
    const out = run('strings', f);
    expect(out).toMatch(/Real text node/);
    expect(out).not.toMatch(/In a literal/);
  });
});

/**
 * Literal extraction reaches plain helpers and module scope, neither of which
 * can hold a hook. Both are satisfied by the module-level `t` import — the
 * catalog is module state. Only a capitalized component needs useT(), because
 * only a component re-renders, and the subscription is the entire point.
 */
const IMPORT = "import { t } from '../i18n/index.js';\n";

describe('helpers versus components', () => {
  it('accepts a lowercase helper using the module-level t', () => {
    const f = fixture(IMPORT + "function describeThing() {\n  return t('a.b');\n}\n");
    expect(run('hooks', f)).toBe('');
  });

  it('accepts a module-scope call when t is imported', () => {
    const f = fixture(IMPORT + "const LABEL = t('a.b');\n");
    expect(run('hooks', f)).toBe('');
  });

  it('still demands useT in a capitalized component, import or not', () => {
    const f = fixture(IMPORT + "function Widget() {\n  return <span>{t('a.b')}</span>;\n}\n");
    expect(run('hooks', f)).toMatch(/Widget/);
  });

  it('does not blame a helper’s call on the component declared above it', () => {
    const f = fixture(IMPORT +
      "function Widget() {\n  const t = useT();\n  return <span>{t('a.b')}</span>;\n}\n" +
      "function helper() {\n  return t('c.d');\n}\n");
    expect(run('hooks', f)).toBe('');
  });
});
