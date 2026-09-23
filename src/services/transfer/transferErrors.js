// ── transfer/transferErrors — account transfer error -> catalog key ──
//
// Every transfer failure reaches the UI as a message starting with its E_*
// code: the daemon's own text, a keychain code from the app, or a bare string
// from a Tauri command (invoke rejects an Err(String) with the string itself).

export const TRANSFER_PASSWORD_MIN = 12;

const BY_PREFIX = [
  ['E_TRANSFER_DECRYPT', 'settings.transfer.errors.decrypt'],
  ['E_TRANSFER_FORMAT', 'settings.transfer.errors.format'],
  ['E_TRANSFER_READ', 'settings.transfer.errors.read'],
  ['E_KEYCHAIN_UNAVAILABLE', 'settings.transfer.errors.keychain'],
  ['E_KEYCHAIN_WRITE', 'settings.transfer.errors.keychainWrite'],
  ['E_TRANSFER_PASSWORD', 'settings.transfer.passwordHint'],
];

/**
 * `{ key, values }` for `t()`. With `applying`, the error came from
 * applyImport: past its keychain check the accounts may already be saved, so
 * anything but an unavailable keychain or a failed keychain write maps to
 * `errors.partial`, never to a message that implies nothing happened.
 */
export function transferErrorKey(err, { applying = false } = {}) {
  const message = String(err?.message ?? err ?? '');
  const hit = BY_PREFIX.find(([prefix]) => message.startsWith(prefix));
  if (applying && !['E_KEYCHAIN_UNAVAILABLE', 'E_KEYCHAIN_WRITE'].includes(hit?.[0])) {
    return { key: 'settings.transfer.errors.partial', values: { message } };
  }
  if (message.startsWith('E_TRANSFER_INCOMPLETE')) {
    const colon = message.indexOf(':');
    return { key: 'settings.transfer.errors.incomplete', values: { emails: colon < 0 ? '' : message.slice(colon + 1).trim() } };
  }
  if (hit?.[0] === 'E_TRANSFER_PASSWORD') return { key: hit[1], values: { count: TRANSFER_PASSWORD_MIN } };
  if (hit) return { key: hit[1], values: {} };
  return { key: 'settings.transfer.errors.generic', values: { message } };
}
