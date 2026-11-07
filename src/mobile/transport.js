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

/** A rejection of the shell, `{ code, message }` or a string, as a `DaemonError`. */
function shellError(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return new DaemonError(error.message || error.code, error.code);
  }
  const message = typeof error === 'string' ? error : error?.message || 'Unknown daemon error';
  return new DaemonError(message, 'RPC_ERROR');
}

function requireInvoke() {
  const invoke = resolveInvoke();
  if (!invoke) throw new DaemonError('Tauri invoke not available', 'NO_TAURI');
  return invoke;
}

export async function daemonCall(method, params = {}) {
  const invoke = requireInvoke();
  try {
    return await invoke('daemon_rpc', { method, params });
  } catch (error) {
    throw shellError(error);
  }
}

// The shell's two file commands. `path` must be one `mobile.attachment.local` just answered; the
// shell checks it is a file of the attachment cache and gives the previewer a named copy.
// `name` and `mime` are the attachment's metadata. Rejects with the shell's code: `GONE` (evicted:
// fetch again), `NO_APP`, `BUSY`, `INVALID`, `INTERNAL`.

/** The system previewer (QuickLook on iOS, the default viewer on Android). */
export async function openFile({ path, name, mime }) {
  const invoke = requireInvoke();
  try {
    return await invoke('mobile_open_file', { path, name, mime });
  } catch (error) {
    throw shellError(error);
  }
}

/** The system share sheet. */
export async function shareFile({ path, name, mime }) {
  const invoke = requireInvoke();
  try {
    return await invoke('mobile_share_file', { path, name, mime });
  } catch (error) {
    throw shellError(error);
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
