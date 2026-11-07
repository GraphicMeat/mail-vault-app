// The OAuth sign-in as the page runs it, for a new account (`oauthSignIn`) or a parked one
// (`oauthReauth`). The engine's `begin` (or `reauth`) answers a flow and the provider's sign-in
// URL; the page opens that URL in the system sign-in sheet without waiting for it, and waits on
// `mobile.oauth.finish`, which answers once the engine's loopback listener has the code (or the
// flow ended). `finish` is the authority: a sheet the user closed only asks the engine to cancel,
// and `finish` then says what happened (a code that had already arrived still adds the account).
// Once `finish` has answered, the sheet is closed and its own late answer is ignored.
import { daemonCall, openAuthSheet, closeAuthSheet } from './transport.js';
import { errorCodeOf } from './errors.js';

// `start` is the call that opens the flow, so every RPC here is named literally (seam.test.js).
async function run(start) {
  let flow;
  try {
    flow = await start();
  } catch (err) {
    return { ok: false, code: errorCodeOf(err?.code) };
  }
  const flowId = flow?.flowId;
  if (!flowId || typeof flow.url !== 'string') return { ok: false, code: 'INTERNAL' };
  let answered = false;
  let sheetCode = null;
  const cancel = () => daemonCall('mobile.oauth.cancel', { flowId }).catch(() => {});
  // Not awaited: the sheet answers only when it closes, and finish must already be waiting.
  Promise.resolve()
    .then(() => openAuthSheet(flow.url))
    .then(
      (reply) => { if (!answered && reply?.cancelled) cancel(); },
      (err) => {
        if (answered) return;
        sheetCode = err?.code === 'NO_APP' ? 'NO_BROWSER' : 'INTERNAL';
        cancel();
      },
    );
  let reply;
  try {
    reply = await daemonCall('mobile.oauth.finish', { flowId });
  } catch (err) {
    reply = { ok: false, code: err?.code };
  } finally {
    answered = true;
    closeAuthSheet().catch(() => {});
  }
  if (reply?.ok) return { ok: true, account: reply.account };
  // A sheet that never opened explains the cancel better than CANCELLED.
  if (sheetCode && reply?.code === 'CANCELLED') return { ok: false, code: sheetCode };
  return { ok: false, code: errorCodeOf(reply?.code) };
}

/** Signs a new account in with `provider` (`google` | `microsoft`). `{ok, account}` or `{ok: false, code}`. */
export function oauthSignIn(provider) {
  return run(() => daemonCall('mobile.oauth.begin', { provider }));
}

/** Signs a parked (`needsAuth`) account in again. Same answer as `oauthSignIn`. */
export function oauthReauth(accountId) {
  return run(() => daemonCall('mobile.oauth.reauth', { accountId }));
}
