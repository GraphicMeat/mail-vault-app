/**
 * Spec 2026-09-14 §5.4: the search index lives in the daemon. The app registers
 * none of its commands and holds no index module; CI never runs app-crate tests,
 * so this reads the sources.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const main = readFileSync('src-tauri/src/main.rs', 'utf8');
const handlerList = main.slice(main.indexOf('generate_handler!['), main.indexOf(']', main.indexOf('generate_handler![')));
const COMMANDS = ['search_index_configure', 'search_index_status', 'search_index_rebuild', 'search_index_destroy', 'vault_search', 'vault_rows'];

describe('the search index lives in the daemon', () => {
  it('reads a real handler list', () => {
    expect(handlerList).toContain('daemon_rpc');
  });

  it.each(COMMANDS)('the app does not register %s', (name) => {
    expect(handlerList).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it('no app source declares or calls an app-side search_index module', () => {
    const dir = 'src-tauri/src';
    const hits = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.rs'))) {
      readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (/\bmod search_index\b|crate::search_index|(?<!mailvault_core::)\bsearch_index::/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the app files that moved to the daemon are gone', () => {
    for (const f of ['src-tauri/src/search_index.rs', 'src-tauri/src/search_index_tests.rs', 'src-tauri/src/attachment_extract.rs']) {
      expect(existsSync(f)).toBe(false);
    }
  });

  // Task 1.7 fix round 1, review M2: the guard's own RED mutant (Drop doing
  // nothing) doesn't touch the spawn gate in ensure_daemon_socket — cover
  // that call site directly by source, since it's addendum D's whole point
  // (a vault-move-suspended daemon must never be spawned fresh).
  it('ensure_daemon_socket refuses to spawn while suspended, before it spawns', () => {
    const start = main.indexOf('fn ensure_daemon_socket(');
    expect(start).toBeGreaterThan(-1);
    const spawnComment = main.indexOf('// Spawn new daemon', start);
    expect(spawnComment).toBeGreaterThan(start);
    const guardSection = main.slice(start, spawnComment);
    expect(guardSection).toContain('may_spawn_daemon()');
  });
});
