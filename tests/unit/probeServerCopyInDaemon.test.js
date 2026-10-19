/**
 * Phase 1, row 3: "is the server copy gone?" is the daemon's question
 * (`custody.probe_server_copy`, src-daemon/src/handlers/custody_probe.rs, its
 * rules in src-core/src/custody/probe.rs). The app resolves which message is
 * meant and repaints its rows from the answer; it no longer reads the custody
 * entry, sweeps the server or stamps the entry itself. CI never runs
 * `cargo test -p mailvault-daemon`, so this reads the sources, same pattern
 * as `networkInDaemon` and `vaultInDaemon`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const METHOD = 'custody.probe_server_copy';

describe('the server-copy probe lives in the daemon', () => {
  it('the daemon routes it, from its own handler file', () => {
    expect(existsSync('src-daemon/src/handlers/custody_probe.rs')).toBe(true);
    expect(read('src-daemon/src/handlers/custody_probe.rs')).toContain(`"${METHOD}"`);
    expect(read('src-daemon/src/handlers/mod.rs')).toMatch(/pub\(crate\) mod custody_probe;/);
    expect(code(read('src-daemon/src/server.rs'))).toMatch(/crate::handlers::custody_probe::route\(/);
    expect(existsSync('src-core/src/custody/probe.rs')).toBe(true);
  });

  it('the app reaches it as a daemon-owned command, and the browser demo answers it', () => {
    expect(read('src/services/transport.js')).toContain(`'${METHOD}'`);
    expect(read('src/demo/backend.js')).toContain(`'${METHOD}'`);
    expect(code(read('src/services/api.js'))).toContain(`'${METHOD}'`);
  });

  it('the app side keeps no sweep, custody read or custody write of its own', () => {
    const src = code(read('src/services/workflows/probeServerCopy.js'));
    expect(src).toMatch(/api\.probeServerCopy\(/);
    for (const gone of ['findMessageId', 'getLocalIndexEntry', 'stampVaultEntry', 'appendLocalIndex', 'local_index_', 'imap_find_message_id']) {
      expect(src, gone).not.toContain(gone);
    }
  });
});
