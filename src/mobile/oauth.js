// The OAuth sign-in as the page runs it, for a new account (`oauthSignIn`) or a parked one
// (`oauthReauth`). The engine's `begin` (or `reauth`) answers a flow and the provider's sign-in
// URL; the page opens that URL in the system sign-in sheet without waiting for it, and waits on
// `mobile.oauth.finish`, which answers once the engine's loopback listener has the code (or the
// flow ended). `finish` is the authority: a sheet the user closed only asks the engine to cancel,
// and `finish` then says what happened (a code that had already arrived still adds the account).
// Once `finish` has answered, the sheet is closed and its own late answer is ignored.
//
// One flow at a time, for every entry point (add account, the banner, the switcher): a start while
// one runs answers `SIGNIN_BUSY` at once and touches nothing. `cancelOAuth()` ends the running flow
// from the page (the in-app Cancel), so a sheet whose native answer was lost never strands the user.
import { daemonCall, openAuthSheet, closeAuthSheet } from './transport.js';
import { errorCodeOf } from './errors.js';

/** The running flow: `{ flowId, url, cancelled }` (null ids until `begin` answers), or null. */
let running = null;

/** Whether a sign-in flow is running. */
export function oauthRunning() {
  return running !== null;
}

/**
 * Ends the running flow, if any: the engine cancels it (its `finish` answers `CANCELLED`) and the
 * sheet is closed. Safe to call at any time; a flow whose `begin` has not answered yet is
 * cancelled as soon as it does.
 */
export function cancelOAuth() {
  const flow = running;
  if (!flow || flow.cancelled) return;
  flow.cancelled = true;
  if (flow.flowId) daemonCall('mobile.oauth.cancel', { flowId: flow.flowId }).catch(() => {});
  closeAuthSheet(flow.url ?? undefined).catch(() => {});
}

// `start` is the call that opens the flow, so every RPC here is named literally (seam.test.js).
async function run(start) {
  if (running) return { ok: false, code: 'SIGNIN_BUSY' };
  const flow = { flowId: null, url: null, cancelled: false };
  running = flow;
  try {
    return await drive(flow, start);
  } finally {
    running = null;
  }
}

async function drive(flow, start) {
  let begun;
  try {
    begun = await start();
  } catch (err) {
    return { ok: false, code: errorCodeOf(err?.code) };
  }
  const flowId = begun?.flowId;
  if (!flowId || typeof begun.url !== 'string') return { ok: false, code: 'INTERNAL' };
  flow.flowId = flowId;
  flow.url = begun.url;
  const cancel = () => daemonCall('mobile.oauth.cancel', { flowId }).catch(() => {});
  // Cancelled from the page before `begin` answered: end it now, never show the sheet.
  if (flow.cancelled) {
    await cancel();
    return { ok: false, code: 'CANCELLED' };
  }
  let answered = false;
  let sheetCode = null;
  // Not awaited: the sheet answers only when it closes, and finish must already be waiting.
  Promise.resolve()
    .then(() => openAuthSheet(begun.url))
    .then(
      (reply) => { if (!answered && reply?.cancelled) cancel(); },
      (err) => {
        if (answered) return;
        sheetCode = { NO_APP: 'NO_BROWSER', BUSY: 'SIGNIN_BUSY' }[err?.code] || 'INTERNAL';
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
    // Named: a close that overtakes the sheet's open cancels that open (it never shows).
    closeAuthSheet(begun.url).catch(() => {});
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
