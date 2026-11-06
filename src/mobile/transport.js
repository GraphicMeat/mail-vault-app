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

// Engine events reach the page as one Tauri event, `mobile-event` `{ name, payload }`. This is the
// only place mobile code subscribes; `handler` gets the payload of events called `name`. Returns
// the unsubscribe, safe to call twice or before the bridge has answered.
export function listen(name, handler) {
  const bridge = typeof window !== 'undefined' && window.__TAURI__?.event?.listen;
  if (!bridge) throw new DaemonError('Tauri event bridge not available', 'NO_TAURI');
  let detach = null;
  let stopped = false;
  bridge('mobile-event', (event) => {
    const message = event?.payload;
    if (!stopped && message && message.name === name) handler(message.payload);
  }).then(
    (unlisten) => { if (stopped) unlisten(); else detach = unlisten; },
    () => {},
  );
  return () => {
    stopped = true;
    if (detach) { detach(); detach = null; }
  };
}
