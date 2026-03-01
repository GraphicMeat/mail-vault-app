/**
 * Signature detection and folding utilities.
 */

const SIGNATURE_DELIMITERS = [
  /^-- ?\r?$/m,                                   // RFC standard "-- "
  /^_{4,}\s*$/m,                                   // Outlook underscore separator
  /^-{4,}\s*$/m,                                   // Dash separator
];

const MOBILE_SIGNATURE_PATTERNS = [
  /^Sent from my (iPhone|iPad|Android|Galaxy|Pixel|Samsung)/im,
  /^Get Outlook for (iOS|Android|Mac|Windows)/im,
  /^Sent from Mail for Windows/im,
  /^Sent from Yahoo Mail/im,
  /^Sent from AOL Mobile Mail/im,
  /^This email was sent from/im,
];

/**
 * Split plain text into { body, signature }.
 */
export function splitSignature(text) {
  if (!text) return { body: '', signature: '' };

  let splitIndex = text.length;

  for (const pattern of SIGNATURE_DELIMITERS) {
    const match = text.match(pattern);
    if (match && match.index < splitIndex) {
      splitIndex = match.index;
    }
  }

  if (splitIndex === text.length) {
    for (const pattern of MOBILE_SIGNATURE_PATTERNS) {
      const match = text.match(pattern);
      if (match && match.index < splitIndex) {
        splitIndex = match.index;
      }
    }
  }

  if (splitIndex < text.length) {
    return {
      body: text.substring(0, splitIndex).trimEnd(),
      signature: text.substring(splitIndex),
    };
  }

  return { body: text, signature: '' };
}

/**
 * Simple hash for signature content (for Smart mode deduplication).
 */
export function hashSignature(sig) {
  if (!sig) return '';
  const normalized = sig.trim().toLowerCase().replace(/\s+/g, ' ');
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) & 0x7fffffff;
  }
  return hash.toString(36);
}
