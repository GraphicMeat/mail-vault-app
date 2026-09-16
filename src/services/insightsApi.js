import { send } from './transport.js';
import { t } from '../i18n';

/**
 * Physical header copy. No body, attachment content, credentials, or disk paths.
 * @typedef {Object} HeaderCopy
 * @property {string} accountId
 * @property {string} mailbox Real mailbox path when resolved; otherwise a local display name.
 * @property {number} uid
 * @property {number|null} uidValidity Unknown generations remain null.
 * @property {'server-cache'|'vault'} source
 * @property {string|null} origin Preserves local_sent/local_draft.
 * @property {string|null} messageId
 * @property {{address:string,name:string|null}} from
 * @property {Array<{address:string,name:string|null}>} to
 * @property {Array<{address:string,name:string|null}>} cc
 * @property {Array<{address:string,name:string|null}>} bcc
 * @property {string} subject
 * @property {string|null} messageDate Original RFC Date, normalized to ISO.
 * @property {string|null} receivedAt Receive event (including an explicitly labeled fallback).
 * @property {string|null} sentAt Send event (including an explicitly labeled fallback).
 * @property {{received:string,sent:string}} dateEvidence
 * @property {string[]} flags
 * @property {string|null} specialUse
 * @property {string|null} listId
 * @property {string|null} listUnsubscribe
 * @property {string|null} precedence
 * @property {boolean} serverDeleted
 * @property {boolean} serverAbsent
 * @property {string|null} localMailbox Verified Tauri vault mailbox locator, never an absolute path.
 * @property {string|null} locationLimitation 'server-mailbox-unresolved' disables server actions.
 */
/**
 * @typedef {Object} Coverage
 * @property {'reading'|'ready'|'partial'|'stale'|'error'} status
 * @property {string} updatedAt
 * @property {Array<{accountId:string,mailbox:string,cachedHeaders:number,knownServerMessages:number|null,missingHeaders:number|null,status:string,lastSyncedAt:string|null}>} folders
 * @property {{unknownDates:number,fallbackDates:number,uncertainIdentity:number,unreadableFiles:number}} warnings
 * @property {Array<{code:string,accountId?:string,mailbox?:string}>} errors
 */

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('The header scan was cancelled.', 'AbortError');
}

/**
 * Task 3.7. The snapshot routes live in the daemon now, and `daemon_rpc`'s
 * reply channel is `Result<Value, String>`: it cannot carry the structured
 * `{code, coverage}` failure the deleted Tauri commands returned as an
 * `Err(Value)`. The routes answer `Ok({ok: false, error: {...}})` instead
 * (the shape `search_index_destroy` already uses), and this is the one place
 * that turns it back into the rejection `insightsSession.js` reads: the
 * `code` decides whether a stale snapshot is retried, the `coverage` is what
 * the UI finally reports.
 *
 * Only an explicit `ok: false` is a failure. `src/demo/backend.js` answers
 * these three names with today's bare object and no `ok` key at all, so a
 * falsy-`ok` test would break demo mode instead.
 */
function unwrap(reply) {
  if (reply?.ok !== false) return reply;
  const { code, coverage } = reply.error || {};
  throw Object.assign(new Error(t('insights.failed')), { code, coverage });
}

/** @returns {Promise<{snapshotId:string,inventoryCount:number,coverage:Coverage}>} */
export async function beginInsightsSnapshot(accountIds, { signal } = {}) {
  throwIfAborted(signal);
  const snapshot = unwrap(await send('insights_begin_snapshot', { accountIds }));
  if (signal?.aborted) {
    // Native inventory may finish after the component has gone away.
    await releaseInsightsSnapshot(snapshot.snapshotId);
    throwIfAborted(signal);
  }
  return snapshot;
}

/** @returns {Promise<{rows:HeaderCopy[],nextCursor:string|null,coverage:Coverage}>} */
export async function readInsightsPage(snapshotId, cursor = null, { signal } = {}) {
  throwIfAborted(signal);
  const page = unwrap(await send('insights_read_page', { snapshotId, cursor }));
  throwIfAborted(signal);
  return page;
}

/**
 * Deliberately not unwrapped. Its reply is discarded, and the abort path in
 * `beginInsightsSnapshot` above releases before re-checking the signal: a
 * throw here would replace that AbortError with a release failure.
 */
export async function releaseInsightsSnapshot(snapshotId) {
  if (snapshotId) await send('insights_release_snapshot', { snapshotId });
}
