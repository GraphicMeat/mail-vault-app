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

async function tauriInvoke(command, args) {
  if (!invoke) {
    await new Promise(r => setTimeout(r, 100));
    if (!invoke) throw new Error(t('errors.tauriUnavailable'));
  }
  const realPromise = invoke(command, args);
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
