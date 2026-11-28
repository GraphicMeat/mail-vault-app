// A daemon RPC the app calls by its flat name reaches the daemon only through
// transport.js: DAEMON_OWNED (or a DAEMON_COMMANDS rename). Anything else goes
// to the Tauri shell, which answers "Command <name> not found" for a name it
// does not register. That is how every bulk flag change (`imap_set_flags_batch`,
// added daemon-side only) failed on the server while the rows repainted, and
// was left in the journal for a replay that went the same dead way.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const daemonCall = vi.fn();
vi.mock('../daemonClient.js', () => ({
  daemonCall: (...a) => daemonCall(...a),
  DaemonError: class DaemonError extends Error { constructor(m, code) { super(m); this.code = code; } },
}));

const { send, DAEMON_OWNED } = await import('../transport.js');
const { RPC_METHODS } = await import('../rpcMethods.generated.js');

const ROOT = join(import.meta.dirname, '../../..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Every command the shell's `generate_handler!` registers, by bare name. */
function shellCommands() {
  const main = read('src-tauri/src/main.rs');
  const start = main.indexOf('generate_handler![');
  const block = main.slice(start, main.indexOf('])', start));
  return new Set([...block.matchAll(/(?:[a-z0-9_]+::)*([a-z0-9_]+)\s*(?:,|$)/gm)].map((m) => m[1]));
}

function renamed() {
  const src = read('src/services/transport.js');
  const start = src.indexOf('const DAEMON_COMMANDS');
  const block = src.slice(start, src.indexOf('};', start));
  return new Set([...block.matchAll(/^\s*'?([a-z0-9_]+)'?\s*:/gm)].map((m) => m[1]));
}

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return ['__tests__', 'demo'].includes(name) ? [] : sources(path);
    return /\.(js|jsx)$/.test(name) ? [path] : [];
  });
}

describe('every daemon call by flat name is routed to the daemon', () => {
  it('leaves no daemon method the shell does not register to fall through to Tauri invoke', () => {
    const daemon = new Set(RPC_METHODS);
    const shell = shellCommands();
    const viaRename = renamed();
    // Anti-vacuity: the parse found the shell's commands and the app's calls.
    expect(shell.has('daemon_rpc')).toBe(true);
    expect(shell.has('vault_get_status')).toBe(true);
    const unrouted = new Map();
    let calls = 0;
    for (const file of sources(join(ROOT, 'src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\b(?:tauriInvoke|send)\(\s*'([a-z0-9_.]+)'/g)) {
        const name = m[1];
        if (!daemon.has(name)) continue;
        calls += 1;
        if (shell.has(name) || DAEMON_OWNED.has(name) || viaRename.has(name)) continue;
        unrouted.set(name, file.slice(ROOT.length + 1));
      }
    }
    expect(calls).toBeGreaterThan(50);
    expect(Object.fromEntries(unrouted)).toEqual({});
  });

  it('sends imap_set_flags_batch to the daemon under its own name', async () => {
    daemonCall.mockResolvedValueOnce({ done: [7, 8], skipped: [] });
    const args = { account: { id: 'a' }, mailbox: 'INBOX', uids: [7, 8], flags: ['\\Seen'], action: 'add' };
    await expect(send('imap_set_flags_batch', args)).resolves.toEqual({ done: [7, 8], skipped: [] });
    expect(daemonCall).toHaveBeenCalledWith('imap_set_flags_batch', args);
  });
});
