// Contextual Quick Replies (Phase 5).
//
// Suppression reuses the header signals the app already carries on every
// email object (see messageMutations.js's indexEntryFor, which reads the
// same fields off `email` to build the local index) — no second detector,
// no daemon round trip. Tier 1 is deterministic and needs no model; Tier 2
// asks the configured provider for three starters and falls back to Tier 1
// silently on any failure or timeout.

import { htmlToText } from '../components/RichTextEditor';
import { generate, currentProvider } from '../services/aiClient';
import { useSettingsStore } from '../stores/settingsStore';
import { t } from '../i18n/index.js';

const LARGE_RECIPIENT_THRESHOLD = 15;

function replyToAddress(replyTo) {
  if (!replyTo) return '';
  if (Array.isArray(replyTo)) return replyTo[0]?.address || '';
  if (typeof replyTo === 'string') return replyTo;
  return replyTo?.address || '';
}

function replyToDiffers(email) {
  const replyAddr = replyToAddress(email?.replyTo).toLowerCase();
  const fromAddr = (email?.from?.address || '').toLowerCase();
  return !!replyAddr && !!fromAddr && replyAddr !== fromAddr;
}

/**
 * Newsletter / automated-mail suppression. Mirrors the `email?.listId ||
 * email?.headers?.['list-id']` fallback `EmailSenderInfo.jsx` already uses —
 * a predicate that only read the bare field would pass a unit test and stay
 * inert on a real header cache entry that only fills the fallback.
 */
export function isAutomatedThread(email) {
  if (!email) return false;
  const listUnsubscribe = email.listUnsubscribe || email.headers?.['list-unsubscribe'];
  const listId = email.listId || email.headers?.['list-id'];
  const precedence = email.precedence || email.headers?.['precedence'];
  const recipientCount = (email.to?.length || 0) + (email.cc?.length || 0);
  return !!listUnsubscribe || !!listId || !!precedence || replyToDiffers(email)
    || recipientCount > LARGE_RECIPIENT_THRESHOLD;
}

/**
 * A thread-stable dismissal key: the root of the References chain when there
 * is one, else In-Reply-To, else the message's own id. A uid is deliberately
 * never used here — it moves on a Graph resync or a folder move, and the
 * dismissal must survive that the same way tags moved off it in the views
 * branch (see tagStore.js's own comment on why uid-keying is unstable).
 */
export function quickReplyThreadKey(email) {
  const refs = String(email?.references || '').trim().split(/\s+/).filter(Boolean);
  return refs[0] || email?.inReplyTo || email?.in_reply_to || email?.messageId || email?.message_id || '';
}

function plainTextOf(email) {
  if (email?.text) return email.text;
  if (email?.html) return htmlToText(email.html);
  return email?.snippet || '';
}

// ponytail: regex heuristics, not NLP — good enough to pick a shape, not to
// understand the email. A model (Tier 2) does better; this is what ships
// with zero setup and no network.
const TIME_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|\d{1,2}(:\d{2})?\s?(am|pm))\b/i;
const TIME_CONTEXT_RE = /\b(work for you|available|free at|free on|how about|does .* work|meet(ing)?|call at|schedule)\b/i;

/** One of the three thread shapes Tier 1 (and the Tier 2 prompt) reasons about. */
export function threadShape(email) {
  const text = `${email?.subject || ''}\n${plainTextOf(email)}`;
  if (TIME_RE.test(text) && TIME_CONTEXT_RE.test(text)) return 'proposedTime';
  if (text.includes('?')) return 'question';
  return 'request';
}

/**
 * Deterministic starters for a thread shape. Locale-aware: every string is a
 * catalog key. Uses the module-level `t` (current locale is module state,
 * see i18n/index.js) rather than a caller's `useT()` lease — this runs from
 * a plain effect, not render, so there is nothing to subscribe to anyway.
 */
export function tier1Starters(email) {
  const shape = threadShape(email);
  if (shape === 'proposedTime') {
    return [t('ai.quickReply.time.accept'), t('ai.quickReply.time.decline'), t('ai.quickReply.time.propose')];
  }
  if (shape === 'question') {
    return [t('ai.quickReply.question.yes'), t('ai.quickReply.question.no'), t('ai.quickReply.question.checkBack')];
  }
  return [t('ai.quickReply.request.ack')];
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function parseStarters(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * Tier 2: three provider-generated starters, or `null` when AI features are
 * off, the provider is unavailable, generation fails, or it times out — the
 * caller falls back to `tier1Starters` on any `null`.
 *
 * A non-local (`endpoint`) provider is only ever asked here when the user has
 * already explicitly confirmed a send to it at least once (through
 * `AiContextPreview`, in Settings or in an AI Compose action) — this call is
 * automatic, background, and un-previewed, and the endpoint consent is what
 * keeps "never discover after the fact what left the machine" true for it.
 * Local providers (on-device by construction) need no such gate.
 */
export async function tier2Starters(email) {
  const settings = useSettingsStore.getState().aiSettings;
  if (!settings?.enabled) return null;
  const provider = currentProvider(settings);
  if (provider.type === 'endpoint' && !settings.endpointConsented) return null;

  const prompt = `Suggest exactly 3 very short email reply starters (a few words each), one per line, no numbering, for this message:\n\nSubject: ${email?.subject || ''}\n\n${plainTextOf(email).slice(0, 2000)}`;
  try {
    const text = await withTimeout(generate({ prompt, provider, maxTokens: 120 }), 8000);
    const starters = parseStarters(text);
    return starters.length ? starters : null;
  } catch {
    return null;
  }
}
