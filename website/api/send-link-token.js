// Opaque token for the "Yes, send me updates" link in the email-me-the-link
// mail. The link must not carry the plain address: a query string lands in
// Caddy and Cloudflare logs. So the address and an expiry are sealed with
// AES-256-GCM; anyone holding the token can only hand it back to us, and a
// changed byte fails the GCM tag.
//
// The key is derived (HKDF-SHA256) from GRAPHICMEAT_PARTNER_KEY, so no new
// secret has to be provisioned. Without that key no mail can be sent at all, so
// a missing key and a missing feature are the same state.
const crypto = require('crypto');

const INFO = 'mailvault-send-link-v1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(secret) {
  if (!secret) return null;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret), 'utf8'), Buffer.alloc(0), INFO, 32));
}

// Layout: iv (12) | tag (16) | ciphertext, base64url.
function seal(key, email, now = Date.now(), ttl = TTL_MS) {
  if (!key) throw new Error('send-link key not configured');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ e: email, x: now + ttl }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

// { email } for a good token, { error: 'expired' } for a genuine one past its
// date, { error: 'invalid' } for anything malformed or tampered with.
function open(key, token, now = Date.now()) {
  const invalid = { error: 'invalid' };
  if (!key || typeof token !== 'string' || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) return invalid;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES) return invalid;
  let payload;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8'));
  } catch {
    return invalid;
  }
  if (!payload || typeof payload.e !== 'string' || !payload.e || typeof payload.x !== 'number') return invalid;
  if (payload.x < now) return { error: 'expired' };
  return { email: payload.e };
}

module.exports = { deriveKey, seal, open, TTL_MS };
