// Source ownership guard for the native observation routes and thin adapters.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const read = (file) => readFileSync(file, 'utf8');
const code = (source) => source.split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
const owned = (source) => source.slice(source.indexOf('export const DAEMON_OWNED'),
  source.indexOf(']);', source.indexOf('export const DAEMON_OWNED')));

describe('sync observation policy is native', () => {
  it('routes both tagged families through the daemon with no Tauri twin', () => {
    const transport = read('src/services/transport.js');
    const registry = owned(transport);
    expect(registry).toContain("'sync.probe'");
    expect(registry).toContain("'folders.status'");
    expect(code(read('src-daemon/src/server.rs')))
      .toMatch(/"sync\.probe"\s*\|\s*"folders\.status"\s*=>\s*crate::handlers::sync_observation::route/);
    expect(read('src-daemon/src/handlers/mod.rs'))
      .toMatch(/pub\(crate\) mod sync_observation;/);
    const handler = read('src-daemon/src/handlers/sync_observation.rs');
    for (const method of ['sync.probe', 'folders.status']) {
      expect(handler).toContain(`"${method}"`);
      expect(read('src/demo/backend.js')).toContain(`'${method}'`);
    }
  });

  it('leaves no cache decision, provider status or folder selection in the wrappers', () => {
    const probe = code(read('src/services/syncProbe.js'));
    const folder = code(read('src/services/workflows/folderStatus.js'));
    for (const legacy of ['getEmailHeadersMeta', 'checkMailboxStatus', '_lastVerified',
      'PROBE_TTL_MS', 'highestModseq', 'uidNextSame']) {
      expect(probe, legacy).not.toContain(legacy);
    }
    for (const legacy of ['fetchFolderStatus', '_flattenSelectable', '_lastRun',
      'STATUS_FRESH_MS', 'MAX_STATUS_FOLDERS']) {
      expect(folder, legacy).not.toContain(legacy);
    }
    expect(probe).toContain("'sync.probe'");
    expect(folder).toContain("'folders.status'");
    expect(read('src-core/src/sync_policy.rs')).toContain('pub fn probe_decision');
    expect(read('src-core/src/sync_policy.rs')).toContain('pub fn select_status_paths');
  });

  it('keeps the activation completeness guard and uses proof or completed ticket', () => {
    const activation = code(read('src/services/workflows/activateAccount.js'));
    expect(activation).toMatch(/probe\.unchanged\s*&&\s*get\(\)\.serverUids\.complete/);
    expect(activation).toMatch(/markVerified\(accountId,\s*effectiveMailbox,\s*\{\s*verificationRef/);
    expect(activation).toMatch(/markVerified\(accountId,\s*effectiveMailbox,\s*\{\s*ticket/);
    expect(activation).toMatch(/syncResult\?\.success/);
  });

  it('gives the new RPCs bounded shell replies', () => {
    const shell = code(read('src-tauri/src/main.rs'));
    expect(shell).toMatch(/"sync\.probe"\s*=>\s*Some\(Duration::from_secs\(30\)\)/);
    expect(shell).toMatch(/"folders\.status"\s*=>\s*Some\(Duration::from_secs\(125\)\)/);
  });

  it('pins the sized background worker, heap jobs, blocking QoS and foreground yield', () => {
    const files = [
      'src-daemon/src/handlers/sync_observation.rs',
      'src-daemon/src/sync_observation.rs',
      'src-daemon/src/observation_worker.rs',
    ];
    const observation = code(files.filter(existsSync).map(read).join('\n'));
    expect(observation, 'observation jobs need an owned OS worker thread')
      .toMatch(/std::thread::Builder::new\s*\(/);
    expect(observation, 'observation worker needs an explicit 8 MiB stack')
      .toMatch(/\.stack_size\s*\(\s*8\s*\*\s*1024\s*\*\s*1024\s*\)/);
    expect(observation, 'observation worker and blocking children need background QoS')
      .toMatch(/QOS_CLASS_BACKGROUND/);
    expect(observation, 'long observation futures must be heap spawned on their worker')
      .toMatch(/(?:tokio::(?:task::)?spawn(?:_local)?|\.spawn_local)\s*\(\s*Box::pin/);
    expect(observation, 'observation work must yield to foreground reads')
      .toMatch(/wait_foreground_quiet\s*\(/);
    expect(observation, 'observation disk reads must use the worker blocking pool')
      .toMatch(/spawn_blocking\s*\(/);
  });
});
