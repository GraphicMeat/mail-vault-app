/**
 * LLM Service — manages the local AI model via the daemon.
 *
 * Handles model download, status checks, and email classification.
 * All inference runs on the user's machine through the daemon process.
 */

import { daemonCall } from './daemonClient.js';

/**
 * Get the overall LLM engine status.
 * @returns {Promise<{ status: string, active_model: string|null, download: object|null, models_dir: string }>}
 */
export async function getStatus() {
  return daemonCall('llm.status');
}

/**
 * List available models with their download status.
 * @returns {Promise<Array<{ id, name, size_bytes, downloaded, active, recommended }>>}
 */
export async function listModels() {
  return daemonCall('llm.list_models');
}

/**
 * Start downloading a model. Returns immediately — poll getStatus() for progress.
 * @param {string} modelId - e.g. "llama3.1-8b"
 * @returns {Promise<{ started: boolean, modelId: string }>}
 */
export async function downloadModel(modelId) {
  return daemonCall('llm.download', { modelId });
}

/**
 * Cancel an in-progress model download.
 * @returns {Promise<{ cancelled: boolean }>}
 */
export async function cancelDownload() {
  return daemonCall('llm.cancel_download');
}

/**
 * Delete a downloaded model to free disk space.
 * @param {string} modelId
 * @returns {Promise<{ deleted: boolean }>}
 */
export async function deleteModel(modelId) {
  return daemonCall('llm.delete_model', { modelId });
}

/**
 * Classify a batch of emails using the local LLM.
 * @param {Array<{ uid, subject, from, date, bodyPreview }>} emails
 * @returns {Promise<Array<{ uid, category, importance, action, confidence }>>}
 */
export async function classifyEmails(emails) {
  return daemonCall('llm.classify', { emails });
}
