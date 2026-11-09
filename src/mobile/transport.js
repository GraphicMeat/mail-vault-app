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

/**
 * Closes the sign-in sheet of `url` once `mobile.oauth.finish` has answered; nothing when none is
 * up. Naming the sheet lets a close that overtakes its open (the two run on separate threads)
 * cancel that open, so no sheet is left up with nobody to close it.
 */
export async function closeAuthSheet(url) {
  const invoke = requireInvoke();
  try {
    await invoke('mobile_auth_close', typeof url === 'string' ? { url } : {});
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
    const reply = await invoke('mobile_notifications_permission', { prompt: true });
    return { granted: reply?.granted === true };
  } catch (error) {
    throw shellError(error);
  }
}

// Whether notifications may be posted now, `{ granted }`, never asking: the user may have turned
// them off in the system settings since. Rejects with the shell's code: `INTERNAL`.
export async function notificationPermission() {
  const invoke = requireInvoke();
  try {
    const reply = await invoke('mobile_notifications_permission', { prompt: false });
    return { granted: reply?.granted === true };
  } catch (error) {
    throw shellError(error);
  }
}

// App Store / Google Play subscriptions. The purchase runs in native code and goes to the engine
// there (`mobile.premium.verify`), so the page never calls verify for a purchase and never sees a
// receipt: it gets the outcome and the engine's verdict, and Premium also arrives as
// `mobile.premium.changed`. Rejects carry the shell's code: `INVALID` (not our product), `BUSY`
// (another purchase or Restore runs), `UNAVAILABLE` (no store, not signed in, offline),
// `NOT_FOUND` (the store does not offer it), `OWNED` (Play: already subscribed, Restore instead),
// `UNSUPPORTED`, `INTERNAL`.

const STORE_STATUSES = ['purchased', 'pending', 'cancelled'];

/** `{ premium, source, expiresMs }` or `{ code }`: the engine's verdict on one receipt. */
function storeVerdict(item) {
  if (item?.premium && typeof item.premium === 'object') {
    const p = item.premium;
    return { premium: { premium: p.premium === true, source: p.source ?? null, expiresMs: p.expiresMs ?? null } };
  }
  if (item?.error && typeof item.error.code === 'string') return { error: { code: item.error.code } };
  return {};
}

/**
 * Both subscriptions as the store offers them: `[{ id, title, price, period: 'P1M'|'P1Y',
 * introOffer? }]`, `price` the store's own localized string (never a hard-coded price). Monthly
 * first; one the store does not offer is missing.
 */
export async function storeProducts() {
  const invoke = requireInvoke();
  let reply;
  try {
    reply = await invoke('mobile_store_products');
  } catch (error) {
    throw shellError(error);
  }
  return (Array.isArray(reply) ? reply : []).map((p) => {
    const item = { id: p.id, title: p.title, price: p.price, period: p.period };
    if (p.introOffer) {
      const o = p.introOffer;
      item.introOffer = { price: o.price, period: o.period, paymentMode: o.paymentMode, periodCount: o.periodCount };
    }
    return item;
  });
}

/**
 * Buys `productId`. Answers `{ status: 'purchased'|'pending'|'cancelled', platform, productId }`;
 * `purchased` adds the verdict: `premium` (`{ premium, source, expiresMs }`) or `error: { code }`
 * (`NETWORK` / `RATE_LIMITED`: paid, checked again at the next launch; `REFUSED`; `UNVERIFIED`).
 * `pending` waits for approval (Ask to Buy, a slow payment); Premium follows by event.
 */
export async function storePurchase(productId) {
  const invoke = requireInvoke();
  let reply;
  try {
    reply = await invoke('mobile_store_purchase', { productId });
  } catch (error) {
    throw shellError(error);
  }
  const status = STORE_STATUSES.includes(reply?.status) ? reply.status : 'cancelled';
  const out = { status, platform: reply?.platform ?? null, productId: reply?.productId ?? productId };
  return status === 'purchased' ? { ...out, ...storeVerdict(reply) } : out;
}

/**
 * Restore Purchases: one item per subscription the store account holds, `[{ platform, productId,
 * premium | error: { code } }]` (`INSTALL_LIMIT`: already on its most devices); `[]` for none.
 */
export async function storeRestore() {
  const invoke = requireInvoke();
  let reply;
  try {
    reply = await invoke('mobile_store_restore');
  } catch (error) {
    throw shellError(error);
  }
  return (Array.isArray(reply) ? reply : []).map((item) => ({
    platform: item.platform,
    productId: item.productId,
    ...storeVerdict(item),
  }));
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
