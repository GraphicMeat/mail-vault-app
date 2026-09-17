/**
 * Plan 2026-09-17-daemon-shell-phase5-network, Task 5.9 (spec §6 Phase 6
 * note, pulled forward): every command this phase moved — interactive IMAP
 * (20), SMTP (4), Graph (12 real + graph_get_mime dead), OAuth2 (3), DNS (2),
 * plus the 2 dead keychain commands from Task 5.1 (get_password,
 * delete_password) — must be absent from `generate_handler!`, and the 3
 * commands that deliberately stayed app-local (store_credentials,
 * get_credentials, store_password — keychain calls tied 1:1 to a UI action,
 * per the plan's scoping call) must still be registered. CI never runs
 * `cargo test -p mailvault`, so this reads the source directly, same
 * pattern as `tests/unit/searchIndexInDaemon.test.js` (Phase 1) and
 * `tests/unit/vaultInDaemon.test.js` (Phase 2+).
 *
 * This is deliberately scoped to Phase 5's own domain (IMAP/SMTP/Graph/
 * OAuth2/DNS/keychain), not a full-repo `generate_handler!` audit — backup,
 * IAP, GitHub device-auth, vault move/adopt and the mailto/dialog/window
 * commands are other domains with their own history (backup is an
 * explicitly documented Known Gap in architecture.md, not this phase's
 * job) and are out of scope here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const main = readFileSync('src-tauri/src/main.rs', 'utf8');
const handlerStart = main.indexOf('generate_handler![');
const handlerEnd = main.indexOf('])', handlerStart);
const handlerBlock = main.slice(handlerStart, handlerEnd);
// Strip `//`-only comment lines before matching: the block deliberately
// keeps explanatory comments naming every moved command (so a reader knows
// where each one went), and those comments legitimately contain the same
// bare identifiers this guard is checking are gone as *real entries*.
const handlerCode = handlerBlock
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

// Task 5.4a (10) + 5.4b (10): interactive IMAP, rerouted (not deleted) per
// the plan's scoping call — these were duplicate Tauri-twin commands of
// functions sync_engine.rs already called; they get their own daemon RPC
// route instead, same request/response JSON, DAEMON_OWNED in transport.js.
const IMAP = [
  'imap_get_mailboxes', 'imap_get_emails', 'imap_check_mailbox_status', 'imap_folder_status',
  'imap_search_all_uids', 'imap_fetch_headers_by_uids', 'imap_fetch_changed_flags',
  'imap_get_email', 'imap_get_email_light', 'imap_search_emails',
  'imap_test_connection', 'imap_set_flags', 'imap_delete_email', 'imap_ensure_sent_mailbox',
  'imap_create_mailbox', 'imap_rename_mailbox', 'imap_delete_mailbox', 'imap_find_message_id',
  'imap_disconnect', 'imap_move_emails',
];

// Task 5.5: SMTP, after Task 5.3 relocated the client into src-core.
const SMTP = ['smtp_test_connection', 'smtp_build_mime', 'smtp_build_draft_mime', 'smtp_send_email'];

// Task 5.6: Graph, 12 real. `graph_get_mime` (13th) had 0 callers and was
// deleted outright, not ported — it belongs in DEAD below, not here.
const GRAPH = [
  'graph_list_folders', 'graph_list_messages', 'graph_get_message', 'graph_cache_mime',
  'graph_set_read', 'graph_set_flagged', 'graph_delete_message', 'graph_move_emails',
  'graph_create_folder', 'graph_rename_folder', 'graph_move_folder', 'graph_delete_folder',
];

// Task 5.7: OAuth2. `OAuth2Manager` now lives once in the daemon's
// `DaemonState`, not the app's `.manage(...)`.
const OAUTH2 = ['oauth2_auth_url', 'oauth2_exchange', 'oauth2_refresh'];

// Task 5.8: DNS. `resolve_email_settings` was already core logic behind a
// thin command; `dns_mail_health` moved from src-tauri/src/dns.rs (now
// deleted outright, same as smtp.rs at Task 5.9).
const DNS = ['resolve_email_settings', 'dns_mail_health'];

// Dead commands deleted outright across the phase, never ported: 2 keychain
// (Task 5.1, 0 callers each) + graph_get_mime (Task 5.6, 0 callers).
const DEAD = ['get_password', 'delete_password', 'graph_get_mime'];

const MOVED_OR_DEAD = [...IMAP, ...SMTP, ...GRAPH, ...OAUTH2, ...DNS, ...DEAD];

// The 3 keychain commands the plan's scoping call keeps app-local: OS
// keychain calls tied 1:1 to a UI action (add-account, settings), not
// background work — moving them would add the keychain-inheritance risk
// (Task 5.1's ledger) to a path that doesn't need it.
const STAY_APP_LOCAL_KEYCHAIN = ['store_credentials', 'get_credentials', 'store_password'];

describe('Phase 5: IMAP/SMTP/Graph/OAuth2/DNS live in the daemon, keychain interactive commands stay app-local (Task 5.9)', () => {
  it('reads a real handler list', () => {
    expect(handlerCode).toContain('daemon_rpc');
  });

  it('the guarded name lists match the plan\'s reconciled inventory (20 IMAP, 4 SMTP, 12 Graph, 3 OAuth2, 2 DNS, 3 dead)', () => {
    expect(IMAP.length).toBe(20);
    expect(SMTP.length).toBe(4);
    expect(GRAPH.length).toBe(12);
    expect(OAUTH2.length).toBe(3);
    expect(DNS.length).toBe(2);
    expect(DEAD.length).toBe(3);
  });

  it.each(MOVED_OR_DEAD)('the app does not register %s as a real generate_handler! entry', (name) => {
    expect(handlerCode).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  it.each(STAY_APP_LOCAL_KEYCHAIN)('%s stays a Tauri command (interactive keychain, per the Phase 5 scoping call)', (name) => {
    expect(handlerCode).toMatch(new RegExp(`\\b${name}\\b`));
  });

  it('no app source declares an fn for a moved/dead command (not just absent from generate_handler!)', () => {
    for (const name of MOVED_OR_DEAD) {
      expect(main).not.toMatch(new RegExp(`fn ${name}\\(`));
    }
  });

  it('src-tauri/src/smtp.rs and src-tauri/src/dns.rs are both deleted (Task 5.9, Task 5.8)', () => {
    expect(existsSync('src-tauri/src/smtp.rs')).toBe(false);
    expect(existsSync('src-tauri/src/dns.rs')).toBe(false);
  });

  // Every real (non-dead) migrated name must also be routed in transport.js,
  // or the frontend would call a command that exists nowhere.
  const transportSrc = readFileSync('src/services/transport.js', 'utf8');
  const REAL_MOVED = [...IMAP, ...SMTP, ...GRAPH, ...OAUTH2, ...DNS];
  it.each(REAL_MOVED)('%s is routed via transport.js (DAEMON_OWNED)', (name) => {
    expect(transportSrc).toMatch(new RegExp(`'${name}'`));
  });

  // `ImapPool`/`OAuth2Manager` app-side consumers: Task 5.4b left exactly one
  // shared, process-global `ImapPool` behind (`backup.rs`'s `OnceLock`,
  // serving `archive.rs` and `backup.rs` — a documented, deliberate
  // exception, not a leftover), and `OAuth2Manager` has zero remaining
  // src-tauri consumers (it now lives once in the daemon's `DaemonState`).
  // Both checks strip `//`-only comment lines first — several files
  // deliberately document the old pattern in a comment (e.g. "No
  // `.manage(imap::ImapPool::new())` — Task 5.4b moved..."), which would
  // otherwise false-positive this guard on its own explanatory text.
  const nonCommentBody = (body) => body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const rsDir = 'src-tauri/src';
  const rsFiles = readdirSync(rsDir)
    .filter((f) => f.endsWith('.rs'))
    .map((f) => [f, nonCommentBody(readFileSync(`${rsDir}/${f}`, 'utf8'))]);

  it('no tauri::State<ImapPool>/.manage(ImapPool)/.state::<ImapPool>() pattern remains (the app-managed pool from before Task 5.4b)', () => {
    const offenders = rsFiles
      .filter(([, body]) => /tauri::State<'?_?,?\s*ImapPool>|\.manage\(\s*imap::ImapPool::new\(\)\s*\)|\.state::<ImapPool>\(\)/.test(body))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('no OAuth2Manager construction or .manage() call remains in src-tauri', () => {
    const offenders = rsFiles
      .filter(([, body]) => /OAuth2Manager::new\(\)|\.manage\(\s*oauth2::OAuth2Manager/.test(body))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  // Task 5.9: `lettre`/`hickory-resolver` in src-tauri/Cargo.toml were left
  // over from before Task 5.3/5.8 moved their only callers to src-core;
  // grepped src-tauri/src for both before trimming (per the ledger's "grep
  // before removing, don't guess" instruction) — zero hits for either.
  it('src-tauri/Cargo.toml no longer lists lettre or hickory-resolver as direct dependencies', () => {
    const cargoToml = readFileSync('src-tauri/Cargo.toml', 'utf8');
    expect(cargoToml).not.toMatch(/^lettre\s*=/m);
    expect(cargoToml).not.toMatch(/^hickory-resolver\s*=/m);
  });
});
