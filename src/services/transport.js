/**
 * Transport layer — routes commands to daemon (via socket) or Tauri (via invoke).
 *
 * Health gate: on startup, sends a heartbeat to the daemon with 5s timeout.
 * If it fails, retries with exponential backoff (5s → 10s → 20s → 40s → 60s cap).
 * All daemon-routed commands fall back to Tauri invoke until the heartbeat succeeds.
 * Once connected, periodic heartbeats keep the state fresh.
 */

import { daemonCall } from './daemonClient.js';
import { t } from '../i18n/index.js';

const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;

let invoke = null;
if (IS_TAURI) {
  import('@tauri-apps/api/core').then(mod => { invoke = mod.invoke; }).catch(() => {});
}

// ── Daemon command registry ─────────────────────────────────────────────────

const DAEMON_COMMANDS = {
  // Maildir — NOT routed. The daemon and Tauri are two independent
  // implementations of this family, and all four commands we had routed
  // disagreed with their Tauri twin:
  //
  //   maildir_exists      daemon {exists: bool}, Tauri a bare bool. `{exists:
  //                       false}` is truthy, so isEmailSaved said "already in
  //                       the vault" about every message once the daemon's
  //                       heartbeat connected — and archiveEmail then failed on
  //                       the uid maildir_list (never routed) had never heard of.
  //   maildir_storage_stats  daemon core::StorageStats {total_size, total_emails,
  //                       mailbox_count}, Tauri {totalBytes, totalMB, emailCount}.
  //                       Not one field name in common.
  //   maildir_store       not a response mismatch but a FILENAME one: core writes
  //                       `<uid>:archived,seen:<ts>.eml`, Tauri writes `<uid>:2,AS.eml`,
  //                       and Tauri's parse_flags_from_filename only understands
  //                       `:2,`. A message the daemon stored lists with no flags
  //                       and never reads as archived.
  //   maildir_delete      compatible today (both match on the `<uid>:` prefix) —
  //                       but it bought nothing: daemonCall goes through
  //                       invoke('daemon_rpc') and then a socket, for what is one
  //                       local readdir either way. Kept out so the family has one
  //                       writer and one filename format.
  //
  // Previously excluded here for the same reason, and still excluded:
  // maildir_list (daemon {uids, count} vs Tauri MaildirEmailSummary[]),
  // maildir_read/read_light/read_light_batch (different response shapes).

  // Cache — ALL cache operations fall through to Tauri.
  // Tauri uses sidecar format (per-UID JSON files + _meta.json).
  // The daemon's mailvault-core uses a different single-file format.
  // The daemon writes to Tauri's format via sync_engine, but reads
  // must go through Tauri's load_from_sidecars implementation.

  // Local index, Graph ID map — fall through to Tauri
  // (format compatibility not yet verified)

  // Sync engine
  'sync_now': 'sync.now',
  'sync_wait': 'sync.wait',
  'sync_status': 'sync.status',
  'sync_watch': 'sync.watch',
  'sync_unwatch': 'sync.unwatch',
  'sync_events': 'sync.events',

  // IMAP, SMTP, DNS, Graph, OAuth2, Credentials — NOT routed through daemon.
  // These fall through to Tauri invoke. The daemon will own sync as a background
  // job (Phase 3-4) instead of proxying individual IMAP commands.

  // Snapshots
  'snapshot_create': 'snapshot.create',
  'snapshot_create_from_maildir': 'snapshot.create_from_maildir',
  'snapshot_list': 'snapshot.list',
  'snapshot_load': 'snapshot.load',
  'snapshot_delete': 'snapshot.delete',

  // LLM
  'llm_status': 'llm.status',
  'llm_list_models': 'llm.list_models',
  'llm_download': 'llm.download',
  'llm_cancel_download': 'llm.cancel_download',
  'llm_delete_model': 'llm.delete_model',
  'llm_load': 'llm.load',
  'llm_unload': 'llm.unload',
  'llm_classify': 'llm.classify',

  // Classification
  'classification_summary': 'classification.summary',
  'classification_results': 'classification.results',
  'classification_override': 'classification.override',
  'classification_status': 'classification.status',

  // Learning
  'learning_load': 'learning.load',
  'learning_save': 'learning.save',
};

// ── Arg mapping ─────────────────────────────────────────────────────────────

function mapArgs(command, args) {
  const mapped = {};
  for (const [key, value] of Object.entries(args)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    mapped[camelKey] = value;
  }
  return mapped;
}

// ── Daemon-owned commands ───────────────────────────────────────────────────
// Commands migrated to the daemon under their own names and payloads
// (spec 2026-09-14 §3.1). Unlike DAEMON_COMMANDS above: no heartbeat gate and
// no invoke fallback. Their Tauri twins are deleted in the same phase.
//
// Task 2.6 adds the vault read family and the attachment cache: unlike the
// old app-side `maildir_*` Tauri commands `transportRouting.test.js` above
// keeps out of DAEMON_COMMANDS, these route through `mailvault_core::vault_files`
// in the daemon (Task 2.2) — the exact same bodies, filename format and JSON
// shapes the deleted Tauri commands used, not the old daemon-only format that
// test guards against.
export const DAEMON_OWNED = new Set([
  'vault_search', 'vault_rows', 'search_index_configure', 'search_index_status', 'search_index_rebuild', 'search_index_destroy',
  'maildir_read', 'maildir_read_light', 'maildir_read_light_batch', 'maildir_read_raw_source', 'maildir_read_attachment',
  'maildir_exists', 'maildir_list', 'maildir_storage_stats', 'maildir_orphan_stats',
  'cache_attachment', 'cached_attachment_path', 'prefetch_attachments',
  // Task 2.7: header caches, mailbox cache, Outlook uid ledger, op journal, pending operation.
  'save_email_cache', 'load_email_cache', 'load_email_cache_partial', 'load_email_cache_meta',
  'load_email_cache_by_uids', 'list_cached_uids', 'clear_email_cache',
  'save_mailbox_cache', 'load_mailbox_cache', 'delete_mailbox_cache',
  'graph_allocate_uids', 'load_graph_id_map',
  'op_journal_queue', 'op_journal_clear', 'op_journal_read',
  'read_pending_operation', 'save_pending_operation', 'clear_pending_operation',
  // Task 2.8: the six simple vault writers.
  'maildir_store', 'maildir_delete', 'maildir_set_flags', 'maildir_clear_cache',
  'maildir_migrate_json_to_eml', 'maildir_migrate_email_dirs',
  // Task 2.9b: the custody store itself now opens in the daemon, so its four
  // commands and the three vault writers that read or rewrite custody rows go
  // with it. The three `vault_*` flag commands are deliberately NOT here —
  // they stay Tauri commands because only the app can resolve the backup
  // mirror's security-scoped bookmark (spec deviation 1), and forward from
  // there.
  'local_index_read', 'local_index_append', 'local_index_remove', 'custody_status',
  'maildir_delete_many', 'maildir_repair_generation', 'maildir_purge_orphans',
  // Task 3.5: archive, bulk delete and verify move to the daemon along with
  // their cancel routes (cancel_bulk_delete is new: the old app command had
  // a single shared cancel token for both operations, N4).
  'archive_emails', 'cancel_archive', 'bulk_delete_emails', 'verify_archived_emails', 'cancel_bulk_delete',
  // Task 3.7: the snapshot store, its 300s expiry and its sweeper moved to
  // the daemon with the three commands, so the app holds no insights state
  // at all. Their failures arrive as `{ok: false, error: {...}}` (decision
  // 5) and `insightsApi.js` re-raises them.
  'insights_begin_snapshot', 'insights_read_page', 'insights_release_snapshot',
  // Task 4.2: a pure reqwest fetch, no vault/app_dir/state at all.
  'fetch_remote_asset',
  // Task 4.4: backup ZIP export/import. accounts.json stays app-only
  // (decision 2): the daemon route only reads it and returns new-account
  // descriptors for `db/accounts.js` to merge itself.
  'export_backup', 'import_backup',
  // Task 4.6: mbox export/import. import_mbox now also seeds the archived
  // flag on write (decision 3) so an imported message survives Clear cached
  // emails. The dead single-mailbox export variant was deleted, not moved.
  'export_mbox_all', 'import_mbox',
  // Task 4.8: the eight migration commands, get_folder_mappings, and the
  // three restore commands, all now daemon-owned (decision 7's run_tokens
  // registry replaces the old per-command Tauri-managed cancel/pause
  // tokens). api.js's 11 exports already route through tauriInvoke -> this
  // module's send(), so no JS call-site change was needed beyond this set.
  'start_migration', 'cancel_migration', 'pause_migration', 'resume_migration',
  'get_migration_state', 'clear_migration_state_cmd', 'count_migration_folders',
  'get_folder_mappings', 'start_restore', 'cancel_restore', 'count_local_folder',
  // Task 5.4a: the IMAP read-path (list mailboxes, page/search/status, fetch
  // headers/body). Six of these ten also run inside sync_engine.rs today
  // (list_mailboxes, fetch_emails_page, check_mailbox_status, search_all_uids,
  // fetch_headers_by_uids, fetch_changed_flags) — this is a second, one-shot
  // caller of the SAME mailvault_core::imap functions through the daemon's
  // OWN ImapPool, not a duplicate implementation, and not routed through the
  // sync loop. Same request/response JSON as the deleted Tauri commands (RPC
  // method name == old Tauri command name, unlike sync.*/llm.* above: those
  // are DAEMON_COMMANDS entries with a rename + a live Tauri fallback this
  // family cannot have, since its Tauri twin is gone). Credentials still
  // travel in the payload (`account`) — only sync.now/sync.watch (Task 5.2)
  // resolve them in the daemon.
  'imap_get_mailboxes', 'imap_get_emails', 'imap_check_mailbox_status', 'imap_folder_status',
  'imap_search_all_uids', 'imap_fetch_headers_by_uids', 'imap_fetch_changed_flags',
  'imap_get_email', 'imap_get_email_light', 'imap_search_emails',
  // Task 5.4b: the IMAP write-path + lifecycle (flags, delete, folder
  // management, Message-ID sweep, disconnect, move, test-connection). Same
  // reasoning as Task 5.4a above — their Tauri twins are deleted in the same
  // task, so this is the only fit, under their existing flat names.
  // Credentials still travel in the payload (`account`), unchanged.
  'imap_set_flags', 'imap_delete_email', 'imap_ensure_sent_mailbox', 'imap_create_mailbox',
  'imap_rename_mailbox', 'imap_delete_mailbox', 'imap_find_message_id', 'imap_disconnect',
  'imap_move_emails', 'imap_test_connection',
  // Task 5.5: SMTP (test connection, build MIME for local archive, build
  // draft MIME, send). Their Tauri twins are deleted in this same task, so
  // same reasoning as 5.4a/5.4b above — flat names, no rename layer, no
  // Tauri fallback. api.js needed zero changes: every one of these four
  // already went through tauriInvoke() -> this module's send(). The one
  // pre-existing event in this domain (`send-server-append-complete`,
  // smtp_send_email's background Sent-folder APPEND) now comes from the
  // daemon's own EventBus instead of a Tauri app_handle.emit() -- reaches
  // ComposeModal.jsx's listener unchanged, since daemon_channel.rs already
  // re-emits any named daemon event to the frontend.
  'smtp_test_connection', 'smtp_build_mime', 'smtp_build_draft_mime', 'smtp_send_email',
  // Task 5.6: Graph (list/get/cache messages, read/flag/delete, move, folder
  // management). Their Tauri twins are deleted in this same task — flat
  // names, no rename layer, no Tauri fallback, same reasoning as 5.4a/5.4b/
  // 5.5. api.js needed zero changes: all twelve already went through
  // tauriInvoke() -> this module's send(). `graph_get_mime` is deliberately
  // absent — it had 0 callers and was deleted outright, not moved.
  // `graph_allocate_uids` above (Task 2.7) is unrelated and already here.
  'graph_list_folders', 'graph_list_messages', 'graph_get_message', 'graph_cache_mime',
  'graph_set_read', 'graph_set_flagged', 'graph_delete_message', 'graph_move_emails',
  'graph_create_folder', 'graph_rename_folder', 'graph_move_folder', 'graph_delete_folder',
  // Task 5.7: OAuth2 (auth URL, code exchange, token refresh). Their Tauri
  // twins are deleted in this same task — flat names, no rename layer, no
  // Tauri fallback, same reasoning as 5.4a/5.4b/5.5/5.6. api.js needed zero
  // changes: all three already went through tauriInvoke() -> this module's
  // send(), so AccountModal.jsx, AccountSettings.jsx and authUtils.js
  // reroute automatically. The daemon now holds the ONE OAuth2Manager
  // instance (its pending-flow map must survive between auth_url and
  // exchange) and its loopback callback listener (127.0.0.1:19876) binds
  // from inside the daemon process, not the app's -- see the ledger for the
  // unverified sandboxed-bind assumption this creates.
  'oauth2_auth_url', 'oauth2_exchange', 'oauth2_refresh',
  // Task 5.8: DNS (autodiscover email server settings, post-server-change
  // health probe). Tauri twins deleted in this same task — flat names, no
  // rename layer, no Tauri fallback, same reasoning as every other Phase 5
  // family above. api.js needed no change to how it reaches the daemon --
  // resolveEmailSettings/dnsMailHealth already went through tauriInvoke ->
  // this module's send() (their `if (IS_TAURI)` guard is just the
  // web-build fallback, unrelated to daemon routing), so AccountModal.jsx
  // and ChangeServerModal.jsx reroute automatically.
  'resolve_email_settings', 'dns_mail_health',
  // Task 6: the daemon's cancel token is per-account (`DaemonState.backup_runs`
  // keyed by accountId), replacing the app's old single global
  // `BackupCancelToken` — Tauri twin deleted in this same task.
  'backup_cancel',
]);

async function sendToDaemon(command, args) {
  try {
    const realPromise = daemonCall(command, mapArgs(command, args));
    // Task 2.6: before this, a command that moved into DAEMON_OWNED had
    // previously only ever gone through `tauriInvoke` below (the one place
    // this observer hook lives), so e2e specs that watch native invokes by
    // name (`__INSIGHTS_NATIVE_OBSERVER__`, e.g. connected-insights.test.js
    // asserting `maildir_read`/`prefetch_attachments` are or are not called)
    // would silently stop seeing these calls the moment they moved here —
    // the real invoke becomes `daemon_rpc`, not the command's own name. Same
    // seam as `tauriInvoke`, applied to the daemon-owned path.
    if (import.meta.env.VITE_E2E === '1' && typeof window.__INSIGHTS_NATIVE_OBSERVER__ === 'function') {
      try {
        const barrier = window.__INSIGHTS_NATIVE_OBSERVER__(command, realPromise);
        if (barrier && typeof barrier.then === 'function') {
          return await Promise.allSettled([realPromise, barrier]).then(([native]) => {
            if (native.status === 'rejected') throw native.reason;
            return native.value;
          });
        }
      } catch { /* Observation must not change the native outcome. */ }
    }
    return await realPromise;
  } catch (e) {
    // daemonClient.js's classifier is untouched (its mapping stays
    // byte-identical for legacy DAEMON_COMMANDS callers) and is not trusted
    // here (addendum C6): its substring match on "not running"/"connection
    // refused" can mislabel a real daemon-side error (e.g. an IMAP "connection
    // refused") as DAEMON_OFFLINE. Only the two literal markers `daemon_rpc`
    // (Rust) actually returns are text-matched: `errors.daemonUnavailable`
    // for every pre-response failure, `errors.daemonOutdated` for a stale
    // accepted daemon (-32601, addendum C5) — plus NO_TAURI for a webview with
    // no Tauri bridge at all. Anything else passes through unchanged.
    if (e?.message === 'errors.daemonOutdated') {
      throw Object.assign(new Error(t('errors.daemonOutdated')), { code: 'DAEMON_OUTDATED' });
    }
    if (e?.message === 'errors.daemonUnavailable' || e?.code === 'NO_TAURI') {
      throw Object.assign(new Error(t('errors.daemonUnavailable')), { code: 'DAEMON_UNAVAILABLE' });
    }
    throw e;
  }
}

// ── Health gate ─────────────────────────────────────────────────────────────
// The daemon must respond to a heartbeat before any commands are routed to it.
// Until the heartbeat succeeds, all commands fall through to Tauri invoke.

const HEARTBEAT_TIMEOUT = 5000;       // 5s timeout for each heartbeat attempt
const HEARTBEAT_INITIAL_DELAY = 5000; // First retry after 5s
const HEARTBEAT_MAX_DELAY = 60000;    // Cap retry at 60s
const HEARTBEAT_INTERVAL = 30000;     // Re-check every 30s while connected

let _daemonAlive = false;
let _heartbeatRetryDelay = HEARTBEAT_INITIAL_DELAY;
let _heartbeatTimer = null;
let _lastHeartbeat = null; // { alive, uptime_secs, version }

/**
 * Send a heartbeat to the daemon with timeout.
 * @returns {Promise<boolean>} true if daemon responded
 */
async function sendHeartbeat() {
  try {
    const result = await Promise.race([
      daemonCall('daemon.heartbeat', {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Heartbeat timeout')), HEARTBEAT_TIMEOUT)),
    ]);

    if (result?.alive) {
      _daemonAlive = true;
      _heartbeatRetryDelay = HEARTBEAT_INITIAL_DELAY; // Reset backoff
      _lastHeartbeat = result;
      // The daemon owns the connectivity verdict — it is the process actually
      // dialling. Riding the heartbeat means the steady-state truth reaches the
      // UI without a second poll; the webview's own events cover the edges.
      if (typeof result.online === 'boolean') {
        const { useConnectivityStore } = await import('../stores/connectivityStore');
        useConnectivityStore.getState().setOnline(result.online);
      }
      console.log(`[transport] Daemon alive (v${result.version}, uptime ${result.uptime_secs}s)`);
      return true;
    }
  } catch (e) {
    _daemonAlive = false;
    console.warn(`[transport] Daemon heartbeat failed: ${e.message}`);
  }
  return false;
}

/**
 * Start the heartbeat loop. Tries once immediately, then retries with
 * exponential backoff until the daemon responds. Once connected,
 * sends periodic heartbeats to detect disconnection.
 */
function startHeartbeatLoop() {
  if (_heartbeatTimer) return; // Already running

  const tick = async () => {
    const alive = await sendHeartbeat();

    if (alive) {
      // Connected — schedule periodic check
      _heartbeatTimer = setTimeout(tick, HEARTBEAT_INTERVAL);
    } else {
      // Failed — exponential backoff retry
      _heartbeatTimer = setTimeout(tick, _heartbeatRetryDelay);
      _heartbeatRetryDelay = Math.min(_heartbeatRetryDelay * 2, HEARTBEAT_MAX_DELAY);
    }
  };

  // First attempt immediately
  tick();
}

/** Stop the heartbeat loop. */
function stopHeartbeatLoop() {
  if (_heartbeatTimer) {
    clearTimeout(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

// Start heartbeat on module load (in Tauri mode)
if (IS_TAURI) {
  startHeartbeatLoop();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a command. Routes to daemon if alive and command is migrated,
 * otherwise falls back to Tauri invoke.
 *
 * @param {string} command - Tauri command name
 * @param {object} args - command arguments
 * @returns {Promise<any>}
 */
export async function send(command, args = {}) {
  if (DAEMON_OWNED.has(command)) return sendToDaemon(command, args);

  const daemonMethod = DAEMON_COMMANDS[command];

  // Only route to daemon if heartbeat confirmed it's alive
  if (daemonMethod && _daemonAlive) {
    try {
      return await daemonCall(daemonMethod, mapArgs(command, args));
    } catch (e) {
      if (e.code === 'DAEMON_OFFLINE' || e.code === 'NO_TAURI') {
        // Daemon went down — mark as dead and trigger re-check
        _daemonAlive = false;
        _heartbeatRetryDelay = HEARTBEAT_INITIAL_DELAY;
        return tauriInvoke(command, args);
      }
      throw e;
    }
  }

  return tauriInvoke(command, args);
}

/** Get current daemon health state. */
export function getDaemonHealth() {
  return {
    alive: _daemonAlive,
    lastHeartbeat: _lastHeartbeat,
    retryDelay: _heartbeatRetryDelay,
  };
}

// The live global bridge first, the module import only as a fallback.
//
// `window.__TAURI__.core.invoke` and the `@tauri-apps/api/core` copy imported
// above are two DIFFERENT function objects: `withGlobalTauri` injects its own
// bundled api before any app JS runs, and the imported one reaches the native
// side through `window.__TAURI_INTERNALS__` without ever reading
// `window.__TAURI__`. Every other invoke site in the app (App.jsx, the settings
// panels, AttachmentBar, the hooks) reads the global live at call time, so a
// command that moves onto `send()` silently changes which of the two objects it
// travels through. That is invisible in production, where both end at the same
// bridge, but an e2e fixture that swaps the `window.__TAURI__.core` object to
// watch a command (connected-cleanup.test.js, connected-attachments.test.js)
// stops seeing the call the moment it is rerouted here. Reading the global live
// keeps a migrated call site observable exactly as the raw call it replaced,
// and it is the only bridge demo mode (src/demo/runtime.js) ever defines.
function resolveInvoke() {
  return (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) || invoke;
}

async function tauriInvoke(command, args) {
  let inv = resolveInvoke();
  if (!inv) {
    await new Promise(r => setTimeout(r, 100));
    inv = resolveInvoke();
    if (!inv) throw new Error(t('errors.tauriUnavailable'));
  }
  const realPromise = inv(command, args);
  // Native WebKit defines its invoke hook as non-writable. E2E diagnostics
  // observe the actual call here and may hold delivery of its real response.
  // Normal builds remove this branch; the hook cannot replace native data.
  if (import.meta.env.VITE_E2E === '1' && typeof window.__INSIGHTS_NATIVE_OBSERVER__ === 'function') {
    try {
      const barrier = window.__INSIGHTS_NATIVE_OBSERVER__(command, realPromise);
      if (barrier && typeof barrier.then === 'function') {
        return Promise.allSettled([realPromise, barrier]).then(([native]) => {
          if (native.status === 'rejected') throw native.reason;
          return native.value;
        });
      }
    } catch { /* Observation must not change the native outcome. */ }
  }
  return realPromise;
}
