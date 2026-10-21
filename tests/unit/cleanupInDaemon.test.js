/**
 * Phase 1 row 6: the auto-cleanup rules run in the daemon
 * (src-daemon/src/cleanup_worker.rs, through the abd engine; the selection is
 * src-core/src/cleanup_rules.rs). The app stores the rules and calls the
 * `cleanup.*` RPCs through src/services/cleanupApi.js. Reads the sources,
 * like learningInDaemon.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const api = readFileSync('src/services/cleanupApi.js', 'utf8');
const transport = readFileSync('src/services/transport.js', 'utf8');
const owned = transport.slice(transport.indexOf('export const DAEMON_OWNED'), transport.indexOf(']);', transport.indexOf('export const DAEMON_OWNED')));
const handler = readFileSync('src-daemon/src/handlers/cleanup.rs', 'utf8');
const server = readFileSync('src-daemon/src/server.rs', 'utf8');
const handlersMod = readFileSync('src-daemon/src/handlers/mod.rs', 'utf8');
const demo = readFileSync('src/demo/backend.js', 'utf8');
const rules = readFileSync('src-core/src/cleanup_rules.rs', 'utf8');
const storage = readFileSync('src/components/settings/StorageSettings.jsx', 'utf8');

const RPCS = [...api.matchAll(/send\('(cleanup\.[a-z_.]+)'/g)].map((m) => m[1]);

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

describe('the auto-cleanup rules run in the daemon', () => {
  it('the app bindings call the four cleanup RPCs', () => {
    expect([...RPCS].sort()).toEqual(['cleanup.preview', 'cleanup.rules.get', 'cleanup.run_now', 'cleanup.status']);
  });

  // Run All Now goes through the shell, which resolves the backup drive's
  // bookmark (the daemon cannot) and holds it until the run's done event.
  it('Run All Now reaches the daemon through the shell forwarder, which lets the drive go', () => {
    expect(api).toContain("send('cleanup_run_now'");
    expect(owned).not.toContain("'cleanup_run_now'");
    expect(demo).toContain("case 'cleanup_run_now'");
    const main = readFileSync('src-tauri/src/main.rs', 'utf8');
    const handlerStart = main.indexOf('generate_handler![');
    expect(main.slice(handlerStart, main.indexOf(']', handlerStart))).toContain('cleanup::cleanup_run_now');
    expect(main).toContain('.manage(cleanup::HeldCleanupPath::default())');
    const channel = readFileSync('src-tauri/src/daemon_channel.rs', 'utf8');
    expect(channel).toContain('crate::cleanup::release_after_event(');
    expect(channel.match(/crate::cleanup::release_all\(/g)).toHaveLength(2);
    const shell = readFileSync('src-tauri/src/cleanup.rs', 'utf8');
    expect(shell).toMatch(/#\[tauri::command\]\s*pub async fn cleanup_run_now\(/);
    expect(shell).toContain('ports.call("cleanup.run_now", json!({ "mirrorRoot": root })');
  });

  it('the JS engine and its folder policy are gone', () => {
    expect(existsSync('src/services/cleanupEngine.js')).toBe(false);
    expect(existsSync('src/utils/cleanupFolders.js')).toBe(false);
  });

  it.each(RPCS)('%s is daemon-owned, routed by handlers/cleanup.rs and stubbed in the demo', (rpc) => {
    expect(owned).toContain(`'${rpc}'`);
    expect(handler).toContain(`"${rpc}" =>`);
    expect(demo).toContain(`'${rpc}'`);
  });

  it('the daemon chains the cleanup router', () => {
    expect(handlersMod).toMatch(/pub\(crate\) mod cleanup;/);
    expect(server).toContain('crate::handlers::cleanup::route(');
  });

  it('the rule picker offers no folder the daemon refuses', () => {
    const picker = JSON.parse(storage.match(/const CLEANUP_FOLDERS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
    const protectedFolders = JSON.parse(rules.match(/pub const PROTECTED_FOLDERS: &\[&str\] = &(\[[^\]]*\]);/)[1]);
    expect(protectedFolders).toContain('Drafts');
    expect(picker.filter((f) => protectedFolders.includes(f))).toEqual([]);
    expect(picker).toEqual(expect.arrayContaining(['all', 'INBOX', 'Trash']));
  });

  it('no app source runs a rule, deletes for one, or schedules one', () => {
    const hits = [];
    for (const file of sourceFiles('src')) {
      if (file === join('src', 'demo', 'backend.js')) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/runCleanupRules|shouldRunCleanup|resolveCleanupFolders|isTrashFolder|setCleanupLastRun\(/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
