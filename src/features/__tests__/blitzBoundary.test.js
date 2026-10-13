// The Blitz renderer is a removable module: only the app entry may import it,
// and the module itself must not be reached by relative paths from core. This
// test passes trivially once the module is deleted.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

// True when `text` imports the module in any form: `from '...'` (import and
// export-from), bare `import '...'`, `import('...')` and `require('...')`.
// The path must hold the segment `features/blitz` ending at `/` or the closing
// quote, so `features/blitzard` is not a match. Comments are blanked first so
// prose or commented-out code does not count. Block comments are only
// recognised after whitespace or at line start, and line comments likewise,
// so a glob like 'src/**/*.js' or a URL in a string never swallows real code.
export function importsBlitz(text) {
  const code = text
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  return /\b(?:from|import|require)\s*\(?\s*(['"`])[^'"`\n]*features\/blitz(?:\/[^'"`\n]*)?\1/.test(code);
}

describe('Blitz module boundary', () => {
  it('only the entry imports src/features/blitz', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(MODULE + sep) || ENTRIES.has(file) || file.includes(`${sep}__tests__${sep}`)) continue;
      if (importsBlitz(readFileSync(file, 'utf8'))) offenders.push(relative(SRC, file));
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
});
