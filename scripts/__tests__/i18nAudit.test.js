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
