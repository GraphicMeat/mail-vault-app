// POST /api/subscribe: a newsletter sign-up is a request, not a subscription.
// It mails the address a confirm link and stores nothing; the subscriber row
// appears only when the link's one-button page is pressed
// (/api/send-link/subscribe). Before this, any POST subscribed the address and
// sent it a welcome mail, which made the form a free way to mail strangers and
// collect bounces.
//
// No captcha (site rule), so abuse is held off by limits:
//   - per IP: express-rate-limit in server.js;
//   - per recipient: one confirm mail per address per hour, keyed by a SHA-256
//     of the lowercased address, never the address itself;
//   - global: at most `dailyCap` mails per UTC day.
// In-memory counters reset on restart. That is accepted.
//
// Already-subscribed addresses get the same "sent" answer and no mail, so the
// form does not reveal who is on the list. The address is never logged.
const crypto = require('crypto');
const token = require('./send-link-token');
const { buildSubscribeConfirmEmail } = require('./subscribe-confirm-email');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_EMAIL = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const recipientHash = (email) => crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/**
 * @param {object} deps
 * @param {(endpoint: string, payload: object) => Promise<any>} deps.send   sendViaGraphicMeat
 * @param {() => boolean} deps.configured
 * @param {Buffer|null} deps.key   send-link-token deriveKey
 * @param {(address: string) => Promise<boolean>} deps.isSubscribed
 * @param {(event: string) => any} [deps.bumpMetric]
 */
function createSubscribeConfirm({
  send, configured, key, isSubscribed, bumpMetric = () => {}, now = Date.now,
  dailyCap = 300, cooldownMs = HOUR_MS,
  validEmail = (a) => a.length <= MAX_EMAIL && EMAIL_RE.test(a),
  logError = (m) => console.error(m),
}) {
  const recent = new Map();             // recipient hash -> expiry ms
  const daily = { day: '', count: 0 };

  function prune(at) {
    if (recent.size < 500) return;
    for (const [hash, until] of recent) if (until <= at) recent.delete(hash);
  }

  // Resolves to sent | invalid | limited | unavailable | failed.
  async function request({ email, lang, website } = {}) {
    if (typeof website === 'string' ? website.trim() : website) return 'sent';
    if (typeof email !== 'string') return 'invalid';
    const address = email.trim();
    if (!address || !validEmail(address)) return 'invalid';
    if (!configured() || !key) return 'unavailable';

    const at = now();
    const day = new Date(at).toISOString().slice(0, 10);
    if (daily.day !== day) { daily.day = day; daily.count = 0; }
    if (daily.count >= dailyCap) return 'limited';
    prune(at);
    const hash = recipientHash(address);
    if ((recent.get(hash) || 0) > at) return 'sent'; // a mail is already on its way

    try {
      if (await isSubscribed(address)) return 'sent';
    } catch (err) {
      logError(`[subscribe] lookup failed: ${err && (err.code || err.message)}`);
      return 'failed';
    }

    // Reserve both slots before the network call; give them back if it fails.
    recent.set(hash, at + cooldownMs);
    daily.count++;
    try {
      const mail = buildSubscribeConfirmEmail(lang, token.seal(key, address, at));
      await send('send', { to: address, fromName: 'MailVault', ...mail });
    } catch (err) {
      recent.delete(hash);
      if (daily.day === day && daily.count > 0) daily.count--;
      logError(`[subscribe] send failed: ${err && err.message}`);
      return 'failed';
    }
    try { bumpMetric('subscribe_confirm_sent'); } catch { /* metrics never break a send */ }
    return 'sent';
  }

  return { request };
}

const RESPONSES = {
  sent: [200, { success: true, message: 'Check your email to confirm' }],
  invalid: [400, { error: 'Valid email is required' }],
  limited: [429, { error: 'rate_limited' }],
  unavailable: [503, { error: 'unavailable' }],
  failed: [503, { error: 'unavailable' }],
};

module.exports = { createSubscribeConfirm, RESPONSES, recipientHash, DAY_MS };
