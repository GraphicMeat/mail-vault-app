/**
 * Transport layer — routes commands to daemon (via socket) or Tauri (via invoke).
 *
 * Health gate: on startup, sends a heartbeat to the daemon with 5s timeout.
 * If it fails, retries with exponential backoff (5s → 10s → 20s → 40s → 60s cap).
 * All daemon-routed commands fall back to Tauri invoke until the heartbeat succeeds.
 * Once connected, periodic heartbeats keep the state fresh.
 */

import { daemonCall } from './daemonClient.js';

const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;

let invoke = null;
if (IS_TAURI) {
  import('@tauri-apps/api/core').then(mod => { invoke = mod.invoke; }).catch(() => {});
}

// ── Daemon command registry ─────────────────────────────────────────────────

const DAEMON_COMMANDS = {
  // Maildir — only route commands whose response shapes match between daemon and Tauri.
  // maildir_list excluded: daemon returns {uids, count}, Tauri returns MaildirEmailSummary[]
  // maildir_read/read_light/read_light_batch excluded: different response shapes
  'maildir_store': 'maildir.store',
  'maildir_exists': 'maildir.exists',
  'maildir_delete': 'maildir.delete',
  'maildir_storage_stats': 'maildir.storage_stats',

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

/** Force an immediate heartbeat check. */
export async function checkDaemonNow() {
  return sendHeartbeat();
}

/** Reset and restart the heartbeat loop (e.g. after daemon restart). */
export function resetDaemonCache() {
  _daemonAlive = false;
  _heartbeatRetryDelay = HEARTBEAT_INITIAL_DELAY;
  _lastHeartbeat = null;
  stopHeartbeatLoop();
  startHeartbeatLoop();
}

async function tauriInvoke(command, args) {
  if (!invoke) {
    await new Promise(r => setTimeout(r, 100));
    if (!invoke) throw new Error('Tauri invoke not available');
  }
  return invoke(command, args);
}
