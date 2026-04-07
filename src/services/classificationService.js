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
 * Get classification pipeline progress.
 * @returns {Promise<{ account_id, status, classified, total, skipped_by_rules }>}
 */
export async function getStatus() {
  return daemonCall('classification.status');
}
