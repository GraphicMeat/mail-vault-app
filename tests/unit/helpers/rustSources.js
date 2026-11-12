// Source-scan helpers for tests that read Rust files as text.
//
// `src-tauri/src/main.rs` was split: it keeps `main()`, the builder chain and
// `generate_handler!`; everything else lives in sibling modules. The daemon's
// `DaemonState` moved from `server.rs` to `state.rs`. Tests that assert on
// text anywhere in the shell or the daemon dispatch read through these.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// From the vitest root (the repo), not import.meta.url: that is not a file: URL
// in a jsdom test.
const root = (p) => path.resolve(process.cwd(), p);
const read = (p) => readFileSync(root(p), 'utf8');

// Modules split out of src-tauri/src/main.rs (tests.rs is the former inline
// `mod tests`, kept in so positive and negative scans cover what main.rs did).
export const SHELL_SPLIT_MODULES = [
  'tray', 'menu', 'logging', 'deep_links', 'client_info', 'settings', 'credentials',
  'os_integration', 'app_windows', 'vault_commands', 'updater', 'daemon_lifecycle',
  'rpc_proxy', 'startup', 'tests',
];

/** `src-tauri/src/main.rs` alone: `main()`, builder chain, `generate_handler!`, `mod` lines. */
export function shellMainSource() {
  return read('src-tauri/src/main.rs');
}

/** Everything main.rs held before the split: main.rs followed by each split module. */
export function shellSource() {
  return [shellMainSource(), ...SHELL_SPLIT_MODULES.map((m) => read(`src-tauri/src/${m}.rs`))].join('\n');
}

/** Daemon dispatch plus the state module (and the method registry once it exists). */
export function daemonServerSource() {
  const files = ['server.rs', 'state.rs', 'rpc_registry.rs'].filter((f) => existsSync(root(`src-daemon/src/${f}`)));
  return files.map((f) => read(`src-daemon/src/${f}`)).join('\n');
}

/** One split shell module by name, for assertions that slice a function body. */
export function shellModuleSource(name) {
  return read(`src-tauri/src/${name}.rs`);
}

/**
 * The daemon's method table (`METHODS` in `src-daemon/src/rpc_registry.rs`) as
 * data: `[{ name, domain, strict, foreground, needsMailDir }]`, one per `row(..)`.
 * Tests that used to slice a hand-written method list out of `server.rs` or
 * `search_index.rs` read the flags from here.
 */
export function registryRows() {
  const src = read('src-daemon/src/rpc_registry.rs');
  const start = src.indexOf('pub(crate) const METHODS: &[Method] = &[');
  const end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('METHODS table not found in rpc_registry.rs');
  const table = src.slice(start, end);
  const rows = [];
  for (const m of table.matchAll(/row\(\s*"([^"]+)"\s*,\s*Domain::(\w+)\s*,\s*[\w()]+\s*\)((?:\s*\.\w+\(\))*)/g)) {
    const flags = m[3];
    rows.push({
      name: m[1],
      domain: m[2],
      strict: flags.includes('.strict()'),
      foreground: flags.includes('.foreground()'),
      needsMailDir: flags.includes('.mail_dir()'),
    });
  }
  if (rows.length < 100) throw new Error(`registryRows parsed only ${rows.length} rows`);
  return rows;
}

/** One table row by method name, or undefined. */
export const registryRow = (name) => registryRows().find((r) => r.name === name);

/**
 * The app's reply budget for a daemon method, in seconds, as the shell reads
 * it (`reply_timeout` from `src-daemon/methods.json`): `null` for none,
 * `undefined` for a name the table does not list.
 */
export function replyBudget(name) {
  const row = JSON.parse(read('src-daemon/methods.json')).find((r) => r.name === name);
  return row ? row.replySecs : undefined;
}
