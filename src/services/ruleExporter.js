/**
 * Rule Exporter — anonymized export and import of learned classification rules.
 *
 * Exports contain ONLY domain patterns, subject keywords, and action preferences.
 * No email addresses, names, message content, or account IDs are included.
 */

import { getRules } from './learningService.js';

const EXPORT_VERSION = 1;

/**
 * Export learned rules as an anonymized JSON object.
 * Ready to be saved to a file by the caller.
 *
 * @param {string} accountId
 * @returns {Promise<object>} - the export payload
 */
export async function exportRules(accountId) {
  const rules = await getRules(accountId);

  const anonymized = rules.map(rule => ({
    type: rule.type,
    pattern: anonymizePattern(rule.pattern),
    category: rule.category,
    importance: rule.importance,
    action: rule.action,
    confidence: rule.confidence,
  }));

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    rulesCount: anonymized.length,
    rules: anonymized,
  };
}

/**
 * Validate and preview an imported rules file.
 * Does NOT apply the rules — just parses and returns them for user review.
 *
 * @param {string} jsonString - raw file contents
 * @returns {{ valid: boolean, rules: Array, error?: string }}
 */
export function previewImport(jsonString) {
  try {
    const data = JSON.parse(jsonString);

    if (!data.version || !Array.isArray(data.rules)) {
      return { valid: false, rules: [], error: 'Invalid format: missing version or rules array' };
    }

    if (data.version > EXPORT_VERSION) {
      return { valid: false, rules: [], error: `Unsupported format version ${data.version} (this app supports v${EXPORT_VERSION})` };
    }

    const rules = data.rules
      .filter(r => r.pattern && r.type)
      .map(r => ({
        type: r.type,
        pattern: r.pattern,
        category: r.category || null,
        importance: r.importance || null,
        action: r.action || null,
        confidence: r.confidence || 0.8,
      }));

    return { valid: true, rules, error: null };
  } catch (e) {
    return { valid: false, rules: [], error: `Parse error: ${e.message}` };
  }
}

/**
 * Import selected rules into the learning feedback for an account.
 *
 * @param {string} accountId
 * @param {Array} rules - rules selected by the user from previewImport
 * @param {Function} saveFeedbackFn - the daemonCall-based save function
 * @returns {Promise<number>} - count of rules imported
 */
export async function importRules(accountId, rules, loadFn, saveFn) {
  const feedback = await loadFn(accountId);

  let imported = 0;
  for (const rule of rules) {
    // Check for duplicates
    const exists = feedback.rules.some(r =>
      r.pattern.fromDomain === rule.pattern.fromDomain &&
      r.category === rule.category &&
      r.action === rule.action
    );

    if (!exists) {
      feedback.rules.push({
        id: `r-imp-${Date.now()}-${imported}`,
        ...rule,
        learnedFrom: 0,
        createdAt: new Date().toISOString(),
        source: 'imported',
      });
      imported++;
    }
  }

  if (imported > 0) {
    await saveFn(accountId, feedback);
  }

  return imported;
}

/**
 * Strip any potentially identifying data from a pattern.
 * Only keep domain names and keyword fragments.
 */
function anonymizePattern(pattern) {
  const clean = {};
  if (pattern.fromDomain) clean.fromDomain = pattern.fromDomain;
  if (pattern.subjectContains) clean.subjectContains = pattern.subjectContains;
  // Intentionally exclude fromAddress — too identifying
  return clean;
}
