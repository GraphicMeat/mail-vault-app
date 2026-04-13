/**
 * Learning Service — captures user corrections and extracts rules.
 *
 * When a user overrides a classification, the correction is recorded.
 * After enough corrections for the same pattern (sender domain, subject keyword),
 * a local rule is auto-generated. Rules are applied before LLM inference,
 * making classification faster and more consistent over time.
 */

import { daemonCall } from './daemonClient.js';

const RULE_THRESHOLD = 1; // Auto-generate rule on first correction

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
  const address = extractAddress(email.from);

  if (domain) {
    const domainCorrections = feedback.corrections.filter(c =>
      extractDomain(c.from) === domain &&
      c.correctedCategory === correction.correctedCategory
    );

    // Check if same domain was corrected to DIFFERENT categories — conflict
    const conflictingCorrections = feedback.corrections.filter(c =>
      extractDomain(c.from) === domain &&
      c.correctedCategory !== correction.correctedCategory
    );

    if (conflictingCorrections.length > 0 && address) {
      // 6b: Address-level rule on conflict — different senders at same domain go to different categories
      const existingAddrRule = feedback.rules.find(r =>
        r.pattern.fromAddress === address &&
        r.category === correction.correctedCategory
      );

      if (!existingAddrRule) {
        newRule = {
          id: `r-${Date.now()}`,
          type: 'sender-action',
          pattern: { fromAddress: address },
          category: correction.correctedCategory,
          importance: null,
          action: correction.correctedAction,
          confidence: 0.95,
          learnedFrom: 1,
          createdAt: new Date().toISOString(),
          source: 'learned',
        };
        feedback.rules.push(newRule);
        ruleGenerated = true;
      } else {
        existingAddrRule.learnedFrom = (existingAddrRule.learnedFrom || 1) + 1;
        existingAddrRule.confidence = Math.min(0.99, existingAddrRule.confidence + 0.01);
      }
    } else if (domainCorrections.length >= RULE_THRESHOLD) {
      // Normal domain-level rule
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
          importance: null,
          action: correction.correctedAction,
          confidence: 0.95,
          learnedFrom: domainCorrections.length,
          createdAt: new Date().toISOString(),
          source: 'learned',
        };
        feedback.rules.push(newRule);
        ruleGenerated = true;
      } else {
        // 6a: Strengthen existing rule
        existingRule.learnedFrom = domainCorrections.length;
        existingRule.confidence = Math.min(0.99, existingRule.confidence + 0.01);
        if (correction.correctedAction) {
          existingRule.action = correction.correctedAction;
        }
      }
    }

    // 6c: Subject-pattern learning — 2+ corrections from same domain with shared subject words
    if (domainCorrections.length >= 2) {
      const sharedWords = findSharedSubjectWords(domainCorrections);
      if (sharedWords && !feedback.rules.some(r =>
        r.pattern.fromDomain === domain &&
        r.pattern.subjectContains === sharedWords &&
        r.category === correction.correctedCategory
      )) {
        const subjectRule = {
          id: `r-${Date.now()}-subj`,
          type: 'sender-action',
          pattern: { fromDomain: domain, subjectContains: sharedWords },
          category: correction.correctedCategory,
          importance: null,
          action: correction.correctedAction,
          confidence: 0.90,
          learnedFrom: domainCorrections.length,
          createdAt: new Date().toISOString(),
          source: 'learned',
        };
        feedback.rules.push(subjectRule);
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
 * Save (add or update) a rule.
 * @param {string} accountId
 * @param {object} rule - rule object with id, pattern, category, action, etc.
 */
export async function saveRule(accountId, rule) {
  const feedback = await loadFeedback(accountId);
  const idx = feedback.rules.findIndex(r => r.id === rule.id);
  if (idx >= 0) {
    feedback.rules[idx] = { ...feedback.rules[idx], ...rule };
  } else {
    feedback.rules.push(rule);
  }
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
  if (at <= 0) return null;
  return email.slice(at + 1).replace(/[>]/g, '').toLowerCase();
}

function extractAddress(from) {
  if (!from) return null;
  const match = from.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  if (from.includes('@')) return from.trim().toLowerCase();
  return null;
}

function findSharedSubjectWords(corrections) {
  if (corrections.length < 2) return null;
  const subjects = corrections.map(c => (c.subject || '').toLowerCase());
  const wordSets = subjects.map(s =>
    new Set(s.split(/\s+/).filter(w => w.length >= 4))
  );
  if (wordSets.length === 0 || wordSets[0].size === 0) return null;

  const shared = [...wordSets[0]].filter(w =>
    wordSets.every(set => set.has(w))
  );

  if (shared.length === 0) return null;
  // Return the longest shared word as the subject pattern
  shared.sort((a, b) => b.length - a.length);
  return shared[0];
}
