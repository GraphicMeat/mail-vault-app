// The Blitz renderer is a removable module: only the app entry may import it,
// and the module itself must not be reached by relative paths from core. This
// test passes trivially once the module is deleted.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

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

// True when `text` reaches the module in any form: `from '...'` (import and
// export-from), bare `import '...'`, `import('...')`, `require('...')`,
// `import.meta.glob(...)` / `globEager` (any quoted pattern in the call) and
// `new URL('...', import.meta.url)`.
// A specifier counts when it holds the segment `features/blitz` ending at `/`
// or the end (so `features/blitzard` is not a match), or, given the importing
// file's directory `dir`, when a relative specifier resolves into the module
// (`../blitz` from src/features/other, `./blitz` from src/features).
// Comments are blanked first, including a block comment right after `(`, so
// prose or commented-out code does not count and `import(/* @vite-ignore */ 'x')`
// is still seen. Block and line comments are only recognised after whitespace,
// `(`, `,` or at line start, so a glob like 'src/**/*.js' or a URL in a string
// never swallows real code.
export function importsBlitz(text, dir) {
  const code = text
    .replace(/(^|[\s(,])\/\*[\s\S]*?\*\//g, '$1')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  const specs = [];
  const quoted = (chunk) => { for (const m of chunk.matchAll(/(['"`])([^'"`\n]*)\1/g)) specs.push(m[2]); };
  for (const m of code.matchAll(/\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`\n]*)\1/g)) specs.push(m[2]);
  for (const m of code.matchAll(/\bimport\.meta\.glob(?:Eager)?\s*\(([^)]*)\)/g)) quoted(m[1]);
  for (const m of code.matchAll(/\bnew\s+URL\s*\(\s*(['"`])([^'"`\n]*)\1/g)) specs.push(m[2]);
  return specs.some((spec) => {
    if (/(?:^|\/)features\/blitz(?:\/|$)/.test(spec)) return true;
    if (dir && spec.startsWith('.')) {
      const target = resolve(dir, spec);
      return target === MODULE || target.startsWith(MODULE + sep);
    }
    return false;
  });
}

describe('Blitz module boundary', () => {
  it('only the entry imports src/features/blitz', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(MODULE + sep) || ENTRIES.has(file) || file.includes(`${sep}__tests__${sep}`)) continue;
      if (importsBlitz(readFileSync(file, 'utf8'), dirname(file))) offenders.push(relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  it('importsBlitz sees every import form and ignores look-alikes and prose', () => {
    const yes = [
      "import { a } from '../features/blitz';",
      "import x from \"../../features/blitz/service\";",
      "export { a } from '../features/blitz/index.js';",
      "export * from '../features/blitz';",
      "import '../features/blitz/service';",
      "import\"../features/blitz/service\";",
      "const m = await import('../features/blitz/render');",
      "const m = import(`../features/blitz`);",
      "const m = require('../features/blitz/x');",
      "const m = require(\"../features/blitz\");",
      "import {\n  a,\n  b\n} from '../../features/blitz';",
      "/* old */\nimport '../features/blitz/service';",
    ];
    for (const sample of yes) expect(importsBlitz(sample), sample).toBe(true);
    const no = [
      "import x from '../features/blitzard';",
      "import x from '../features/blitzy/y';",
      "import '../features/other/blitz';",
      "// features/blitz is removable",
      "// import '../features/blitz/service';",
      "  // import x from '../features/blitz';",
      "/* import '../features/blitz/service'; */",
      "/*\n * import x from '../features/blitz';\n */",
      "const note = 'features/blitz is removable';",
      "const g = 'src/**/*.js'; import x from './y';",
    ];
    for (const sample of no) expect(importsBlitz(sample), sample).toBe(false);
  });

  it('sees the forms a plain `from` scan misses: globs, `new URL`, comments after `(`, and siblings', () => {
    const FEATURES = join(SRC, 'features');
    const yes = [
      ["const m = import(/* @vite-ignore */ '../features/blitz');", join(SRC, 'components')],
      ["const m = import(/* a */ /* b */ '../features/blitz/x');", join(SRC, 'components')],
      ["const m = import(\n  /* @vite-ignore */\n  '../features/blitz'\n);", join(SRC, 'utils')],
      ["const all = import.meta.glob('../features/blitz/**/*.jsx');", join(SRC, 'components')],
      ["const all = import.meta.glob(['../a/*.js', '../features/blitz/*.jsx'], { eager: true });", join(SRC, 'components')],
      ["const all = import.meta.globEager('../features/blitz/*.js');", join(SRC, 'components')],
      ["const u = new URL('../features/blitz/worker.js', import.meta.url);", join(SRC, 'components')],
      ["import x from '../blitz';", join(FEATURES, 'other')],
      ["import x from './blitz';", FEATURES],
      ["export { x } from './blitz/index.js';", FEATURES],
      ["const m = await import('../blitz/BlitzBody');", join(FEATURES, 'other')],
      ["const all = import.meta.glob('../blitz/**');", join(FEATURES, 'other')],
      ["const u = new URL('./blitz/w.js', import.meta.url);", FEATURES],
      ["import x from '../../features/blitz';", join(FEATURES, 'other', 'deep')],
    ];
    for (const [sample, dir] of yes) expect(importsBlitz(sample, dir), sample).toBe(true);
    const no = [
      ["import x from '../blitzard';", join(FEATURES, 'other')],
      ["import x from './blitzard';", FEATURES],
      ["import x from '../blitz';", join(SRC, 'components')],   // src/blitz, not the module
      ["import x from './blitz';", join(FEATURES, 'other')],     // features/other/blitz
      ["const all = import.meta.glob('./other/**/*.jsx');", FEATURES],
      ["const all = import.meta.glob(['./a/*.js', '../b/*.js']);", join(SRC, 'components')],
      ["const u = new URL('./icon.png', import.meta.url);", join(SRC, 'components')],
      ["const m = import(/* @vite-ignore */ './other');", FEATURES],
      ["// const all = import.meta.glob('../features/blitz/**');", join(SRC, 'components')],
      ["/* import x from '../blitz'; */", FEATURES],
    ];
    for (const [sample, dir] of no) expect(importsBlitz(sample, dir), sample).toBe(false);
  });
});
