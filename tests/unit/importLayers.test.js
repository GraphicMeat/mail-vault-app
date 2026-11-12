// Import layers of the frontend. Production files under src/ sit in layers; a
// file may import its own layer or a lower one. Importing UP the stack is what
// built the 14-file import cycle between the stores and the workflows, so:
//
//   a. a store never imports a workflow, statically or dynamically (no baseline);
//   b. every other upward edge is counted per layer pair and may only go down:
//      more than the baseline fails, fewer fails too ("lower the baseline"),
//      so the numbers below can only shrink.
//
// An "edge" is one importing file -> one imported file, however many import
// statements join them. Tests (*.test.*, __tests__/) are not production.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// SCANNER-BEGIN
const SRC = path.resolve(process.cwd(), 'src');

// Rank by top-level area under src/. Areas not listed (App, main, mobile, demo,
// styles, assets, test helpers) are entry points or non-code: never a source
// or a target of an edge.
const LAYERS = [
  { name: 'base', rank: 0, areas: ['utils', 'shared', 'config', 'data'] },
  { name: 'platform', rank: 1, areas: ['i18n', 'workers'] },
  { name: 'services', rank: 2, areas: ['services'] },
  { name: 'stores', rank: 3, areas: ['stores'] },
  { name: 'workflows', rank: 4, areas: ['services/workflows'] },
  { name: 'hooks', rank: 5, areas: ['hooks'] },
  { name: 'ui', rank: 6, areas: ['components', 'features'] },
];

function layerOf(rel) {
  // rel is a path under src/, forward slashes. Longest area prefix wins.
  let best = null;
  for (const layer of LAYERS) {
    for (const area of layer.areas) {
      if ((rel === area || rel.startsWith(`${area}/`)) && (!best || area.length > best.area.length)) best = { layer, area };
    }
  }
  return best?.layer ?? null;
}

const isTestFile = (rel) => /\.test\.[jt]sx?$/.test(rel) || rel.split('/').includes('__tests__');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const STATIC_RE = /(?:^|[\s;}])(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(source) {
  // Comment-only lines carry example code; code is never on them.
  const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const found = [];
  for (const re of [STATIC_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(code))) found.push(match[1]);
  }
  return found;
}

function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js'), path.join(base, 'index.jsx')]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  // An unresolvable specifier (asset, generated file) still lands in an area.
  return base;
}

/** Every production edge between ranked layers: [{ from, to, fromLayer, toLayer }]. */
function scanEdges() {
  const edges = new Map();
  for (const file of walk(SRC)) {
    const fromRel = path.relative(SRC, file).split(path.sep).join('/');
    if (isTestFile(fromRel)) continue;
    const fromLayer = layerOf(fromRel);
    if (!fromLayer) continue;
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      const target = resolveRelative(file, specifier);
      if (!target) continue;
      const toRel = path.relative(SRC, target).split(path.sep).join('/');
      if (toRel.startsWith('..') || isTestFile(toRel)) continue;
      const toLayer = layerOf(toRel);
      if (!toLayer || toRel === fromRel) continue;
      edges.set(`${fromRel} -> ${toRel}`, { from: fromRel, to: toRel, fromLayer, toLayer });
    }
  }
  return [...edges.values()];
}

/** Upward edges grouped by "from -> to" layer pair. */
function upwardPairs(edges) {
  const pairs = {};
  for (const edge of edges) {
    if (edge.fromLayer.rank >= edge.toLayer.rank) continue;
    const key = `${edge.fromLayer.name} -> ${edge.toLayer.name}`;
    (pairs[key] ??= []).push(`${edge.from} -> ${edge.to}`);
  }
  return pairs;
}
// SCANNER-END

// Upward edges that exist today, per layer pair. The numbers may only fall.
// stores -> workflows is not here: it is the hard rule below, zero.
const BASELINE = {
  'base -> platform': 23,
  'base -> services': 9,
  'base -> stores': 16,
  'base -> workflows': 1,
  'platform -> stores': 1,
  'services -> stores': 85,
  'services -> workflows': 11,
  'services -> ui': 2,
  'stores -> ui': 1,
};

describe('import layers', () => {
  const edges = scanEdges();

  it('scans a real tree: the layers it ranks all have production files', () => {
    for (const layer of LAYERS) {
      expect(edges.some((edge) => edge.fromLayer === layer || edge.toLayer === layer), layer.name).toBe(true);
    }
  });

  it('no store imports a workflow, statically or dynamically', () => {
    const offending = edges
      .filter((edge) => edge.fromLayer.name === 'stores' && edge.toLayer.name === 'workflows')
      .map((edge) => `${edge.from} -> ${edge.to}`);
    expect(offending, 'stores reach workflows through stores/workflowPorts.js or services/workflows/bindStoreActions.js').toEqual([]);
  });

  it('the other upward imports only ever shrink (ratchet)', () => {
    const pairs = upwardPairs(edges);
    delete pairs['stores -> workflows'];
    const problems = [];
    for (const key of new Set([...Object.keys(pairs), ...Object.keys(BASELINE)])) {
      const found = pairs[key] ?? [];
      const allowed = BASELINE[key] ?? 0;
      if (found.length > allowed) {
        problems.push(`${key}: ${found.length} upward imports, baseline ${allowed}. Edges of this pair:\n  ${found.join('\n  ')}`);
      } else if (found.length < allowed) {
        problems.push(`${key}: down to ${found.length} from ${allowed}. Lower the baseline to ${found.length}.`);
      }
    }
    expect(problems.join('\n')).toBe('');
  });
});
