/**
 * Helper Client — communicates with the mailvault-daemon background helper.
 *
 * In Tauri mode, requests are proxied through a Tauri invoke command that
 * connects to the helper's Unix socket (in the App Group container on macOS).
 * The Tauri binary handles socket management and token authentication.
 *
 * This module provides the same interface as direct invoke() calls so existing
 * services can migrate incrementally by swapping tauriInvoke → daemonCall.
 */

const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;

let invoke = null;

const invokeReady = IS_TAURI
  ? import('@tauri-apps/api/core').then(mod => {
      invoke = mod.invoke;
    }).catch(err => {
      console.error('[daemonClient] Failed to load Tauri invoke:', err);
    })
  : Promise.resolve();

// The live global bridge first, the module import only as a fallback — same
// fix as transport.js's `resolveInvoke()` (`c85770c1`), and the same reason:
// `window.__TAURI__.core.invoke` and the `@tauri-apps/api/core` copy imported
// above are two DIFFERENT function objects (`withGlobalTauri` injects its own
// bundled api before any app JS runs; the imported one reaches the native
// side through `window.__TAURI_INTERNALS__` without ever reading
// `window.__TAURI__`). An e2e fixture that swaps `window.__TAURI__.core` to
// observe a call (connected-cleanup.test.js, connected-attachments.test.js)
// never sees one that went through the frozen ESM import — this was the
// identical bug transport.js had, just not yet fixed here.
function resolveInvoke() {
  return (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) || invoke;
}

/**
 * Send a JSON-RPC request to the daemon via Tauri proxy.
 *
 * @param {string} method - JSON-RPC method name (e.g. "maildir.list")
 * @param {object} params - method parameters
 * @returns {Promise<any>} - the result field from the JSON-RPC response
 * @throws {DaemonError} on connection failure, auth failure, or RPC error
 */
export async function daemonCall(method, params = {}) {
  await invokeReady;
  const inv = resolveInvoke();
  if (!inv) throw new DaemonError('Tauri invoke not available', 'NO_TAURI');

  try {
    // Pass daemonMode so the Rust proxy knows whether to auto-spawn
    let daemonMode;
    try {
      const { useSettingsStore } = await import('../stores/settingsStore');
      daemonMode = useSettingsStore.getState().daemonMode;
    } catch { /* settings unavailable — use default */ }

    // The Tauri command handles socket connection, auth, and JSON-RPC framing
    const result = await inv('daemon_rpc', { method, params, daemonMode });
    return result;
  } catch (error) {
    const message = typeof error === 'string' ? error : error.message || 'Unknown daemon error';

    if (message.includes('not running') || message.includes('connection refused')) {
      throw new DaemonError(message, 'DAEMON_OFFLINE');
    }
    if (message.includes('auth')) {
      throw new DaemonError(message, 'AUTH_FAILED');
    }
    throw new DaemonError(message, 'RPC_ERROR');
  }
}

/**
 * Check if the daemon is reachable and authenticated.
 * @returns {Promise<boolean>}
 */
export async function isDaemonAvailable() {
  try {
    await daemonCall('ping');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get daemon status including version and uptime.
 * @returns {Promise<{ version: string, uptime_secs: number, data_dir: string }>}
 */
export async function getDaemonStatus() {
  return daemonCall('daemon.status');
}

export class DaemonError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
  }
}
