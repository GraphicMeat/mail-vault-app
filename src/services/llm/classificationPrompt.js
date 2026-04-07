/**
 * Classification Prompt — generates structured prompts for email categorization.
 *
 * The prompt asks the LLM to classify each email into a category, importance
 * level, and suggested action. Output is requested as JSON for reliable parsing.
 */

/**
 * Build a classification prompt for a batch of emails.
 *
 * @param {Array<{ uid, subject, from, date, bodyPreview }>} emails
 * @param {Array<{ pattern, action, category }>} [learnedRules] - user-corrected rules to include as context
 * @returns {string} - the complete prompt string
 */
export function buildClassificationPrompt(emails, learnedRules = []) {
  const rulesContext = learnedRules.length > 0
    ? `\nThe user has established these preferences from past corrections:\n${learnedRules.map(r => `- Emails from "${r.pattern.fromDomain || r.pattern.from}" → ${r.category || r.action}`).join('\n')}\nApply these rules where they match.\n`
    : '';

  const emailList = emails.map((e, i) => (
    `[${i + 1}] UID: ${e.uid}\n` +
    `    From: ${e.from}\n` +
    `    Subject: ${e.subject || '(No subject)'}\n` +
    `    Date: ${e.date}\n` +
    (e.bodyPreview ? `    Preview: ${e.bodyPreview.slice(0, 300)}\n` : '')
  )).join('\n');

  return `You are an email classification assistant. Classify each email below into exactly one category, one importance level, and one suggested action.

Categories (pick exactly one):
- newsletter: recurring subscriptions, digests, mailing lists
- promotional: sales, marketing, coupons, deals
- notification: automated alerts from services (GitHub, Jira, CI, social media)
- transactional: receipts, order confirmations, shipping updates, password resets
- personal: direct human correspondence, friends, family
- work: professional/business communication, colleagues, clients
- spam-likely: suspected spam that passed filters

Importance (pick exactly one):
- high: requires action or is time-sensitive
- medium: useful to read but not urgent
- low: can be skipped or read later
- irrelevant: no value, safe to ignore

Suggested action (pick exactly one):
- keep: important, should stay on server
- archive: worth keeping locally but can be removed from server
- delete-from-server: safe to remove from server (local copy preserved)
- review: uncertain — flag for user review
${rulesContext}
Classify these ${emails.length} emails. Respond with ONLY a JSON array, no other text:

${emailList}

Respond with exactly this JSON format:
[
  {"uid": <uid>, "category": "<category>", "importance": "<importance>", "action": "<action>", "confidence": <0.0-1.0>}
]`;
}

/**
 * Parse the LLM's classification response.
 * Handles common formatting issues (markdown fences, trailing text).
 *
 * @param {string} response - raw LLM output
 * @returns {Array<{ uid, category, importance, action, confidence }>}
 */
export function parseClassificationResponse(response) {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Find the JSON array in the response
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart === -1 || arrayEnd === -1) {
    throw new Error('No JSON array found in LLM response');
  }

  const jsonStr = cleaned.slice(arrayStart, arrayEnd + 1);

  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) throw new Error('Parsed result is not an array');
    return parsed.map(item => ({
      uid: item.uid,
      category: validateCategory(item.category),
      importance: validateImportance(item.importance),
      action: validateAction(item.action),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
    }));
  } catch (e) {
    throw new Error(`Failed to parse classification JSON: ${e.message}`);
  }
}

const VALID_CATEGORIES = ['newsletter', 'promotional', 'notification', 'transactional', 'personal', 'work', 'spam-likely'];
const VALID_IMPORTANCE = ['high', 'medium', 'low', 'irrelevant'];
const VALID_ACTIONS = ['keep', 'archive', 'delete-from-server', 'review'];

function validateCategory(val) {
  return VALID_CATEGORIES.includes(val) ? val : 'review';
}
function validateImportance(val) {
  return VALID_IMPORTANCE.includes(val) ? val : 'medium';
}
function validateAction(val) {
  return VALID_ACTIONS.includes(val) ? val : 'review';
}
