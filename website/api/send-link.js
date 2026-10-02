// POST /api/send-link: a phone visitor mails themselves the download link so
// they can open it on the computer MailVault actually runs on.
//
// No captcha (site rule), so abuse is held off by limits instead:
//   - per IP: express-rate-limit in server.js (5 an hour);
//   - per recipient: one mail per address per 24 hours, keyed by a SHA-256 of
//     the lowercased address, never the address itself;
//   - global: at most `dailyCap` mails per UTC day.
// Both in-memory counters reset when the process restarts. That is accepted:
// a restart is rare and the IP limit still applies.
//
// The address is used for exactly one thing, the partner send. It is not
// stored, and it is never logged: failures log the error message only.
const crypto = require('crypto');
const token = require('./send-link-token');
const { linksFor, buildSendLinkEmail } = require('./send-link-email');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EMAIL = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const recipientHash = (email) => crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/**
 * @param {object} deps
 * @param {(endpoint: string, payload: object) => Promise<any>} deps.send   sendViaGraphicMeat
 * @param {() => boolean} deps.configured   partner URL and key present
 * @param {Buffer|null} deps.key            token key (send-link-token deriveKey)
 * @param {(event: string) => any} [deps.bumpMetric]
 * @param {() => number} [deps.now]
 * @param {number} [deps.dailyCap]
 * @param {(address: string) => boolean} [deps.validEmail]  server.js passes isValidEmail + tooLong
 * @param {(msg: string) => void} [deps.logError]
 */
function createSendLink({
  send, configured, key, bumpMetric = () => {}, now = Date.now, dailyCap = 300,
  validEmail = (a) => a.length <= MAX_EMAIL && EMAIL_RE.test(a),
  logError = (m) => console.error(m),
}) {
  const recent = new Map();             // recipient hash -> expiry ms
  const daily = { day: '', count: 0 };  // UTC date -> mails sent (or in flight)

  function prune(at) {
    if (recent.size < 500) return;
    for (const [hash, until] of recent) if (until <= at) recent.delete(hash);
  }

  // Resolves to one of: sent | invalid | limited | unavailable | failed.
  // `sent` is also what a filled honeypot gets, so a bot learns nothing.
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
    if ((recent.get(hash) || 0) > at) return 'limited';

    // Reserve both slots before the network call, so two quick submits for one
    // address cannot both get through; give them back if the send fails.
    recent.set(hash, at + DAY_MS);
    daily.count++;
    try {
      const mail = buildSendLinkEmail(lang, linksFor(lang, token.seal(key, address, at)));
      await send('send', { to: address, fromName: 'MailVault', ...mail });
    } catch (err) {
      recent.delete(hash);
      if (daily.day === day && daily.count > 0) daily.count--;
      logError(`[send-link] send failed: ${err && err.message}`);
      return 'failed';
    }
    try { bumpMetric('send_link_sent'); } catch { /* metrics never break a send */ }
    return 'sent';
  }

  return { request };
}

// HTTP status and JSON body for each outcome.
const RESPONSES = {
  sent: [200, { success: true }],
  invalid: [400, { error: 'invalid_email' }],
  limited: [429, { error: 'rate_limited' }],
  unavailable: [503, { error: 'unavailable' }],
  failed: [503, { error: 'unavailable' }],
};

module.exports = { createSendLink, recipientHash, RESPONSES, DAY_MS };
