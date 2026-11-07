// Mobile RPC transport. The mobile shell answers the `daemon_rpc` Tauri command with the
// engine's reply, or rejects with the engine's `RpcError` object `{ code, message, data? }`.
// Deliberately free of desktop `daemonClient.js`, which lazy-loads the desktop settings store
// (for `daemonMode`) and with it the whole desktop module graph.

export class DaemonError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'DaemonError';
    this.code = code;
    // What the code needs to be explained (`TOO_LARGE`: `{ limitBytes }`).
    if (data !== undefined) this.data = data;
  }
}

// `withGlobalTauri` is on in the mobile shell, so the global bridge is the transport.
function resolveInvoke() {
  return (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) || null;
}

/** A rejection of the shell, `{ code, message }` or a string, as a `DaemonError`. */
function shellError(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return new DaemonError(error.message || error.code, error.code, error.data ?? undefined);
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

// The system picker for outgoing attachments: `kind` is 'files' (the document picker) or 'photos'
// (the photo picker, no library permission). The shell copies each pick into its cache and answers
// a handle relative to the cache dir, never a path: `{ handle, name, size, mime }`, or
// `{ name, error: 'UNREADABLE' }` for a pick it could not read in full. Cancel is `[]`. Only the
// listed fields are passed on. Rejects with the shell's code: `BUSY`, `NO_APP`, `INVALID`,
// `INTERNAL`.
export async function pickFiles(kind) {
  const invoke = requireInvoke();
  let reply;
  try {
    reply = await invoke('mobile_pick_files', { kind });
  } catch (error) {
    throw shellError(error);
  }
  return (Array.isArray(reply) ? reply : []).map((item) => (
    typeof item?.error === 'string'
      ? { name: item.name, error: item.error }
      : { handle: item.handle, name: item.name, size: item.size, mime: item.mime }
  ));
}

// The system sign-in sheet for an OAuth flow (iOS ASWebAuthenticationSession, Android a Custom
// Tab). `url` is the one `mobile.oauth.begin` / `.reauth` answered; the shell opens only Google's
// and Microsoft's sign-in hosts. The provider hands its code to the engine, never to the page, so
// the caller does not wait on this for the code: it answers `{ cancelled }` when the sheet closes
// (`true` when the user closed it). Rejects with the shell's code: `INVALID`, `BUSY`, `NO_APP`,
// `INTERNAL`. See oauth.js for the whole flow.
export async function openAuthSheet(url) {
  const invoke = requireInvoke();
  let reply;
  try {
    reply = await invoke('mobile_auth_open', { url });
  } catch (error) {
    throw shellError(error);
  }
  return { cancelled: reply?.cancelled === true };
}

/** Closes the sign-in sheet once `mobile.oauth.finish` has answered; nothing when none is up. */
export async function closeAuthSheet() {
  const invoke = requireInvoke();
  try {
    await invoke('mobile_auth_close');
  } catch (error) {
    throw shellError(error);
  }
}

// A tapped new-mail notification, `{ accountId, folder, uid? }` (`uid` absent for a summary), or
// null. The shell holds the latest tap until it is taken, so the page asks on mount (a cold
// launch's tap came before it) and on each `mobile.notification.open`; each tap is answered once.
// Only the listed fields are passed on. Rejects with the shell's code: `INTERNAL`.
export async function takeNotificationTap() {
  const invoke = requireInvoke();
  let tap;
  try {
    tap = await invoke('mobile_notification_take');
  } catch (error) {
    throw shellError(error);
  }
  if (!tap || typeof tap.accountId !== 'string' || typeof tap.folder !== 'string') return null;
  return Number.isInteger(tap.uid)
    ? { accountId: tap.accountId, folder: tap.folder, uid: tap.uid }
    : { accountId: tap.accountId, folder: tap.folder };
}

// The system's notification permission prompt (iOS; Android 13 and later), answered
// `{ granted }`. Turning notifications on in Settings asks this first. Rejects with the shell's
// code: `INTERNAL`.
export async function requestNotificationPermission() {
  const invoke = requireInvoke();
  try {
    const reply = await invoke('mobile_notifications_permission');
    return { granted: reply?.granted === true };
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
