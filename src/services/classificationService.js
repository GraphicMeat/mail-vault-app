/**
 * Classification Service — manages email classification via the daemon.
 *
 * Provides access to classification results, summaries, and user overrides.
 * The actual classification pipeline runs in the daemon process.
 */

import { daemonCall } from './daemonClient.js';

/**
 * Get classification summary for an account (counts by category/action/importance).
 * @param {string} accountId
 * @returns {Promise<{ total, by_category, by_action, by_importance }>}
 */
export async function getSummary(accountId) {
  return daemonCall('classification.summary', { accountId });
}

/**
 * Get all classification results, or filtered by category.
 * @param {string} accountId
 * @param {string} [category] - optional category filter
 * @returns {Promise<Array|Object>}
 */
export async function getResults(accountId, category) {
  const params = { accountId };
  if (category) params.category = category;
  return daemonCall('classification.results', params);
}

/**
 * Override a classification (user correction).
 * @param {string} accountId
 * @param {string} messageId
 * @param {{ category?, importance?, action? }} overrides
 * @returns {Promise<Object>} - updated classification
 */
export async function overrideClassification(accountId, messageId, overrides) {
  return daemonCall('classification.override', {
    accountId,
    messageId,
    ...overrides,
  });
}

/**
 * Trigger classification pipeline for an account.
 * @param {string} accountId
 * @returns {Promise<{ started: boolean }>}
 */
export async function run(accountId) {
  return daemonCall('classification.run', { accountId });
}

/**
 * Cancel a running classification pipeline.
 * @returns {Promise<{ cancelled: boolean }>}
 */
export async function cancel() {
  return daemonCall('classification.cancel');
}

/**
 * Reclassify all emails for an account: retrains the model and re-queues everything.
 * Preserves user overrides.
 * @param {string} accountId
 * @returns {Promise<{ started: boolean }>}
 */
export async function reclassifyAll(accountId) {
  return daemonCall('classification.reclassify_all', { accountId });
}

/**
 * Get classification pipeline progress.
 * @returns {Promise<{ account_id, status, classified, total, skipped_by_rules, queue_depth, phase }>}
 * phase is "new" | "backfill" | "idle"
 */
export async function getStatus() {
  return daemonCall('classification.status');
}
