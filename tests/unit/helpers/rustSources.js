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
  for (const m of table.matchAll(/row\(\s*"([^"]+)"\s*,\s*Domain::(\w+)\s*,\s*[\w():]+\s*\)((?:\s*\.\w+\(\))*)/g)) {
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

const isIdent = (c) => /[\p{L}\p{N}_]/u.test(c || '');

// Lines of `src` with comments blanked and, per line, the `{` and `}` outside
// string, raw string and char literals: a "https://..." or a '{' is not a
// comment or a brace. Twin of `lex` in src-core/tests/support/rust_scan.rs.
function lexRust(src) {
  const s = [...src];
  const at = (i) => s[i] ?? '';
  const lines = [{ code: '', open: 0, close: 0 }];
  let block = 0;
  let string = null; // null outside; -1 a plain string; n a raw one closed by `"` and n `#`
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { lines.push({ code: '', open: 0, close: 0 }); i += 1; continue; }
    const line = lines[lines.length - 1];
    if (block > 0) {
      if (c === '*' && at(i + 1) === '/') { block -= 1; i += 2; }
      else if (c === '/' && at(i + 1) === '*') { block += 1; i += 2; }
      else i += 1;
      continue;
    }
    if (string !== null) {
      line.code += c;
      if (string === -1 && c === '\\' && at(i + 1) !== '\n') { line.code += at(i + 1); i += 2; continue; }
      if (string === -1 && c === '"') string = null;
      else if (string >= 0 && c === '"' && [...Array(string).keys()].every((k) => at(i + 1 + k) === '#')) {
        line.code += '#'.repeat(string); i += 1 + string; string = null; continue;
      }
      i += 1;
      continue;
    }
    if (c === '/' && at(i + 1) === '/') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (c === '/' && at(i + 1) === '*') { block = 1; i += 2; continue; }
    if (c === '"') { string = -1; line.code += c; i += 1; continue; }
    const startsToken = i === 0 || !isIdent(at(i - 1)) || (at(i - 1) === 'b' && (i === 1 || !isIdent(at(i - 2))));
    if (c === 'r' && startsToken) {
      let hashes = 0;
      while (at(i + 1 + hashes) === '#') hashes += 1;
      if (at(i + 1 + hashes) === '"') { line.code += s.slice(i, i + 2 + hashes).join(''); string = hashes; i += 2 + hashes; continue; }
    }
    if (c === "'") {
      let end = -1;
      if (at(i + 1) === '\\') { for (let j = i + 2; j < Math.min(i + 12, s.length); j += 1) if (s[j] === "'") { end = j; break; } }
      else if (at(i + 2) === "'") end = i + 2;
      if (end >= 0) { line.code += s.slice(i, end + 1).join(''); i = end + 1; continue; }
    }
    if (c === '{') line.open += 1;
    else if (c === '}') line.close += 1;
    line.code += c;
    i += 1;
  }
  return lines;
}

// What follows a `#[cfg(test)]` or `#[cfg(all(test, ..))]` attribute that
// opens `code`, or null.
function afterTestCfg(code) {
  const t = code.trimStart();
  if (t.startsWith('#[cfg(test)]')) return t.slice('#[cfg(test)]'.length);
  if (!t.startsWith('#[cfg(all(')) return null;
  const first = t.slice('#[cfg(all('.length).split(/[,)]/)[0].trim();
  if (first !== 'test') return null;
  const end = t.indexOf(']');
  return end < 0 ? '' : t.slice(end + 1);
}

/**
 * Rust source as shipped: every item a test cfg gates is dropped (a `mod x;`
 * line, a `mod x { .. }` on one line or many, a test fn, a `thread_local!`),
 * along with the attributes between the cfg and the item, and comments are
 * blanked. Dropped lines stay as empty lines, so a line number in the result
 * is one in the file. Code AFTER an early test item is kept: a scan that cut
 * the file at its first test module never saw it. Twin of `non_test_code` in
 * src-core/tests/support/rust_scan.rs.
 */
export function rustNonTestCode(src) {
  const out = [];
  let skipping = false;
  let depth = 0;
  let opened = false;
  for (const line of lexRust(src)) {
    let code = line.code;
    if (!skipping) {
      const rest = afterTestCfg(code);
      if (rest === null) { out.push(code); continue; }
      skipping = true; depth = 0; opened = false;
      code = rest;
    }
    out.push('');
    if (!opened) {
      // Further attributes on the item (`#[path = ".."]`, `#[test]`).
      code = code.replace(/^(\s*#\[[^\]]*\])+/, '');
      if (!code.trim() && line.open === 0) continue;
    }
    depth += line.open - line.close;
    if (line.open > 0) opened = true;
    if (opened ? depth <= 0 : code.trim().endsWith(';')) skipping = false;
  }
  return out.join('\n');
}
