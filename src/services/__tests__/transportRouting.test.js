/**
 * The daemon registry's own rule: "only route commands whose response shapes
 * match between daemon and Tauri." Every maildir entry broke it.
 *
 * `maildir_exists` — daemon `{exists: bool}` vs Tauri bare bool. `{exists:false}`
 * is truthy, which is what made an archive claim the message was already in the
 * vault, skip the copy, and then fail looking it up.
 *
 * `maildir_storage_stats` — daemon returns core's StorageStats
 * {total_size, total_emails, mailbox_count}; Tauri returns MaildirStorageStats
 * {totalBytes, totalMB, emailCount}. `getStorageUsage` reads the camelCase names,
 * so with the daemon up every field came back undefined.
 *
 * `maildir_store` broke it in a third way — not the response but the FILE: core
 * writes `<uid>:archived,seen:<ts>.eml`, Tauri writes `<uid>:2,AS`, and Tauri's
 * flag parser only understands `:2,`. A message the daemon stored would list
 * with no flags and never read as archived.
 *
 * So the whole family is Tauri's now: one writer, one filename format. A comment
 * could not keep any of them out. This can.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../transport.js', import.meta.url)), 'utf8');

/** The command names the registry actually routes, read off the source. */
function routedCommands() {
  const block = source.slice(
    source.indexOf('const DAEMON_COMMANDS'),
    source.indexOf('// ── Arg mapping'),
  );
  return block.split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('//'))
    .map(line => line.match(/^'([^']+)':/)?.[1])
    .filter(Boolean);
}

describe('daemon command registry', () => {
  const routed = routedCommands();

  it('reads at least the commands we know are routed', () => {
    expect(routed).toContain('sync_now');
    expect(routed).toContain('snapshot_list');
  });

  // The whole maildir family is Tauri's. Two implementations of it exist and
  // they disagree about response shapes AND about the filename they write.
  // Re-adding any of these is a silent, mid-session bug: it only bites once the
  // heartbeat connects.
  it('routes no maildir command at all', () => {
    expect(routed.filter(c => c.startsWith('maildir'))).toEqual([]);
  });

  it.each([
    ['maildir_exists', 'daemon {exists:bool} vs Tauri bare bool'],
    ['maildir_storage_stats', 'daemon snake_case StorageStats vs Tauri camelCase MaildirStorageStats'],
    ['maildir_store', 'core writes <uid>:archived,seen:<ts>.eml, Tauri writes <uid>:2,AS'],
    ['maildir_delete', 'the family has one writer'],
    ['maildir_list', 'daemon {uids,count} vs Tauri MaildirEmailSummary[]'],
    ['maildir_read', 'different response shapes'],
    ['maildir_read_light', 'different response shapes'],
  ])('does not route %s (%s)', (command) => {
    expect(routed).not.toContain(command);
  });
});
