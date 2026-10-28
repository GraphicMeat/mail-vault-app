// S2 owns a dormant native refresh path while the production hook still owns refresh.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(path, 'utf8');
const executable = source => source.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

describe('native refresh foundation', () => {
  it('registers strict daemon RPCs, shell budgets, and the demo protocol', () => {
    const transport = read('src/services/transport.js');
    const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'),
      transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
    const server = executable(read('src-daemon/src/server.rs'));
    const handler = read('src-daemon/src/handlers/refresh.rs');
    const demo = read('src/demo/backend.js');
    const shell = read('src-tauri/src/main.rs');
    for (const method of ['sync.refresh', 'sync.refresh_status', 'sync.context']) {
      expect(owned).toContain(`'${method}'`);
      expect(server).toContain(`"${method}"`);
      expect(handler).toContain(`"${method}"`);
      expect(demo).toContain(`'${method}'`);
      expect(shell).toContain(`"${method}"`);
    }
    expect(read('src-daemon/src/main.rs')).toContain('refresh_worker::start(&state)');
    expect(read('src-daemon/src/handlers/mod.rs')).toContain('mod refresh;');
  });

  it('leaves production scheduler and refresh ownership dormant until cutover', () => {
    const app = executable(read('src/App.jsx'));
    const hook = executable(read('src/hooks/useEmailScheduler.js'));
    const refresh = executable(read('src/services/workflows/refreshAccounts.js'));
    expect(app).toContain('useEmailScheduler();');
    expect(hook).not.toContain("'sync.context'");
    expect(hook).not.toContain("'sync.refresh'");
    expect(refresh).not.toContain("'sync.refresh'");
    expect(read('src-daemon/src/refresh_worker.rs')).toContain('automatic_enabled: bool');
    expect(read('src-daemon/src/refresh_worker.rs')).toContain('if enabled { break; }');
  });
});
