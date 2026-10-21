import { send } from './transport.js';
import { t } from '../i18n';

/**
 * Bindings for the daemon's Insights aggregation (phase 1 row 23,
 * `src-daemon/src/handlers/insights_aggregate.rs`). The daemon pages the
 * header snapshot, builds the model and answers every chart and drill-down;
 * the app only renders what comes back.
 *
 * `insights.build` answers at once and the work follows as
 * `insights-build-progress` frames (see `insightsSession.js`).
 *
 * @typedef {Object} Coverage
 * @property {'reading'|'ready'|'partial'|'stale'|'error'} status
 * @property {string} updatedAt
 * @property {Array<{accountId:string,mailbox:string,cachedHeaders:number,knownServerMessages:number|null,missingHeaders:number|null,status:string,lastSyncedAt:string|null}>} folders
 * @property {{unknownDates:number,fallbackDates:number,uncertainIdentity:number,unreadableFiles:number}} warnings
 * @property {Array<{code:string,accountId?:string,mailbox?:string}>} errors
 */

/**
 * The daemon routes answer `{ok: false, error: {code, coverage?}}` rather
 * than an RPC error, so a code (`snapshotStale`, `vaultUnavailable`,
 * `modelExpired`, ...) and the coverage to show survive the trip. This is the
 * one place that turns it back into a rejection; its message is the catalog
 * text, never the daemon's.
 */
export function insightsFailure(error = {}) {
  return Object.assign(new Error(t('insights.failed')), { code: error.code, coverage: error.coverage });
}

function unwrap(reply) {
  if (reply?.ok === false) throw insightsFailure(reply.error);
  return reply;
}

/** Starts a build of the model for `accountIds` under the caller's `buildId`. */
export async function buildInsights(buildId, { accountIds, accounts = [], ownAddressesByAccount = {} }) {
  return unwrap(await send('insights.build', {
    buildId, accountIds,
    // Only what decides "sent by you": the login and a sent-folder override.
    accounts: accounts.filter(a => a?.id).map(a => ({ id: a.id, email: a.email ?? null, sentFolderOverride: a.sentFolderOverride ?? null })),
    ownAddressesByAccount,
  }));
}

/** `{state: 'building'|'ready', loaded, total?, coverage}` of a build. */
export async function insightsStatus(buildId) {
  return unwrap(await send('insights.status', { buildId }));
}

/** Totals, senders, days and timeline lanes of a built model. */
export async function aggregateInsights(buildId, query) {
  return unwrap(await send('insights.aggregate', { buildId, query })).result;
}

/** The messages behind a selection (a day, a sender, a timeline mark). */
export async function insightsMessages(buildId, query, selection) {
  return unwrap(await send('insights.messages', { buildId, query, selection })).messages;
}

/** Drops a model, or cancels its build. Its reply is not read. */
export async function releaseInsights(buildId) {
  if (buildId) await send('insights.release', { buildId });
}
