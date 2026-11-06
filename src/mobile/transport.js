// Mobile RPC transport. The mobile shell answers the `daemon_rpc` Tauri command with the
// engine's reply, or rejects with the engine's `RpcError` object `{ code, message }`.
// Deliberately free of desktop `daemonClient.js`, which lazy-loads the desktop settings store
// (for `daemonMode`) and with it the whole desktop module graph.

export class DaemonError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
  }
}

// `withGlobalTauri` is on in the mobile shell, so the global bridge is the transport.
function resolveInvoke() {
  return (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) || null;
}

export async function daemonCall(method, params = {}) {
  const invoke = resolveInvoke();
  if (!invoke) throw new DaemonError('Tauri invoke not available', 'NO_TAURI');
  try {
    return await invoke('daemon_rpc', { method, params });
  } catch (error) {
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      throw new DaemonError(error.message || error.code, error.code);
    }
    const message = typeof error === 'string' ? error : error?.message || 'Unknown daemon error';
    throw new DaemonError(message, 'RPC_ERROR');
  }
}
