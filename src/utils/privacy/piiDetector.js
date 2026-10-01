/**
 * Finds the people in a piece of text: names from the user's own contacts,
 * plus email addresses, phone numbers and postal addresses by pattern.
 *
 * Pure: no DOM, no I/O. Privacy mode, private export and the social export
 * all call this, so a fix here reaches every surface at once.
 *
 * Over-masking is the accepted failure. A blurred brand name costs nothing; a
 * leaked surname on a screen recording cannot be taken back.
 */

// Single tokens too common to mask on their own. Inside a full-name match
// they are still masked ("Mark Post").
// ponytail: hand-picked list of common words that are also names; extend when a real mailbox shows a false positive.
const STOP = new Set([
  'will', 'mark', 'may', 'june', 'july', 'april', 'august', 'bill', 'post', 'rose', 'grace', 'hope',
  'joy', 'faith', 'max', 'sky', 'dean', 'chase', 'page', 'king', 'young', 'long', 'white', 'black',
  'brown', 'green', 'gray', 'grey', 'hall', 'wood', 'love', 'star', 'son', 'van', 'von', 'der', 'den',
  'del', 'della', 'team', 'support', 'info', 'admin', 'mail', 'news', 'hello', 'dear', 'thanks',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'september', 'october', 'november', 'december',
  'the', 'and', 'for', 'from', 'new', 'not', 'you', 'your', 'our', 'this', 'that',
]);
// ponytail: tokens under 3 letters are never masked alone (initials, "Jo", "Li"); revisit if short names leak.
const MIN_TOKEN = 3;

const NAME_TOKEN = /\p{L}[\p{L}\p{M}'’-]*/gu;
const STARTS_UPPER = /^\p{Lu}/u;
const HAS_CASE = /[\p{Lu}\p{Ll}\p{Lt}]/u;
// Scripts written without spaces between words: names are found by substring, not by token.
const UNSPACED = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Thai}';
const UNSPACED_TEST = new RegExp(`[${UNSPACED}]`, 'u');
const UNSPACED_RUN = new RegExp(`[${UNSPACED}・ー·]+`, 'gu');
// ponytail: names longer than this many characters in an unspaced script are not searched; raise if a real name is cut.
const UNSPACED_MAX = 20;
// Letters NFD does not decompose.
const FOLD_MAP = { 'ł': 'l', 'ø': 'o', 'đ': 'd', 'æ': 'ae', 'ß': 'ss', 'œ': 'oe', 'þ': 'th' };

export function foldName(s) {
  const str = String(s ?? '');
  if (/^[\x00-\x7f]*$/.test(str)) return str.toLowerCase();
  return str.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC').toLowerCase()
    .replace(/’/g, "'")
    .replace(/[łøđæßœþ]/g, (c) => FOLD_MAP[c]);
}

export function buildNameDictionary({ names = [] } = {}) {
  const fullNames = new Set();
  const tokens = new Set();
  const unspaced = new Set();
  let unspacedMax = 0;
  const addUnspaced = (w) => {
    if (w.length < 2 || w.length > UNSPACED_MAX) return;
    unspaced.add(w);
    unspacedMax = Math.max(unspacedMax, w.length);
  };
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name || name.includes('@')) continue;
    if (UNSPACED_TEST.test(name)) {
      addUnspaced(name.replace(/\s+/g, ''));
      // ponytail: single-character parts (a lone family name like 王) are skipped, they would mask every occurrence of the glyph.
      for (const part of name.split(/[\s・·]+/)) if (UNSPACED_TEST.test(part)) addUnspaced(part);
    }
    const folded = (name.match(NAME_TOKEN) || []).map(foldName);
    if (!folded.length) continue;
    if (folded.length > 1) fullNames.add(folded.join(' '));
    for (const f of folded) {
      // "smith-jones" and "o'brien" are stored whole and as each part.
      for (const p of [f, ...f.split(/['-]+/)]) if (p.length >= MIN_TOKEN && !STOP.has(p)) tokens.add(p);
    }
  }
  return { fullNames, tokens, unspaced, unspacedMax, size: tokens.size + fullNames.size + unspaced.size };
}

export const EMPTY_DICTIONARY = Object.freeze(buildNameDictionary({ names: [] }));

/** Both dictionaries' names in one (a frame's own parties on top of the global set). */
export function unionDictionaries(a, b) {
  if (!b?.size) return a;
  if (!a?.size) return b;
  const fullNames = new Set([...a.fullNames, ...b.fullNames]);
  const tokens = new Set([...a.tokens, ...b.tokens]);
  const unspaced = new Set([...a.unspaced, ...b.unspaced]);
  return { fullNames, tokens, unspaced, unspacedMax: Math.max(a.unspacedMax, b.unspacedMax), size: tokens.size + fullNames.size + unspaced.size };
}

const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
// A run that starts and ends on a digit, at most one leading '+' and '('.
const PHONE = /(?<![\p{L}\p{N}+])\+?\(?\d[\d\s().-]{5,18}\d(?![\p{L}\p{N}])/gu;
const DATE_LIKE = /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})$/;

// A word as it is written lowercase, Capitalised or ALL CAPS ("street", "Street", "STREET").
const forms = (w) => [...new Set([w, w[0].toUpperCase() + w.slice(1), w.toUpperCase()])]
  .map((x) => x.replace(/\./g, '\\.')).join('|');
// Same without the lowercase form, for words that lead a street name ("via" alone is a preposition).
const leadForms = (w) => [...new Set([w[0].toUpperCase() + w.slice(1), w.toUpperCase()])]
  .map((x) => x.replace(/\./g, '\\.')).join('|');
// ponytail: guessed street-word list for EN/LT/DE/FR/ES/IT; add a word when a real address leaks.
const STREET_WORDS = ['street', 'st', 'avenue', 'ave', 'road', 'rd', 'lane', 'ln', 'boulevard', 'blvd',
  'drive', 'dr', 'court', 'ct', 'way', 'place', 'pl', 'square', 'sq', 'gatvė', 'g', 'prospektas', 'pr',
  'alėja', 'al', 'parkway', 'pkwy', 'terrace', 'close', 'crescent', 'gardens', 'mews', 'highway', 'hwy']
  .map(forms).join('|');
const LEAD_WORDS = ['rue', 'calle', 'via', 'avenida', 'avenue', 'piazza', 'plaza', 'ulica', 'ul.'].map(leadForms).join('|');
const SP = '[ \\t]+';
const WORD = "\\p{Lu}[\\p{L}\\p{M}'’-]*";
const HOUSE = '\\d{1,5}[A-Za-z]?(?:[-/]\\d{1,4})?';
const SUFFIX_STREET = ['straße', 'strasse', 'str.', 'weg', 'platz', 'allee'].map(forms).join('|');
// "221B Baker Street"
const ADDR_NUM_FIRST = new RegExp(`(?<![\\p{L}\\p{N}])${HOUSE}${SP}(?:${WORD}${SP}){1,3}(?:${STREET_WORDS})\\.?(?![\\p{L}])`, 'gu');
// "Gedimino pr. 9", "Baker Street 221", "Hauptstraße 5"
const ADDR_NUM_LAST = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${WORD}${SP}){0,3}(?:\\p{Lu}[\\p{L}\\p{M}'’-]*(?:${SUFFIX_STREET})|${WORD}${SP}(?:${STREET_WORDS})\\.?)${SP}${HOUSE}(?![\\p{L}\\p{N}])`,
  'gu',
);
// "10 Rue Lafayette", "Calle Mayor 5", "Via Roma 10"
// ponytail: street names without a street word ("Unter den Linden 5") are not detected; the number alone is not worth the false positives.
const ADDR_LEAD = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${HOUSE}${SP})?(?:${LEAD_WORDS})${SP}${WORD}(?:${SP}${WORD}){0,2}(?:${SP}${HOUSE})?(?![\\p{L}\\p{N}])`,
  'gu',
);
// A postcode (and optional city) right after an address match, on the same line.
const POSTCODE_TAIL = new RegExp(`[, \\t]+(?:LT-?\\d{5}|\\d{4,5}|[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2})(?:${SP}${WORD})?`, 'uy');
const LT_POSTCODE = /(?<![\p{L}\p{N}])LT-\d{5}(?!\d)/gu;

const PRIORITY = { email: 0, address: 1, phone: 2, name: 3 };

function collect(re, text, kind, out) {
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length, kind });
  }
}

// ponytail: 7-15 digits is the E.164 range; national numbers shorter than 7 are not detected.
function phoneOk(s) {
  const digits = s.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15 && !DATE_LIKE.test(s.trim());
}

// A rejected run ("01.10.2026 861234567") may still hold a phone: retry on
// the run minus its leading and/or trailing whitespace-separated groups.
function phones(text, out) {
  PHONE.lastIndex = 0;
  for (let m = PHONE.exec(text); m; m = PHONE.exec(text)) {
    const groups = [...m[0].matchAll(/\S+/g)].map(g => ({ start: m.index + g.index, end: m.index + g.index + g[0].length }));
    const seen = new Set();
    const visit = (lo, hi) => {
      const key = lo * 64 + hi;
      if (seen.has(key)) return;
      seen.add(key);
      const start = groups[lo].start;
      const end = groups[hi - 1].end;
      if (phoneOk(text.slice(start, end))) out.push({ start, end, kind: 'phone' });
      else if (hi - lo > 1) { visit(lo + 1, hi); visit(lo, hi - 1); }
    };
    if (groups.length) visit(0, groups.length);
  }
}

const SPACE_ONLY = /^\s+$/;
const stripPossessive = (f) => f.replace(/'s$/, '').replace(/['-]+$/, '');

function names(text, dict, out) {
  if (!dict?.size) return;
  const toks = [];
  NAME_TOKEN.lastIndex = 0;
  for (let m = NAME_TOKEN.exec(text); m; m = NAME_TOKEN.exec(text)) {
    const f = stripPossessive(foldName(m[0]));
    // "Smith-Jones" is also looked up as "smith" and "jones".
    const parts = /['-]/.test(f) ? f.split(/['-]+/) : null;
    toks.push({ start: m.index, end: m.index + m[0].length, raw: m[0], f, parts });
  }
  const hit = new Array(toks.length).fill(false);
  // Full names: windows of 2 and 3 tokens joined only by whitespace.
  for (let i = 0; i < toks.length; i++) {
    for (const len of [3, 2]) {
      const last = i + len - 1;
      if (last >= toks.length) continue;
      let joined = true;
      for (let k = i; k < last; k++) if (!SPACE_ONLY.test(text.slice(toks[k].end, toks[k + 1].start))) joined = false;
      if (!joined) continue;
      if (dict.fullNames.has(toks.slice(i, last + 1).map(t => t.f).join(' '))) {
        for (let k = i; k <= last; k++) hit[k] = true;
      }
    }
  }
  toks.forEach((t, i) => {
    if (hit[i]) return;
    // Scripts without capitals (CJK, Arabic, Hebrew, Thai) have no uppercase to look for.
    if (!STARTS_UPPER.test(t.raw) && HAS_CASE.test(t.raw)) return;
    if (dict.tokens.has(t.f) || (t.parts && t.parts.some(p => dict.tokens.has(p)))) hit[i] = true;
  });
  // Adjacent hits joined only by whitespace become one span.
  for (let i = 0; i < toks.length; i++) {
    if (!hit[i]) continue;
    let j = i;
    while (j + 1 < toks.length && hit[j + 1] && SPACE_ONLY.test(text.slice(toks[j].end, toks[j + 1].start))) j++;
    out.push({ start: toks[i].start, end: toks[j].end, kind: 'name' });
    i = j;
  }
  // Names in unspaced scripts: every window of a run, up to the longest dictionary entry.
  if (dict.unspaced?.size) {
    UNSPACED_RUN.lastIndex = 0;
    for (let m = UNSPACED_RUN.exec(text); m; m = UNSPACED_RUN.exec(text)) {
      const run = m[0];
      for (let i = 0; i < run.length; i++) {
        for (let len = Math.min(dict.unspacedMax, run.length - i); len >= 2; len--) {
          if (dict.unspaced.has(run.slice(i, i + len))) {
            out.push({ start: m.index + i, end: m.index + i + len, kind: 'name' });
            break;
          }
        }
      }
    }
  }
}

export function findPii(text, dict = EMPTY_DICTIONARY) {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  const found = [];
  collect(EMAIL, s, 'email', found);
  const addrs = [];
  collect(ADDR_NUM_FIRST, s, 'address', addrs);
  collect(ADDR_NUM_LAST, s, 'address', addrs);
  collect(ADDR_LEAD, s, 'address', addrs);
  for (const a of addrs) {
    POSTCODE_TAIL.lastIndex = a.end;
    const tail = POSTCODE_TAIL.exec(s);
    if (tail) a.end += tail[0].length;
    found.push(a);
  }
  collect(LT_POSTCODE, s, 'address', found);
  phones(s, found);
  names(s, dict, found);
  if (!found.length) return [];

  // Highest priority first, then longest. A span that overlaps one already kept
  // keeps only its uncovered pieces: dropping it whole would leak the rest.
  found.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || (b.end - b.start) - (a.end - a.start));
  const covered = new Uint8Array(s.length);
  const kept = [];
  for (const f of found) {
    for (let i = f.start; i < f.end;) {
      while (i < f.end && covered[i]) i++;
      let j = i;
      while (j < f.end && !covered[j]) j++;
      let a = i;
      let b = j;
      while (a < b && /\s/.test(s[a])) a++;
      while (b > a && /\s/.test(s[b - 1])) b--;
      if (/[\p{L}\p{N}]/u.test(s.slice(a, b))) kept.push({ start: a, end: b, kind: f.kind });
      i = j;
    }
    covered.fill(1, f.start, f.end);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// One x per letter or digit (marks fold into their base letter), never derived from the real char.
export function maskText(s) {
  return String(s ?? '').replace(/[\p{L}\p{N}]\p{M}*/gu, 'x').replace(/\p{M}+/gu, '');
}

export function maskString(text, dict = EMPTY_DICTIONARY) {
  const s = String(text ?? '');
  const spans = findPii(s, dict);
  if (!spans.length) return s;
  let out = '';
  let last = 0;
  for (const { start, end } of spans) {
    out += s.slice(last, start) + maskText(s.slice(start, end));
    last = end;
  }
  return out + s.slice(last);
}
