/**
 * Phase 1 row 8: the daemon keeps every account's send-as alias list
 * (src-daemon/src/handlers/alias_store.rs, rules in
 * src-core/src/aliases/list.rs) and looks an account up with the
 * credentials it reads itself. The app keeps thin bindings in
 * src/services/aliases.js. Reads the sources, like learningInDaemon.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const api = readFileSync('src/services/aliases.js', 'utf8');
const transport = readFileSync('src/services/transport.js', 'utf8');
const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'), transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
const handlerSource = readFileSync('src-daemon/src/handlers/alias_store.rs', 'utf8');
// The code before the test module (the tests seed files themselves).
const handler = handlerSource.slice(0, handlerSource.search(/#\[cfg\(test\)\]\s*mod /));
const server = readFileSync('src-daemon/src/server.rs', 'utf8');
const handlersMod = readFileSync('src-daemon/src/handlers/mod.rs', 'utf8');
const demo = readFileSync('src/demo/backend.js', 'utf8');

const RPCS = ['aliases.list', 'aliases.add', 'aliases.remove', 'aliases.dismiss', 'aliases.refresh'];

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sourceFiles(path));
    } else if (/\.(js|jsx)$/.test(name) && !/\.test\.jsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe('the alias lists live in the daemon', () => {
  it('the JS alias modules are gone', () => {
    expect(existsSync('src/services/aliasDiscovery.js')).toBe(false);
    expect(existsSync('src/utils/aliasDiscovery.js')).toBe(false);
  });

  it.each(RPCS)('%s is daemon-owned, routed by handlers/alias_store.rs and stubbed in the demo', (rpc) => {
    expect(owned).toContain(`'${rpc}'`);
    expect(handler).toContain(`"${rpc}"`);
    expect(demo).toContain(`'${rpc}'`);
  });

  it('the daemon chains the alias store router', () => {
    expect(handlersMod).toMatch(/pub\(crate\) mod alias_store;/);
    expect(server).toContain('crate::handlers::alias_store::route(');
  });

  it('the bindings name the account and never carry a token or the account object', () => {
    expect(api).not.toMatch(/oauth2AccessToken|oauth2RefreshToken|password/);
    for (const [, body] of api.matchAll(/send\('aliases\.[a-z]+', ([^)]*)\)/g)) {
      expect(body).not.toMatch(/(^|[{,]\s*)account\s*[,}:]/);
    }
  });

  it('the daemon writes the lists only through the settings document', () => {
    expect(handler).toContain('SettingsDoc::shared(');
    expect(handler).not.toMatch(/frontend-settings/);
    expect(handler).not.toMatch(/std::fs::write|File::create/);
  });

  it('no app source merges, adds or removes aliases itself', () => {
    const hits = [];
    for (const file of sourceFiles('src')) {
      if (file === join('src', 'demo', 'backend.js')) continue;
      const text = readFileSync(file, 'utf8');
      for (const name of ['mergeDiscovery', 'addAliasToList', 'applyDiscovery', 'aliases.discover']) {
        if (text.includes(name) && file !== join('src', 'services', 'transport.js')) hits.push(`${file}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
