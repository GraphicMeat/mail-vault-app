/**
 * Learned classification rules: thin bindings to the daemon's `learning.*`
 * RPCs (src-daemon/src/handlers/learning.rs, logic in
 * src-core/src/learning.rs). The daemon records corrections, learns rules,
 * keeps them per account and exports or imports them.
 */

import { send } from './transport.js';
import { t } from '../i18n/index.js';

// What the rules panel shows when the daemon cannot be read.
const NO_STATS = { totalClassified: 0, totalCorrected: 0, accuracyRate: 1.0, rulesCount: 0, correctionsCount: 0 };

/**
 * Record a user's correction; the daemon may learn a rule from it.
 * @returns {Promise<{ correctionSaved: boolean, ruleGenerated: boolean, rule: object|null }>}
 */
export function recordCorrection(accountId, email, correction) {
  return send('learning.record_correction', { accountId, email, correction });
}

export async function getRules(accountId) {
  try {
    return await send('learning.rules', { accountId });
  } catch {
    return [];
  }
}

export async function getStats(accountId) {
  try {
    return await send('learning.stats', { accountId });
  } catch {
    return { ...NO_STATS };
  }
}

/**
 * Add a rule, or update the one with the same `id`. The daemon refuses a
 * domain rule for a shared provider such as gmail.com.
 * @returns {Promise<{ saved: boolean, error: string|null }>}
 */
export async function saveRule(accountId, rule) {
  const reply = await send('learning.save_rule', { accountId, rule });
  if (reply?.saved === false) {
    return { saved: false, error: t(reply.errorKey, reply.errorParams ?? undefined) };
  }
  return { saved: true, error: null };
}

export function deleteRule(accountId, ruleId) {
  return send('learning.delete_rule', { accountId, ruleId });
}

/**
 * The anonymized rules export (no addresses, names or account ids).
 * @returns {Promise<{ payload: object, json: string }>} `json` is the file text.
 */
export function exportRules(accountId) {
  return send('learning.export', { accountId });
}

/**
 * Import a rules file the user picked. The app parses the text; the daemon
 * checks it and adds the rules the account does not already have.
 * @returns {Promise<{ valid: boolean, imported: number, error: string|null }>}
 *   `error` can be set on a valid file too: rules it left out.
 */
export async function importRulesFile(accountId, text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { valid: false, imported: 0, error: t('svc.ruleExporter.parseError', { e: e.message }) };
  }
  const reply = await send('learning.import', { accountId, data });
  if (!reply?.valid) {
    return { valid: false, imported: 0, error: t(reply?.errorKey, reply?.errorParams ?? undefined) };
  }
  // Valid, but some rules were left out (a shared provider's domain).
  const error = reply.errorKey ? t(reply.errorKey, reply.errorParams ?? undefined) : null;
  return { valid: true, imported: reply.imported, error };
}
