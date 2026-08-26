// Mail is attacker-controlled text. Two separate problems, two separate fixes.
//
// 1. Direction. A subject or display name written in Arabic or Hebrew reads
//    right-to-left, and forcing it LTR puts the punctuation and any embedded
//    latin word in the wrong place — and puts the truncation ellipsis on the
//    wrong end of the string. `dir="auto"` lets the first strong character
//    decide, per element, which is exactly the per-message answer we want.
//
// 2. Override characters. U+202E RIGHT-TO-LEFT OVERRIDE and friends do not
//    describe text, they reverse how the rest of the run is painted. The
//    classic use is an attachment named "Invoice‮mth.exe", which renders
//    as "Invoiceexe.htm" — the extension the user reads is not the extension
//    they get. Direction marks and overrides carry no meaning we want to
//    honour in a subject, a display name, or a filename, so they are removed
//    before display. Isolates (U+2066-2069) are stripped for the same reason:
//    unpaired ones leak into the surrounding layout.
//
// The raw value is never modified — this is a display-time transform only, so
// nothing that gets written to the vault or sent over the wire changes.

// LRE LRO RLE RLO PDF · LRM RLM ALM · LRI RLI FSI PDI
const BIDI_CONTROLS = /[‪-‮‎‏؜⁦-⁩]/g;

/**
 * Strip bidirectional control characters from a string for display.
 * Returns the input unchanged when it is not a string.
 */
export function stripBidiControls(value) {
  if (typeof value !== 'string') return value;
  return value.replace(BIDI_CONTROLS, '');
}

/**
 * Display form of a piece of untrusted mail text: overrides removed, and an
 * empty or whitespace-only result collapsed to `fallback` so a row never
 * renders a blank where a subject should be.
 */
export function displayText(value, fallback = '') {
  const cleaned = stripBidiControls(value);
  if (typeof cleaned !== 'string') return fallback;
  return cleaned.trim() === '' ? fallback : cleaned;
}
