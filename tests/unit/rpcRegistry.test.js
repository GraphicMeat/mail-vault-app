/**
 * The frontend's list of daemon RPC methods is generated from the daemon's
 * own table (`src-daemon/methods.json`, kept equal to
 * `src-daemon/src/rpc_registry.rs` by a Rust test). These tests keep the
 * generated file current and keep `transport.js` from naming a method the
 * daemon does not answer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { RPC_METHODS } from '../../src/services/rpcMethods.generated.js';
import { DAEMON_OWNED } from '../../src/services/transport.js';

const read = (p) => readFileSync(p, 'utf8');
const daemonMethods = JSON.parse(read('src-daemon/methods.json')).map((r) => r.name);

/**
 * Names in `DAEMON_OWNED` or a `DAEMON_COMMANDS` target that are Tauri shell
 * commands rather than daemon methods, so the daemon has no row for them.
 * Empty today: every name there is a daemon method. Add a name here, with the
 * reason, instead of deleting it from `transport.js`.
 */
const KNOWN_NOT_IN_DAEMON = [];

/** Targets of the `DAEMON_COMMANDS` object (legacy command name -> dotted daemon method). */
function daemonCommandTargets() {
  const src = read('src/services/transport.js');
  const body = src.match(/const DAEMON_COMMANDS = \{([\s\S]*?)\n\};/)?.[1];
  if (!body) throw new Error('DAEMON_COMMANDS not found in transport.js');
  const code = body.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return [...code.matchAll(/'[^']+':\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('generated RPC method list', () => {
  it('equals src-daemon/methods.json (run node scripts/gen-rpc-methods.mjs after changing it)', () => {
    expect([...RPC_METHODS]).toEqual(daemonMethods);
  });

  it('is sorted, without duplicates, and frozen', () => {
    const sorted = [...RPC_METHODS].sort();
    expect([...RPC_METHODS]).toEqual(sorted);
    expect(new Set(RPC_METHODS).size).toBe(RPC_METHODS.length);
    expect(Object.isFrozen(RPC_METHODS)).toBe(true);
  });
});

describe('transport.js names against the daemon table', () => {
  const known = new Set(RPC_METHODS);

  it('every DAEMON_OWNED name is a daemon method', () => {
    const missing = [...DAEMON_OWNED].filter((n) => !known.has(n) && !KNOWN_NOT_IN_DAEMON.includes(n));
    expect(missing).toEqual([]);
  });

  it('every DAEMON_COMMANDS target is a daemon method', () => {
    const targets = daemonCommandTargets();
    expect(targets.length).toBeGreaterThan(0);
    const missing = targets.filter((n) => !known.has(n) && !KNOWN_NOT_IN_DAEMON.includes(n));
    expect(missing).toEqual([]);
  });

  it('KNOWN_NOT_IN_DAEMON lists only names transport.js still has and the daemon still lacks', () => {
    const named = new Set([...DAEMON_OWNED, ...daemonCommandTargets()]);
    for (const n of KNOWN_NOT_IN_DAEMON) {
      expect(named.has(n), `${n} is no longer in transport.js`).toBe(true);
      expect(known.has(n), `${n} is a daemon method now`).toBe(false);
    }
  });
});

/**
 * `daemon_rpc` (src-tauri/src/rpc_proxy.rs) reports "no daemon" and "daemon
 * too old for this method" as two catalog keys, and the frontend tells them
 * apart by exact text. Both sides are read here, so renaming one fails.
 */
describe('the shell error keys the frontend matches by text', () => {
  const proxy = read('src-tauri/src/rpc_proxy.rs');
  const shellKey = (name) => proxy.match(new RegExp(String.raw`const ${name}: &str = "([^"]+)";`))?.[1];
  const keys = { unavailable: shellKey('DAEMON_UNAVAILABLE'), outdated: shellKey('DAEMON_OUTDATED') };
  const catalog = JSON.parse(read('src/i18n/locales/en.json'));

  it('are catalog keys', () => {
    expect(keys).toEqual({ unavailable: 'errors.daemonUnavailable', outdated: 'errors.daemonOutdated' });
    for (const key of Object.values(keys)) expect(typeof catalog[key], key).toBe('string');
  });

  it('are the strings transport.js and safeStorage.js compare against', () => {
    const transport = read('src/services/transport.js');
    expect(transport).toContain(`e?.message === '${keys.outdated}'`);
    expect(transport).toContain(`e?.message === '${keys.unavailable}'`);
    const safeStorage = read('src/stores/safeStorage.js');
    expect(safeStorage).toContain(`const UNAVAILABLE = '${keys.unavailable}';`);
    expect(safeStorage).toContain(`const OUTDATED = '${keys.outdated}';`);
  });

  it('the shell spells them only through its two consts', () => {
    const files = readdirSync('src-tauri/src').filter((f) => f.endsWith('.rs') && f !== 'tests.rs' && f !== 'rpc_proxy.rs');
    const literal = files.filter((f) => {
      const src = read(`src-tauri/src/${f}`);
      const tests = src.search(/\n#\[cfg\(test\)\]\s*\n\s*(?:mod \w+\s*\{|#\[test\])/);
      const code = tests < 0 ? src : src.slice(0, tests);
      return code.includes(`"${keys.unavailable}"`) || code.includes(`"${keys.outdated}"`);
    });
    expect(literal).toEqual([]);
  });
});
