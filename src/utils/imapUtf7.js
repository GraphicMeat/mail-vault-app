/**
 * IMAP modified UTF-7 (RFC 3501 §5.1.3) — decode for DISPLAY ONLY.
 *
 * Servers put non-ASCII mailbox names on the wire escaped: "Bokelmühle" arrives
 * as "Bokelmu&Awg-hle" when the server stores the name decomposed (u + U+0308).
 * Until this file existed the app printed the escaped form everywhere.
 *
 * The escaped form stays the mailbox's identity: it is what SELECT takes and
 * what the Maildir directory on disk is named. Never feed a decoded name back
 * into a path, a store key, or an IMAP command.
 */

const RUN = /&([A-Za-z0-9+,]*)-/g;

/** Decode one shift run (the text between "&" and "-"), or null if malformed. */
function decodeRun(run) {
  if (run === '') return '&'; // "&-" is the escape for a literal ampersand
  const b64 = run.replace(/,/g, '/'); // modified base64: "," stands in for "/"
  const remainder = b64.length % 4;
  if (remainder === 1) return null; // 6 stray bits encode nothing
  let bytes;
  try {
    bytes = atob(remainder ? b64 + '='.repeat(4 - remainder) : b64);
  } catch {
    return null;
  }
  // The payload is UTF-16BE, so an odd byte count is a truncated code unit —
  // "&AB-" and friends are prose, not an encoded name. Leave them alone.
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  }
  return out;
}

/**
 * Decode every modified-UTF-7 run in `value`. Anything that is not a valid run
 * is returned verbatim, which is what makes this safe to run over whole
 * sentences — backend error strings interpolate a mailbox name mid-text.
 */
export function decodeImapUtf7(value) {
  if (typeof value !== 'string' || !value.includes('&')) return value;
  let changed = false;
  const decoded = value.replace(RUN, (match, run) => {
    const text = decodeRun(run);
    if (text === null) return match;
    changed = true;
    return text;
  });
  // A run can carry a bare combining mark (that is exactly what "&Awg-" is), so
  // the result only equals a typed "Bokelmühle" after composing.
  return changed ? decoded.normalize('NFC') : value;
}

/**
 * The label to show for a mailbox: decoded, with the leading INBOX prefix that
 * dotted-hierarchy servers put on every folder dropped.
 */
export function mailboxLabel(name) {
  if (!name) return name;
  const prefix = name.match(/^inbox\./i);
  return decodeImapUtf7(prefix ? name.slice(prefix[0].length) : name);
}
