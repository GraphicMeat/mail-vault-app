// src/utils/privacy/piiDetector.js
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
const STOP = new Set([
  'will', 'mark', 'may', 'june', 'july', 'april', 'august', 'bill', 'post', 'rose', 'grace', 'hope',
  'joy', 'faith', 'max', 'sky', 'dean', 'chase', 'page', 'king', 'young', 'long', 'white', 'black',
  'brown', 'green', 'gray', 'grey', 'hall', 'wood', 'love', 'star', 'son', 'van', 'von', 'der', 'den',
  'del', 'della', 'team', 'support', 'info', 'admin', 'mail', 'news', 'hello', 'dear', 'thanks',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'september', 'october', 'november', 'december',
  'the', 'and', 'for', 'from', 'new', 'not', 'you', 'your', 'our', 'this', 'that',
]);

const NAME_TOKEN = /\p{L}[\p{L}\p{M}'’-]*/gu;
const STARTS_UPPER = /^\p{Lu}/u;

export function foldName(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC').toLowerCase();
}

export function buildNameDictionary({ names = [] } = {}) {
  const fullNames = new Set();
  const tokens = new Set();
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name || name.includes('@')) continue;
    const folded = (name.match(NAME_TOKEN) || []).map(foldName);
    if (!folded.length) continue;
    if (folded.length > 1) fullNames.add(folded.join(' '));
    for (const f of folded) if (f.length >= 3 && !STOP.has(f)) tokens.add(f);
  }
  return { fullNames, tokens, size: tokens.size + fullNames.size };
}

export const EMPTY_DICTIONARY = Object.freeze(buildNameDictionary({ names: [] }));

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
// A run that starts and ends on a digit, at most one leading '+' and '('.
const PHONE = /(?<![\p{L}\p{N}+])\+?\(?\d[\d\s().-]{5,18}\d(?![\p{L}\p{N}])/gu;
const DATE_LIKE = /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})$/;

const cap = (w) => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`;
const STREET_WORDS = ['street', 'st', 'avenue', 'ave', 'road', 'rd', 'lane', 'ln', 'boulevard', 'blvd',
  'drive', 'dr', 'court', 'ct', 'way', 'place', 'pl', 'square', 'sq', 'gatvė', 'g', 'prospektas', 'pr',
  'alėja', 'al', 'rue', 'calle', 'via'].map(cap).join('|');
const WORD = "\\p{Lu}[\\p{L}\\p{M}'’-]*";
const HOUSE = '\\d{1,5}[A-Za-z]?(?:[-/]\\d{1,4})?';
// "221B Baker Street"
const ADDR_NUM_FIRST = new RegExp(`(?<![\\p{L}\\p{N}])${HOUSE}\\s+(?:${WORD}\\s+){1,3}(?:${STREET_WORDS})\\.?(?![\\p{L}])`, 'gu');
// "Gedimino pr. 9", "Baker Street 221", "Hauptstraße 5"
const ADDR_NUM_LAST = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${WORD}\\s+){0,3}(?:\\p{Lu}[\\p{L}\\p{M}'’-]*(?:straße|strasse|str\\.|weg|platz|allee)|${WORD}\\s+(?:${STREET_WORDS})\\.?)\\s+${HOUSE}(?![\\p{L}\\p{N}])`,
  'gu',
);
// A postcode (and optional city) right after an address match.
const POSTCODE_TAIL = new RegExp(`^[,\\s]+(?:LT-?\\d{5}|\\d{4,5}|[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2})(?:\\s+${WORD})?`, 'u');
const LT_POSTCODE = /(?<![\p{L}\p{N}])LT-\d{5}(?!\d)/gu;

const PRIORITY = { email: 0, address: 1, phone: 2, name: 3 };

function collect(re, text, kind, out, accept = () => true) {
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (accept(m[0])) out.push({ start: m.index, end: m.index + m[0].length, kind });
  }
}

function phoneOk(s) {
  const digits = s.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15 && !DATE_LIKE.test(s.trim());
}

function names(text, dict, out) {
  if (!dict?.size) return;
  const toks = [];
  NAME_TOKEN.lastIndex = 0;
  for (let m = NAME_TOKEN.exec(text); m; m = NAME_TOKEN.exec(text)) {
    toks.push({ start: m.index, end: m.index + m[0].length, raw: m[0], f: foldName(m[0]) });
  }
  const hit = new Array(toks.length).fill(false);
  // Full names: windows of 2 and 3 tokens joined only by whitespace.
  for (let i = 0; i < toks.length; i++) {
    for (const len of [3, 2]) {
      const last = i + len - 1;
      if (last >= toks.length) continue;
      let joined = true;
      for (let k = i; k < last; k++) if (!/^\s+$/.test(text.slice(toks[k].end, toks[k + 1].start))) joined = false;
      if (!joined) continue;
      if (dict.fullNames.has(toks.slice(i, last + 1).map(t => t.f).join(' '))) {
        for (let k = i; k <= last; k++) hit[k] = true;
      }
    }
  }
  toks.forEach((t, i) => {
    if (!hit[i] && dict.tokens.has(t.f) && STARTS_UPPER.test(t.raw)) hit[i] = true;
  });
  // Adjacent hits joined only by whitespace become one span.
  for (let i = 0; i < toks.length; i++) {
    if (!hit[i]) continue;
    let j = i;
    while (j + 1 < toks.length && hit[j + 1] && /^\s+$/.test(text.slice(toks[j].end, toks[j + 1].start))) j++;
    out.push({ start: toks[i].start, end: toks[j].end, kind: 'name' });
    i = j;
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
  for (const a of addrs) {
    const tail = POSTCODE_TAIL.exec(s.slice(a.end));
    if (tail) a.end += tail[0].length;
    found.push(a);
  }
  collect(LT_POSTCODE, s, 'address', found);
  collect(PHONE, s, 'phone', found, phoneOk);
  names(s, dict, found);

  // Highest priority first, then longest; drop anything overlapping a kept span.
  found.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || (b.end - b.start) - (a.end - a.start));
  const covered = new Uint8Array(s.length);
  const kept = [];
  for (const f of found) {
    let free = true;
    for (let i = f.start; i < f.end; i++) if (covered[i]) { free = false; break; }
    if (!free) continue;
    covered.fill(1, f.start, f.end);
    kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function maskText(s) {
  return String(s ?? '').replace(/[\p{L}\p{N}]/gu, 'x');
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
