// Static proof of what the mobile bundle can reach. Bundles an entry with esbuild (a vite
// dependency), then reads every reachable source file for the RPC methods it names
// (`daemonCall('x')`) and the Tauri commands it invokes (`invoke('x')`, `core.invoke('x')`,
// `core?.invoke('x')`) and the engine events it subscribes to (`listen('x', ...)`). An alias of
// any of the three (`const f = daemonCall`, `import { listen as on }`) is reported as a dynamic
// call: the scan could not follow it. Dynamically imported modules are in the metafile too, so a lazy
// `import('../stores/settingsStore')` counts as reachable.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const STRING_ARG = String.raw`\s*(?:(['"])([^'"\n]*)\1|\x60([^\x60$\n]*)\x60)\s*[,)]`;
const CALL = (name) => new RegExp(String.raw`(?<![\w$])${name}\s*\(`, 'g');
const LITERAL = new RegExp('^' + STRING_ARG);

// Crude comment stripper: block comments, and `//` that does not follow `:` or a quote (URLs).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\x60\w])\/\/.*$/gm, '$1');
}

function scan(src, name, hits, dynamic, where) {
  const re = CALL(name);
  let m;
  while ((m = re.exec(src))) {
    // `function daemonCall(method, ...)` / `async function daemonCall(`: a definition, not a call.
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    const rest = src.slice(m.index + m[0].length);
    const lit = LITERAL.exec(rest);
    if (lit) hits.add(lit[2] ?? lit[3]);
    else dynamic.add(`${where}: ${name}(${rest.slice(0, 40).split('\n')[0]}`);
  }
}

const ALIAS_NAMES = ['daemonCall', 'invoke', 'listen'];
const ALIASES = ALIAS_NAMES.flatMap((name) => [
  new RegExp(String.raw`=\s*${name}\s*(?![\w$(.?])`, 'g'),
  new RegExp(String.raw`(?<![\w$])${name}\s+as\s+[\w$]+`, 'g'),
]);

function scanAliases(src, dynamic, where) {
  for (const re of ALIASES) {
    let m;
    while ((m = re.exec(src))) dynamic.add(`${where}: alias ${m[0].trim()}`);
  }
}

export async function analyzeSeam(entry) {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent',
    loader: {
      '.jsx': 'jsx', '.js': 'jsx', '.css': 'empty',
      '.svg': 'file', '.png': 'file', '.jpg': 'file', '.webp': 'file', '.gif': 'file',
      '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.mp3': 'file', '.wav': 'file',
    },
    jsx: 'automatic',
    outdir: 'out',
  });
  const modules = Object.keys(result.metafile.inputs).sort();
  const rpc = new Set();
  const inv = new Set();
  const lis = new Set();
  const dynamic = new Set();
  for (const mod of modules) {
    if (mod.includes('node_modules/')) continue;
    let src;
    try { src = stripComments(readFileSync(path.join(ROOT, mod), 'utf8')); } catch { continue; }
    scan(src, 'daemonCall', rpc, dynamic, mod);
    scan(src, 'invoke', inv, dynamic, mod);
    scan(src, 'listen', lis, dynamic, mod);
    scanAliases(src, dynamic, mod);
  }
  return {
    modules,
    rpcMethods: [...rpc].sort(),
    invokes: [...inv].sort(),
    listens: [...lis].sort(),
    dynamicCalls: [...dynamic].sort(),
  };
}
