/**
 * Learning Service — captures user corrections and extracts rules.
 *
 * When a user overrides a classification, the correction is recorded.
 * After enough corrections for the same pattern (sender domain, subject keyword),
 * a local rule is auto-generated. Rules are applied before LLM inference,
 * making classification faster and more consistent over time.
 */

import { daemonCall } from './daemonClient.js';

const RULE_THRESHOLD = 3; // Corrections needed before auto-generating a rule

/**
 * Record a user correction and potentially extract a new rule.
 *
 * @param {string} accountId
 * @param {{ messageId, from, subject }} email - the corrected email
 * @param {{ originalCategory, correctedCategory, correctedAction }} correction
 * @returns {Promise<{ correctionSaved: boolean, ruleGenerated: boolean, rule?: object }>}
 */
export async function recordCorrection(accountId, email, correction) {
  // Load existing feedback
  const feedback = await loadFeedback(accountId);

  // Store the correction
  feedback.corrections.push({
    messageId: email.messageId,
    from: email.from,
    subject: email.subject,
    originalCategory: correction.originalCategory,
    correctedCategory: correction.correctedCategory,
    correctedAction: correction.correctedAction,
    timestamp: new Date().toISOString(),
  });

  // Update accuracy stats
  feedback.stats.totalClassified = (feedback.stats.totalClassified || 0);
  feedback.stats.totalCorrected = (feedback.stats.totalCorrected || 0) + 1;
  if (feedback.stats.totalClassified > 0) {
    feedback.stats.accuracyRate = 1 - (feedback.stats.totalCorrected / feedback.stats.totalClassified);
  }

  // Check if we should generate a rule
  let ruleGenerated = false;
  let newRule = null;

  const domain = extractDomain(email.from);
  if (domain) {
    const domainCorrections = feedback.corrections.filter(c =>
      extractDomain(c.from) === domain &&
      c.correctedCategory === correction.correctedCategory
    );

    if (domainCorrections.length >= RULE_THRESHOLD) {
      // Check if rule already exists
      const existingRule = feedback.rules.find(r =>
        r.pattern.fromDomain === domain &&
        r.category === correction.correctedCategory
      );

      if (!existingRule) {
        newRule = {
          id: `r-${Date.now()}`,
          type: 'sender-action',
          pattern: { fromDomain: domain },
          category: correction.correctedCategory,
          importance: null, // Inherit from LLM
          action: correction.correctedAction,
          confidence: 0.95,
          learnedFrom: domainCorrections.length,
          createdAt: new Date().toISOString(),
          source: 'learned',
        };
        feedback.rules.push(newRule);
        ruleGenerated = true;
      } else {
        // Update existing rule's confidence
        existingRule.learnedFrom = domainCorrections.length;
      }
    }
  }

  await saveFeedback(accountId, feedback);

  return { correctionSaved: true, ruleGenerated, rule: newRule };
}

/**
 * Get all learned rules for an account.
 * @param {string} accountId
 * @returns {Promise<Array>}
 */
export async function getRules(accountId) {
  const feedback = await loadFeedback(accountId);
  return feedback.rules;
}

/**
 * Delete a learned rule.
 * @param {string} accountId
 * @param {string} ruleId
 */
export async function deleteRule(accountId, ruleId) {
  const feedback = await loadFeedback(accountId);
  feedback.rules = feedback.rules.filter(r => r.id !== ruleId);
  await saveFeedback(accountId, feedback);
}

/**
 * Get learning stats for an account.
 * @param {string} accountId
 * @returns {Promise<{ totalClassified, totalCorrected, accuracyRate, rulesCount }>}
 */
export async function getStats(accountId) {
  const feedback = await loadFeedback(accountId);
  return {
    ...feedback.stats,
    rulesCount: feedback.rules.length,
    correctionsCount: feedback.corrections.length,
  };
}

// ── Storage (via daemon) ───────────────────────────────────────────────────

async function loadFeedback(accountId) {
  try {
    return await daemonCall('learning.load', { accountId });
  } catch {
    return { rules: [], corrections: [], stats: { totalClassified: 0, totalCorrected: 0, accuracyRate: 1.0 } };
  }
}

async function saveFeedback(accountId, feedback) {
  return daemonCall('learning.save', { accountId, feedback });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractDomain(email) {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}
