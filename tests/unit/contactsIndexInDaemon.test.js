/**
 * Phase 1 row 2: the contacts index the compose pickers and the privacy
 * dictionary read is ranked by the daemon (`people.contacts.top/search/names`,
 * `mailvault_core::people::seen`), not by `src/utils/contactsIndex.js`, which
 * is gone. Reads the source, like networkInDaemon / vaultInDaemon: CI never
 * runs `cargo test -p mailvault-daemon` against the app.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RPCS = ['people.contacts.top', 'people.contacts.search', 'people.contacts.names'];

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(js|jsx|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

describe('the contacts index lives in the daemon', () => {
  it('the JS index is deleted and nothing imports it', () => {
    expect(existsSync('src/utils/contactsIndex.js')).toBe(false);
    const importers = sources('src').filter(f => /from ['"][^'"]*contactsIndex['"]/.test(readFileSync(f, 'utf8')));
    expect(importers).toEqual([]);
  });

  it('the pickers and the privacy dictionary ask the daemon', () => {
    const picker = readFileSync('src/components/ContactsPicker.jsx', 'utf8');
    expect(picker).toContain("'people.contacts.top'");
    expect(picker).toContain("'people.contacts.search'");
    expect(readFileSync('src/components/privacy/PrivacyDictionaryHost.jsx', 'utf8')).toContain("'people.contacts.names'");
  });

  it.each(RPCS)('%s is routed, gated, daemon-owned and stubbed in the demo', (name) => {
    expect(readFileSync('src-daemon/src/handlers/people.rs', 'utf8')).toContain(`"${name}" =>`);
    // the vault-unreachable gate covers `people.*`; its test names each method
    expect(readFileSync('src-daemon/src/server.rs', 'utf8')).toContain(`("${name}",`);
    const transport = readFileSync('src/services/transport.js', 'utf8');
    const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'), transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
    expect(owned).toContain(`'${name}'`);
    expect(readFileSync('src/demo/backend.js', 'utf8')).toMatch(/'people\.contacts\.'/);
  });

  it('the ranking is a core module with the parity table as tests', () => {
    const seen = readFileSync('src-core/src/people/seen.rs', 'utf8');
    for (const fn of ['pub fn merge', 'pub fn top', 'pub fn search', 'pub fn names']) expect(seen).toContain(fn);
    expect(seen).toContain('fn search_matches_the_js_index_query_for_query');
  });
});
