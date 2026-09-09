import { buildInsightsModel, queryInsights, matchingInsightsMessages } from '../utils/insights/model.js';

/** Each worker owns one replaceable model; responses always retain request IDs. */
export function createInsightsWorkerHandler(postMessage) {
  let model = null, staging = null;
  return ({ data }) => {
    const { type, requestId } = data || {};
    let reply;
    try {
      if (type === 'build') {
        // Publish only after successful normalization, retaining the prior
        // snapshot if a refresh brings unreadable/malformed inventory.
        const nextModel = buildInsightsModel(data.copies, {
          accounts: data.accounts, ownAddressesByAccount: data.ownAddressesByAccount,
        });
        model = nextModel;
        reply = { type: 'built', requestId, payload: null };
      } else if (type === 'build-start') {
        staging = { buildId: requestId, copies: [], options: { accounts: data.accounts, ownAddressesByAccount: data.ownAddressesByAccount } };
        reply = { type: 'build-started', requestId, payload: { buildId: requestId } };
      } else if (type === 'build-append') {
        if (!staging || staging.buildId !== data.buildId) throw Object.assign(new Error('Obsolete Insights build'), { code: 'obsolete-build' });
        if (!Array.isArray(data.copies) || data.copies.length > 1000) throw Object.assign(new Error('Insights build chunk is too large'), { code: 'invalid-build-chunk' });
        staging.copies.push(...data.copies);
        reply = { type: 'build-appended', requestId, payload: { buildId: staging.buildId, count: data.copies.length } };
      } else if (type === 'build-commit') {
        if (!staging || staging.buildId !== data.buildId) throw Object.assign(new Error('Obsolete Insights build'), { code: 'obsolete-build' });
        const nextModel = buildInsightsModel(staging.copies, staging.options);
        model = nextModel; staging = null;
        reply = { type: 'built', requestId, payload: { buildId: data.buildId } };
      } else if (type !== 'query' && type !== 'messages') {
        reply = { type: 'error', requestId, payload: {
          code: 'unknown-request', message: 'Unknown Insights worker request',
        } };
      } else if (!model) {
        reply = { type: 'error', requestId, payload: {
          code: 'not-built', message: 'Insights model is not ready',
        } };
      } else {
        reply = { type: type === 'query' ? 'result' : 'messages', requestId,
          payload: type === 'query' ? queryInsights(model, data.query)
            : matchingInsightsMessages(model, data.query, data.selection) };
      }
    } catch (error) {
      reply = { type: 'error', requestId, payload: {
        code: error?.code || ((type === 'build' || type === 'build-commit') ? 'build-failed' : 'invalid-query'),
        message: error instanceof Error ? error.message : 'Insights worker request failed',
      } };
    }
    postMessage(reply);
  };
}

// Importing the factory in a normal page/test must not take over its messages.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.addEventListener('message', createInsightsWorkerHandler(reply => globalThis.postMessage(reply)));
}
