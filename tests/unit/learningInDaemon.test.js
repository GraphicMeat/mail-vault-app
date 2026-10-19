/**
 * Phase 1 row 1: the learning logic (correction to rule, rule storage,
 * export and import, stats) lives in the daemon (src-daemon/src/handlers/
 * learning.rs, src-core/src/learning.rs). The app keeps thin bindings in
 * src/services/learningApi.js. Reads the sources, like searchIndexInDaemon.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const api = readFileSync('src/services/learningApi.js', 'utf8');
const transport = readFileSync('src/services/transport.js', 'utf8');
const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'), transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
const handler = readFileSync('src-daemon/src/handlers/learning.rs', 'utf8');
const server = readFileSync('src-daemon/src/server.rs', 'utf8');
const handlersMod = readFileSync('src-daemon/src/handlers/mod.rs', 'utf8');
const demo = readFileSync('src/demo/backend.js', 'utf8');

const RPCS = [...api.matchAll(/send\('(learning\.[a-z_]+)'/g)].map((m) => m[1]);

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

describe('the learning logic lives in the daemon', () => {
  it('the app bindings call the seven learning RPCs', () => {
    expect(RPCS.sort()).toEqual([
      'learning.delete_rule', 'learning.export', 'learning.import', 'learning.record_correction',
      'learning.rules', 'learning.save_rule', 'learning.stats',
    ]);
  });

  it('the JS learning modules are gone', () => {
    expect(existsSync('src/services/learningService.js')).toBe(false);
    expect(existsSync('src/services/ruleExporter.js')).toBe(false);
  });

  it.each(RPCS)('%s is daemon-owned, routed by handlers/learning.rs and stubbed in the demo', (rpc) => {
    expect(owned).toContain(`'${rpc}'`);
    expect(handler).toContain(`"${rpc}" =>`);
    expect(demo).toContain(`'${rpc}'`);
  });

  it('the daemon chains the learning router', () => {
    expect(handlersMod).toMatch(/pub\(crate\) mod learning;/);
    expect(server).toContain('crate::handlers::learning::route(');
  });

  it('no app source learns rules', () => {
    const hits = [];
    for (const file of sourceFiles('src')) {
      if (file === join('src', 'demo', 'backend.js')) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/findSharedSubjectWords|anonymizePattern|RULE_THRESHOLD|r-imp-/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
