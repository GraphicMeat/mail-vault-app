import { send } from './transport.js';

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

/** @returns {Promise<{snapshotId:string,inventoryCount:number,coverage:Coverage}>} */
export async function beginInsightsSnapshot(accountIds, { signal } = {}) {
  throwIfAborted(signal);
  const snapshot = await send('insights_begin_snapshot', { accountIds });
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
  const page = await send('insights_read_page', { snapshotId, cursor });
  throwIfAborted(signal);
  return page;
}

export async function releaseInsightsSnapshot(snapshotId) {
  if (snapshotId) await send('insights_release_snapshot', { snapshotId });
}
