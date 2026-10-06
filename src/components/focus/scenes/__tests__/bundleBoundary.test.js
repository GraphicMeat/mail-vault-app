// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { listSourceFiles } from '../../../../../scripts/lib/sourceFiles.mjs';

/**
 * three.js is about 750 KB. It must reach the app only as the lazy chunk a
 * focus lock loads, never on startup. A static import of three, or of the
 * engine or a scene, anywhere outside the scenes folder would pull it into
 * the main bundle with every test still green.
 */
const SCENES_DIR = 'src/components/focus/scenes/';
const FILES = listSourceFiles(['src'], ['.js', '.jsx'], { exclude: ['__tests__', '.test.'] });
// `import x from 'm'`, `import 'm'`, and the re-exports `export * from 'm'` / `export { x } from 'm'`.
const STATIC_IMPORT = /^\s*(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"\n]*?\s*from\s+)['"]([^'"]+)['"]/gm;

const staticImports = (file) => [...readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)].map(m => m[1]);

describe('the three.js bundle boundary', () => {
  it('imports three only inside the scenes folder', () => {
    const offenders = FILES
      .filter(f => !f.startsWith(SCENES_DIR))
      .filter(f => staticImports(f).some(s => s === 'three' || s.startsWith('three/')));
    expect(offenders).toEqual([]);
  });

  it('reaches the engine and the scenes from outside only through dynamic import()', () => {
    const offenders = FILES
      .filter(f => !f.startsWith(SCENES_DIR))
      .flatMap(f => staticImports(f)
        .filter(s => /scenes\/(world|view|countryside|sea|town)(\.js)?$/.test(s))
        .map(s => `${f}: ${s}`));
    expect(offenders).toEqual([]);
  });

  it('sees a re-export as an import too', () => {
    const re = new RegExp(STATIC_IMPORT.source, 'gm');
    const found = [..."export * from 'three';\nexport { Color } from 'three/src/math/Color.js';\nimport 'three';".matchAll(re)].map(m => m[1]);
    expect(found).toEqual(['three', 'three/src/math/Color.js', 'three']);
  });

  it('keeps the scene index free of static imports', () => {
    expect(staticImports(`${SCENES_DIR}index.js`)).toEqual([]);
  });
});
