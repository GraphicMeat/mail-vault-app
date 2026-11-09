// Email-code sign-in for the phone app: an existing web Premium subscriber
// proves they own the billing address before the app gets their customer id.
//
//   POST /api/billing/signin/start  {email}        -> 200 {ok:true} (always)
//   POST /api/billing/signin/verify {email, code}  -> 200 {customerId}
//
// Security shape:
//   - codes are 6 digits from crypto.randomInt, valid for 10 minutes, usable
//     once, and locked after 5 guesses; only SHA-256(email:code) is stored;
//   - the hash is compared in constant time;
//   - no account enumeration: `start` answers the same for every address and
//     writes a row for unknown ones too (a decoy nobody can guess), so `verify`
//     behaves identically whether or not a customer exists. The mail itself is
//     sent after the answer is ready, so timing does not leak it either;
//   - a new code for an address retires its older ones;
//   - per address, 3 codes an hour (counted whether or not the address is a
//     customer, in memory like send-link's counters: a restart resets them and
//     the per-IP limits in server.js still apply).
// The address is never logged.
const crypto = require('crypto');
const { buildSigninCodeEmail } = require('./signin-code-email');

const MAX_EMAIL = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const EMAIL_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_MAX_STARTS = 3;
const KEEP_ROWS_MS = 24 * 60 * 60 * 1000;

// billing_customers stores addresses lowercased and trimmed (server.js lowercases on insert).
const normalizeEmail = (email) => String(email).trim().toLowerCase();
const hashCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}`).digest('hex');
const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/**
 * @param {object} deps
 * @param {() => {execute: Function}} deps.getDb           mysql2 pool (lazy)
 * @param {(endpoint: string, payload: object) => Promise<any>} deps.send   sendViaGraphicMeat
 * @param {() => boolean} deps.configured                  partner mail configured
 * @param {() => number} [deps.now]
 * @param {(min: number, max: number) => number} [deps.randomInt]
 * @param {(msg: string) => void} [deps.logError]
 */
function createSigninCode({
  getDb, send, configured, now = Date.now, randomInt = crypto.randomInt,
  logError = (m) => console.error(m),
}) {
  const starts = new Map();       // sha256(email) -> [timestamps within the window]
  const pending = new Set();      // in-flight mail sends

  function limited(address, at) {
    const key = crypto.createHash('sha256').update(address).digest('hex');
    if (starts.size > 1000) {
      for (const [k, list] of starts) if (!list.some((t) => t > at - EMAIL_WINDOW_MS)) starts.delete(k);
    }
    const recent = (starts.get(key) || []).filter((t) => t > at - EMAIL_WINDOW_MS);
    if (recent.length >= EMAIL_MAX_STARTS) { starts.set(key, recent); return true; }
    recent.push(at);
    starts.set(key, recent);
    return false;
  }

  // Resolves to 'ok' | 'limited'. Anything that goes wrong inside is logged and
  // still answers 'ok': the caller must not learn anything from a failure.
  async function start({ email, lang } = {}) {
    if (typeof email !== 'string' || email.length > MAX_EMAIL * 2) return 'ok';
    const address = normalizeEmail(email);
    if (!address || address.length > MAX_EMAIL || !EMAIL_RE.test(address)) return 'ok';
    const at = now();
    if (limited(address, at)) return 'limited';

    try {
      const db = getDb();
      const [customers] = await db.execute('SELECT stripe_customer_id FROM billing_customers WHERE email = ?', [address]);
      const known = customers.length > 0;
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

      await db.execute('DELETE FROM billing_signin_codes WHERE expires_at < ?', [at - KEEP_ROWS_MS]);
      await db.execute('UPDATE billing_signin_codes SET used_at = ? WHERE email = ? AND used_at IS NULL', [at, address]);
      await db.execute(
        'INSERT INTO billing_signin_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)',
        [address, hashCode(address, code), at + CODE_TTL_MS, at],
      );

      if (known && configured()) {
        const mail = buildSigninCodeEmail(lang, code);
        const job = Promise.resolve()
          .then(() => send('send', { to: address, fromName: 'MailVault', ...mail }))
          .catch((err) => logError(`[signin] send failed: ${err && err.message}`))
          .finally(() => pending.delete(job));
        pending.add(job);
      }
    } catch (err) {
      logError(`[signin] start failed: ${err && err.code || err && err.message}`);
    }
    return 'ok';
  }

  // Resolves once every mail send started so far has settled (tests, shutdown).
  const drain = () => Promise.all([...pending]).then(() => {});

  // Resolves to { customerId } or { error: 'code_wrong' | 'code_expired' }.
  // The decision depends only on the stored row, so a known and an unknown
  // address cannot be told apart. 'code_expired' also covers a spent code, a
  // locked one and an address that never asked.
  async function verify({ email, code } = {}) {
    if (typeof email !== 'string' || email.length > MAX_EMAIL * 2) return { error: 'code_wrong' };
    const address = normalizeEmail(email);
    if (!address || address.length > MAX_EMAIL) return { error: 'code_wrong' };
    const db = getDb();
    const at = now();

    const [rows] = await db.execute(
      'SELECT id, code_hash FROM billing_signin_codes WHERE email = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1',
      [address],
    );
    if (!rows.length) return { error: 'code_expired' };
    const row = rows[0];

    // Spend an attempt before looking at the guess, atomically, so parallel
    // guesses cannot get more than MAX_ATTEMPTS tries between them.
    const [claim] = await db.execute(
      'UPDATE billing_signin_codes SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND attempts < ? AND expires_at > ?',
      [row.id, MAX_ATTEMPTS, at],
    );
    if (!claim.affectedRows) return { error: 'code_expired' };

    const guess = typeof code === 'string' ? code.trim() : '';
    if (!/^\d{6}$/.test(guess)) return { error: 'code_wrong' };
    if (!safeEqualHex(hashCode(address, guess), row.code_hash)) return { error: 'code_wrong' };

    const [used] = await db.execute('UPDATE billing_signin_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [at, row.id]);
    if (!used.affectedRows) return { error: 'code_expired' };

    const [customers] = await db.execute('SELECT stripe_customer_id FROM billing_customers WHERE email = ?', [address]);
    if (!customers.length) return { error: 'code_wrong' };
    return { customerId: customers[0].stripe_customer_id };
  }

  return { start, verify, drain };
}

// HTTP status and JSON body for each non-success outcome.
const RESPONSES = {
  ok: [200, { ok: true }],
  limited: [429, { error: 'rate_limited' }],
  rate_limited: [429, { error: 'rate_limited' }],
  code_wrong: [401, { error: 'code_wrong' }],
  code_expired: [410, { error: 'code_expired' }],
};

module.exports = { createSigninCode, normalizeEmail, RESPONSES, CODE_TTL_MS, MAX_ATTEMPTS };
