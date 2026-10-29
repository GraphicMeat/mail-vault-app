// S5 owns a native download-ahead focus beside the JS pipelines, which keep running until S7.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = path => readFileSync(path, 'utf8');
const executable = source => source.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(path, out); }
    else if (/\.(js|jsx)$/.test(name)) out.push(path);
  }
  return out;
};

describe('native pipeline focus', () => {
  it('registers strict daemon RPCs, the shell reply budget and the demo protocol', () => {
    const transport = read('src/services/transport.js');
    const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'),
      transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
    const server = executable(read('src-daemon/src/server.rs'));
    const handler = read('src-daemon/src/handlers/pipeline.rs');
    const demo = read('src/demo/backend.js');
    const shell = read('src-tauri/src/main.rs');
    for (const method of ['pipeline.focus', 'pipeline.status']) {
      expect(owned).toContain(`'${method}'`);
      expect(server).toContain(`"${method}"`);
      expect(handler).toContain(`"${method}"`);
      expect(demo).toContain(`'${method}'`);
      expect(shell).toContain(`"${method}"`);
    }
    expect(read('src-daemon/src/handlers/mod.rs')).toContain('mod pipeline;');
    expect(read('src-daemon/src/main.rs')).toContain('mod pipeline_focus;');
    expect(read('src-core/src/lib.rs')).toContain('pub mod pipeline;');
  });

  it('keeps the production frontend on the JS pipelines until the S7 cutover', () => {
    for (const path of walk('src')) {
      if (path === 'src/services/transport.js' || path === 'src/demo/backend.js') continue;
      const source = executable(read(path));
      expect(source, path).not.toMatch(/['"]pipeline\.(focus|status)['"]/);
    }
    const app = executable(read('src/App.jsx'));
    expect(app).toContain('usePipelineCoordinator();');
  });

  it('leaves the ordinary body runner disabled and the Hoarder sweep budget untouched', () => {
    const focus = executable(read('src-daemon/src/pipeline_focus.rs'));
    for (const forbidden of ['auto_cache', 'cache_arrivals', 'fetch_email_by_uid', 'hoard_account', 'DAILY_BYTES']) {
      expect(focus, forbidden).not.toContain(forbidden);
    }
    expect(read('src-daemon/src/hoarder_worker.rs')).toContain('const DAILY_BYTES: u64 = 1000 * 1024 * 1024;');
    expect(read('src-daemon/src/hoarder_worker.rs')).toContain('pub(crate) pipeline: Arc<crate::pipeline_focus::PipelineFocus>');
  });
});
