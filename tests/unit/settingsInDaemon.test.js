/**
 * Phase 1 step 0a: the daemon owns frontend-settings.json
 * (src-core/src/settings_doc.rs, src-daemon/src/handlers/settings.rs). The
 * app reads and writes it through `settings.get` / `settings.replace`; the
 * shell's read/write_settings_json stay only as safeStorage's fallback for a
 * daemon without them. Reads the sources, like learningInDaemon.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const safeStorage = readFileSync('src/stores/safeStorage.js', 'utf8');
const transport = readFileSync('src/services/transport.js', 'utf8');
const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'), transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
const handler = readFileSync('src-daemon/src/handlers/settings.rs', 'utf8');
const server = readFileSync('src-daemon/src/server.rs', 'utf8');
const handlersMod = readFileSync('src-daemon/src/handlers/mod.rs', 'utf8');
const demo = readFileSync('src/demo/backend.js', 'utf8');
const shell = readFileSync('src-tauri/src/main.rs', 'utf8');

const RPCS = ['settings.get', 'settings.patch', 'settings.replace'];

function files(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...files(path, ext));
    } else if (name.endsWith(ext) && !/\.test\.jsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

// The code of a Rust file before its test module (test modules seed the file).
const rustCode = path => {
  const src = readFileSync(path, 'utf8');
  const i = src.search(/#\[cfg\(test\)\]\s*mod /);
  return i >= 0 ? src.slice(0, i) : src;
};

describe('the daemon owns the settings document', () => {
  it.each(RPCS)('%s is daemon-owned, routed by handlers/settings.rs and stubbed in the demo', (rpc) => {
    expect(owned).toContain(`'${rpc}'`);
    expect(handler).toContain(`"${rpc}"`);
    expect(demo).toContain(`'${rpc}'`);
  });

  it('the daemon chains the settings router', () => {
    expect(handlersMod).toMatch(/pub\(crate\) mod settings;/);
    expect(server).toContain('crate::handlers::settings::route(');
  });

  it('safeStorage reads and writes through the daemon', () => {
    expect(safeStorage).toContain("rpc('settings.get'");
    expect(safeStorage).toContain("rpc('settings.replace'");
    expect(safeStorage).toContain("'settings-changed'");
  });

  it('the shell commands stay only as the fallback, and the fallback write is the atomic one', () => {
    expect(shell).toMatch(/fn read_settings_json\(/);
    expect(shell).toMatch(/fn write_settings_json\(/);
    expect(shell).toContain('mailvault_core::settings_doc::write_document(');
    const callers = files('src', '.js').concat(files('src', '.jsx'))
      .filter(f => f !== join('src', 'demo', 'backend.js') && f !== join('src', 'demo', 'runtime.js'))
      .filter(f => /read_settings_json|write_settings_json/.test(readFileSync(f, 'utf8')));
    expect(callers).toEqual([join('src', 'stores', 'safeStorage.js')]);
  });

  it('no daemon or core code reads the settings file but settings_doc.rs', () => {
    const hits = [];
    for (const file of [...files('src-core/src', '.rs'), ...files('src-daemon/src', '.rs')]) {
      if (/tests?\.rs$/.test(file) || file.endsWith(join('src', 'settings_doc.rs'))) continue;
      rustCode(file).split('\n').forEach((line, i) => {
        if (line.includes('frontend-settings') && !line.trim().startsWith('//')) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the event names keys and a version, never values', () => {
    expect(handler).toMatch(/CHANGED_EVENT, json!\(\{"keys": change\.changed, "version": change\.version\}\)/);
  });
});
