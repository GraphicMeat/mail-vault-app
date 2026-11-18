// A stylesheet's source with its local `@import './x.css'` lines inlined, in order: what the
// bundle builds from it. index.css is a list of such imports, so a test reading its rules reads
// them through here.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readStyleSheet(file) {
  const path = file instanceof URL ? fileURLToPath(file) : String(file);
  return readFileSync(path, 'utf8').replace(/@import\s+'(\.\/[^']+\.css)';/g,
    (_, rel) => readStyleSheet(resolve(dirname(path), rel)));
}
