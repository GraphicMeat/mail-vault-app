#!/usr/bin/env node
/*
 * Static localization for mailvaultapp.com.
 *
 * The English HTML under website/ stays the single source of truth and is edited
 * by hand exactly as before. This script does three things:
 *
 *   extract  scan the English pages, collect every translatable string into
 *            i18n/strings.json, and seed i18n/locales/<lang>.json with the keys
 *            that still need a translation.
 *   inject   add the hreflang block and the footer language switcher to the
 *            English sources, in place and idempotently (marker-delimited).
 *   build    emit website/<lang>/** from the English sources plus the locale
 *            JSON, and regenerate sitemap.xml with per-locale <url> entries.
 *
 * A missing key falls back to English, so a half-translated locale ships a
 * readable page rather than a hole. Nothing here parses HTML into a DOM: the
 * tokenizer records byte ranges and substitutes into them, so every byte the
 * translation does not touch survives untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ORIGIN = 'https://mailvaultapp.com';
const ORIGIN_RE = /https:\/\/mailvaultapp\.com([^"\\]*)/g;

// Order, flags and endonyms match graphicmeat.com's picker, so the two sites
// read as one family. A flag is a country and not a language — the endonym is
// what actually carries the meaning, and it stays in the DOM for screen readers
// and crawlers even though the row shows only flags.
export const LOCALES = [
  { dir: 'de',    hreflang: 'de',      htmlLang: 'de',      ogLocale: 'de_DE', flag: '🇩🇪', name: 'Deutsch' },
  { dir: 'fr',    hreflang: 'fr',      htmlLang: 'fr',      ogLocale: 'fr_FR', flag: '🇫🇷', name: 'Français' },
  { dir: 'es',    hreflang: 'es',      htmlLang: 'es',      ogLocale: 'es_ES', flag: '🇪🇸', name: 'Español' },
  { dir: 'it',    hreflang: 'it',      htmlLang: 'it',      ogLocale: 'it_IT', flag: '🇮🇹', name: 'Italiano' },
  { dir: 'ja',    hreflang: 'ja',      htmlLang: 'ja',      ogLocale: 'ja_JP', flag: '🇯🇵', name: '日本語' },
  { dir: 'ko',    hreflang: 'ko',      htmlLang: 'ko',      ogLocale: 'ko_KR', flag: '🇰🇷', name: '한국어' },
  { dir: 'zh',    hreflang: 'zh-Hans', htmlLang: 'zh-Hans', ogLocale: 'zh_CN', flag: '🇨🇳', name: '简体中文' },
  { dir: 'pt-br', hreflang: 'pt-BR',   htmlLang: 'pt-BR',   ogLocale: 'pt_BR', flag: '🇧🇷', name: 'Português (Brasil)' },
];
const EN = { hreflang: 'en', flag: '🇬🇧', name: 'English' };

// Pages deliberately left in English. changelog.html is generated from
// CHANGELOG.md and rewritten on every release; privacy/terms are legal text we
// keep authoritative in one language; the rest are machine or ops surfaces.
const EXCLUDE = new Set([
  'changelog.html',
  'privacy.html',
  'terms.html',
  'download-stats.html',
  'oauth/yahoo/callback.html',
]);

const PAGE_DIRS = ['', 'blog', 'guides', 'compare', 'features'];

export function sourcePages() {
  const out = [];
  for (const d of PAGE_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.html')) continue;
      const rel = d ? `${d}/${f}` : f;
      if (EXCLUDE.has(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

// ---------------------------------------------------------------- tokenizer

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Text inside these never reaches a reader as prose (or is code we must not touch).
const OPAQUE = new Set(['script', 'style', 'svg', 'code', 'pre', 'textarea']);

const TAG_RE = new RegExp([
  '<!--[\\s\\S]*?-->',
  '<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  '<!doctype[^>]*>',
  '<\\/([a-zA-Z][\\w:-]*)\\s*>',
  '<([a-zA-Z][\\w:-]*)((?:\\s+[^\\s\\/>"\'=]+(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'>]+))?)*)\\s*\\/?>',
].join('|'), 'gi');

const ATTR_RE = /([^\s/>"'=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(attrText, base) {
  const out = {};
  if (!attrText) return out;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrText))) {
    const name = m[1].toLowerCase();
    let value = '', vs = -1, ve = -1;
    if (m[2] !== undefined) { value = m[2]; }
    else if (m[3] !== undefined) { value = m[3]; }
    else if (m[4] !== undefined) { value = m[4]; }
    if (value !== '') {
      vs = base + m.index + m[0].lastIndexOf(value);
      ve = vs + value.length;
    }
    if (!(name in out)) out[name] = { value, vs, ve };
  }
  return out;
}

/*
 * One pass over the document. Returns the byte ranges we may rewrite: prose text
 * runs, translatable attribute values, JSON-LD payloads, and every tag (so the
 * URL rewriter can find href/src without a second scan).
 */
// A sentence lives in one of these. Split by inline markup, its pieces are not
// translatable units: `in`, `stored in`, `Only the`, `does` each came back from a
// different translator as a fragment they had to smuggle words across.
const SENTENCE = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th',
  'dd', 'dt', 'figcaption', 'blockquote', 'summary']);
// ...but only when it holds a sentence and not more structure, or one <li> with a
// nested list would swallow the whole list as a single string.
const STRUCTURE = /<(p|div|ul|ol|li|table|thead|tbody|tr|td|th|section|article|aside|nav|header|footer|form|dl|h[1-6])\b/i;

/*
 * A heading split for emphasis — "Simple, <span>Honest</span> Pricing" — is one
 * sentence, not three. Translated as separate fragments its word order is frozen
 * by the markup, which produces "Sencillo y honesto Precios". An element marked
 * data-i18n-block is therefore lifted whole, inner markup included, so the
 * translator can move the emphasis to wherever the target language puts it.
 */
// Counting fragments must never recurse into scan(): every ancestor would
// re-scan its descendants, which is exponential in nesting depth and ate 4 GB on
// docs.html. A flat split on tags answers "more than one piece?" in one pass.
function fragmentCount(inner) {
  let n = 0;
  for (const piece of inner.replace(OPAQUE_RE, ' ').split(/<[^>]+>/)) {
    if (isTranslatable(piece) && ++n > 1) return n;
  }
  return n;
}

const OPAQUE_RE = /<(script|style|svg)\b[\s\S]*?<\/\1>/gi;
const CLOSE_RE = new Map();

function matchingClose(html, name, from) {
  if (!CLOSE_RE.has(name)) CLOSE_RE.set(name, new RegExp(`<${name}\\b[^>]*>|<\\/${name}\\s*>`, 'gi'));
  const re = CLOSE_RE.get(name);
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') { if (!--depth) return m.index; }
    else if (!/\/\s*>$/.test(m[0])) depth++;
  }
  return -1;
}

export function scan(html) {
  const texts = [], tags = [], jsonlds = [], blocks = [];
  const stack = [];
  let opaque = 0, noTranslate = 0, prev = 0;

  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html))) {
    if (m.index > prev && !opaque && !noTranslate) {
      // The innermost open element, so a collision sweep can tell a nav link
      // from a table header that happens to share its wording.
      const owner = stack.length ? stack[stack.length - 1].name : null;
      texts.push({ start: prev, end: m.index, raw: html.slice(prev, m.index), tag: owner });
    }
    prev = TAG_RE.lastIndex;

    const close = m[1] && m[1].toLowerCase();
    const open = m[2] && m[2].toLowerCase();

    if (close) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === close) {
          for (let j = stack.length - 1; j >= i; j--) {
            if (stack[j].opaque) opaque--;
            if (stack[j].noTranslate) noTranslate--;
          }
          stack.length = i;
          break;
        }
      }
    } else if (open) {
      const attrBase = m.index + m[0].indexOf(m[3] || '', 1 + open.length);
      const attrs = parseAttrs(m[3] || '', m[3] ? attrBase : 0);
      tags.push({ name: open, start: m.index, end: TAG_RE.lastIndex, attrs });

      const selfClosing = VOID.has(open) || /\/\s*>$/.test(m[0]);
      const isOpaque = OPAQUE.has(open);
      const noTr = (attrs.translate && attrs.translate.value.toLowerCase() === 'no')
        || 'data-i18n-skip' in attrs;

      // JSON-LD is machine-readable prose: FAQ answers and product descriptions
      // that Google reads. Translate the payload, not the schema.
      // JSON-LD is prose Google reads; an application/json block is prose the
      // page's own scripts read (button labels, form status messages). Both are
      // strings a reader sees, so both get translated.
      if (open === 'script' && attrs.type
          && /ld\+json|application\/json/.test(attrs.type.value.toLowerCase())) {
        const close = html.toLowerCase().indexOf('</script', TAG_RE.lastIndex);
        const end = close === -1 ? html.length : close;
        jsonlds.push({ start: TAG_RE.lastIndex, end, raw: html.slice(TAG_RE.lastIndex, end) });
        TAG_RE.lastIndex = end;
        prev = end;
        continue;
      }

      const marked = 'data-i18n-block' in attrs;
      if ((marked || SENTENCE.has(open)) && !selfClosing && !isOpaque && !noTr) {
        const closeAt = matchingClose(html, open, TAG_RE.lastIndex);
        const inner = closeAt === -1 ? '' : html.slice(TAG_RE.lastIndex, closeAt);
        // Split into more than one piece? Then the whole element is the unit.
        const split = marked
          || (inner.includes('<') && !STRUCTURE.test(inner) && fragmentCount(inner) > 1);
        if (closeAt !== -1 && split) {
          blocks.push({ start: TAG_RE.lastIndex, end: closeAt, raw: inner });
          TAG_RE.lastIndex = closeAt;
          prev = closeAt;
          continue;
        }
      }

      if (!selfClosing) {
        stack.push({ name: open, opaque: isOpaque, noTranslate: noTr });
        if (isOpaque) opaque++;
        if (noTr) noTranslate++;
      } else if (!isOpaque && !noTr) {
        // Void elements still carry translatable attributes (alt, meta content).
      }
      if (selfClosing && noTr) tags[tags.length - 1].selfNoTranslate = true;
    }
  }
  if (prev < html.length && !opaque && !noTranslate) {
    texts.push({ start: prev, end: html.length, raw: html.slice(prev, html.length) });
  }
  return { texts, tags, jsonlds, blocks };
}

// ------------------------------------------------------------ string picking

const TRANSLATABLE_ATTRS = new Set(['alt', 'title', 'placeholder', 'aria-label', 'data-mv-price']);
const META_KEYS = new Set(['description', 'og:title', 'og:description', 'og:image:alt',
  'twitter:title', 'twitter:description', 'twitter:image:alt', 'apple-mobile-web-app-title']);

// Proper nouns and wordmark fragments. Translating them is a no-op at best and
// a mangled brand at worst, and they account for a large share of the corpus.
const BRAND = new Set(['mailvault', 'mail', 'vault', 'graphicmeat', 'graphic meat',
  'github', 'x / twitter', 'imap', 'smtp', 'macos', 'linux', 'windows', 'gmail',
  'outlook', 'icloud', 'yahoo', 'thunderbird', 'apple mail', 'mailstore',
  'proton', 'stripe', 'sparkle', 'rust', 'tauri', '&copy;', 'v', '·', '—']);

export function normalize(s) {
  return s.replace(/\s+/g, ' ').trim();
}

export function keyOf(s) {
  return crypto.createHash('sha1').update(normalize(s), 'utf8').digest('hex').slice(0, 12);
}

export function isTranslatable(s) {
  const n = normalize(s);
  if (!n) return false;
  if (!/\p{L}/u.test(n)) return false;          // punctuation, numbers, arrows
  if (BRAND.has(n.toLowerCase())) return false;
  if (/^[\d\s.,:;/+%-]+$/.test(n)) return false;
  return true;
}

// JSON-LD values that are identifiers, URLs, dates or codes — never prose.
const LD_SKIP_KEYS = new Set(['@context', '@type', '@id', 'url', 'sameas', 'image',
  'logo', 'datepublished', 'datemodified', 'pricecurrency', 'price', 'sku', 'gtin',
  'ratingvalue', 'bestrating', 'worstrating', 'ratingcount', 'reviewcount',
  'operatingsystem', 'applicationcategory', 'availability', 'itemcondition',
  'validfrom', 'priceValidUntil'.toLowerCase(), 'contenturl', 'email', 'telephone',
  'addresscountry', 'inlanguage', 'position', 'target', 'querystring']);

function walkLd(node, key, fn) {
  if (Array.isArray(node)) return node.map((v) => walkLd(v, key, fn));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walkLd(v, k.toLowerCase(), fn);
    return out;
  }
  if (typeof node === 'string') {
    if (key && LD_SKIP_KEYS.has(key)) return node;
    if (/^(https?:|mailto:|tel:|\/)/i.test(node)) return node;
    if (!isTranslatable(node)) return node;
    return fn(node);
  }
  return node;
}

/*
 * Every translatable string in one document, as {key, text} pairs. Used by both
 * extract (to build the corpus) and build (to substitute).
 */
export function collect(html) {
  const { texts, tags, jsonlds, blocks } = scan(html);
  const found = [];

  for (const b of blocks) {
    if (!isTranslatable(b.raw.replace(/<[^>]+>/g, ' '))) continue;
    found.push({ key: keyOf(b.raw), text: normalize(b.raw) });
  }

  for (const t of texts) {
    if (isTranslatable(t.raw)) found.push({ key: keyOf(t.raw), text: normalize(t.raw) });
  }
  for (const tag of tags) {
    for (const [name, a] of Object.entries(tag.attrs)) {
      if (a.vs < 0) continue;
      if (!attrIsTranslatable(tag, name)) continue;
      if (!isTranslatable(a.value)) continue;
      found.push({ key: keyOf(a.value), text: normalize(a.value) });
    }
  }

  for (const ld of jsonlds) {
    let data;
    try { data = JSON.parse(ld.raw); } catch { continue; }
    walkLd(data, null, (s) => { found.push({ key: keyOf(s), text: normalize(s) }); return s; });
  }
  return found;
}

function attrIsTranslatable(tag, name) {
  if (tag.selfNoTranslate) return false;
  if (TRANSLATABLE_ATTRS.has(name)) return true;
  if (tag.name === 'meta' && name === 'content') {
    const id = (tag.attrs.name || tag.attrs.property || {}).value;
    return !!id && META_KEYS.has(id.toLowerCase());
  }
  return false;
}

// ------------------------------------------------------------------- URLs

const LOCALIZABLE = new Set();
for (const rel of sourcePages()) LOCALIZABLE.add(rel === 'index.html' ? '/' : `/${rel}`);

export function urlPathOf(rel) { return rel === 'index.html' ? '/' : `/${rel}`; }

function absolutize(url, pageRel) {
  if (!url) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#')) return null;
  const cut = url.search(/[?#]/);
  const p = cut === -1 ? url : url.slice(0, cut);
  const suffix = cut === -1 ? '' : url.slice(cut);
  if (!p) return null;
  const dir = path.posix.dirname(`/${pageRel}`);
  const abs = p.startsWith('/') ? path.posix.normalize(p)
    : path.posix.normalize(path.posix.join(dir, p));
  return { abs, suffix };
}

/**
 * A screenshot that exists in the locale's own directory wins; everything else
 * stays English. The listing is read once per locale — a build touches ~40
 * pages and would otherwise stat the same 500 paths on every one of them.
 */
const SHOT_INDEX = new Map();
function shotsFor(dir) {
  if (!SHOT_INDEX.has(dir)) {
    const at = path.join(ROOT, 'screenshots', dir);
    SHOT_INDEX.set(dir, new Set(fs.existsSync(at) ? fs.readdirSync(at) : []));
  }
  return SHOT_INDEX.get(dir);
}

export function localizeShot(abs, loc) {
  const m = /^\/screenshots\/([^/]+)$/.exec(abs);
  if (!m) return abs;
  return shotsFor(loc.dir).has(m[1]) ? `/screenshots/${loc.dir}/${m[1]}` : abs;
}

/**
 * `srcset` is a comma-separated list of "<url> <descriptor>", and it was never
 * in the URL loop below — so every localized page shipped an absolute `src`
 * beside relative candidates that resolve under /<dir>/ and 404. A browser that
 * picks a srcset candidate does not fall back to `src`, which made those broken
 * images rather than silent downgrades.
 */
export function rewriteSrcset(value, pageRel, loc) {
  return value.split(',').map((part) => {
    const t = part.trim();
    if (!t) return null;
    const sp = t.search(/\s/);
    const url = sp === -1 ? t : t.slice(0, sp);
    const descriptor = sp === -1 ? '' : t.slice(sp);
    const r = absolutize(url, pageRel);
    if (!r) return t;
    const abs = localizePath(r.abs, loc) || localizeShot(r.abs, loc);
    return abs + r.suffix + descriptor;
  }).filter(Boolean).join(', ');
}

export function localizePath(abs, loc) {
  if (abs === '/index.html') abs = '/';
  if (!LOCALIZABLE.has(abs)) return null;
  return abs === '/' ? `/${loc.dir}/` : `/${loc.dir}${abs}`;
}

// --------------------------------------------------------------- rendering

function applyEdits(src, edits) {
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  let last = Infinity;
  for (const e of edits) {
    if (e.end > last) continue;           // overlapping edit: first one wins
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    last = e.start;
  }
  return out;
}

const ESC = (s) => s.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');

export function render(html, pageRel, loc, dict) {
  const { texts, tags, jsonlds, blocks } = scan(html);
  const edits = [];
  const tr = (s) => {
    const v = dict[keyOf(s)];
    return (typeof v === 'string' && v.trim()) ? v : normalize(s);
  };

  for (const t of texts) {
    if (!isTranslatable(t.raw)) continue;
    const lead = t.raw.match(/^\s*/)[0];
    const tail = t.raw.match(/\s*$/)[0];
    edits.push({ start: t.start, end: t.end, text: lead + tr(t.raw) + tail });
  }

  for (const b of blocks) {
    if (!isTranslatable(b.raw.replace(/<[^>]+>/g, ' '))) continue;
    const lead = b.raw.match(/^\s*/)[0];
    const tail = b.raw.match(/\s*$/)[0];
    edits.push({ start: b.start, end: b.end, text: lead + rewriteUrls(tr(b.raw), pageRel, loc) + tail });
  }

  for (const ld of jsonlds) {
    let data;
    try { data = JSON.parse(ld.raw); } catch { continue; }
    const out = walkLd(data, null, tr);
    // walkLd deliberately leaves URLs alone as *strings*; they still have to point
    // at this locale's copy, or the structured data declares the German page to be
    // the English one.
    const json = JSON.stringify(out, null, 2)
      .replace(ORIGIN_RE, (m, rest) => {
        const cut = rest.search(/[?#]/);
        const p = (cut === -1 ? rest : rest.slice(0, cut)) || '/';
        const suffix = cut === -1 ? '' : rest.slice(cut);
        return ORIGIN + (localizePath(p, loc) || p) + suffix;
      })
      .replace(/<\/script/gi, '<\\/script');
    edits.push({ start: ld.start, end: ld.end, text: `\n${json}\n  ` });
  }

  const pageUrl = ORIGIN + (localizePath(urlPathOf(pageRel), loc) || urlPathOf(pageRel));

  // The switcher markup is identical on every copy, so the "you are here" state
  // has to be moved to this locale's own link at render time.
  const en = html.indexOf('data-lang="en"');
  if (en !== -1) {
    const marker = ' aria-current="page"';
    const at = html.indexOf(marker, en);
    const tagEnd = html.indexOf('>', en);
    if (at !== -1 && at < tagEnd) edits.push({ start: at, end: at + marker.length, text: '' });
  }
  const cur = html.indexOf(`data-lang="${loc.hreflang}"`);
  if (cur !== -1) {
    const at = html.indexOf('>', html.indexOf('href=', cur));
    if (at !== -1) edits.push({ start: at, end: at, text: ' aria-current="page"' });
  }

  for (const tag of tags) {
    const a = tag.attrs;

    if (tag.name === 'html' && a.lang && a.lang.vs >= 0) {
      edits.push({ start: a.lang.vs, end: a.lang.ve, text: loc.htmlLang });
    }

    // Canonical, og:url and og:locale must point at this locale's copy, or the
    // translated page tells Google it is a duplicate of the English one.
    if (tag.name === 'link' && a.rel && a.rel.value.toLowerCase() === 'canonical' && a.href) {
      edits.push({ start: a.href.vs, end: a.href.ve, text: pageUrl });
      continue;
    }
    if (tag.name === 'meta' && a.content && a.content.vs >= 0) {
      const id = ((a.property || a.name || {}).value || '').toLowerCase();
      if (id === 'og:url') { edits.push({ start: a.content.vs, end: a.content.ve, text: pageUrl }); continue; }
      if (id === 'og:locale') { edits.push({ start: a.content.vs, end: a.content.ve, text: loc.ogLocale }); continue; }
    }

    for (const [name, at] of Object.entries(a)) {
      if (at.vs < 0) continue;
      if (attrIsTranslatable(tag, name) && isTranslatable(at.value)) {
        edits.push({ start: at.vs, end: at.ve, text: ESC(tr(at.value)) });
      }
      if ((name === 'href' || name === 'src') && !('data-i18n-abs' in a)) {
        const r = absolutize(at.value, pageRel);
        if (!r) continue;
        const localized = localizePath(r.abs, loc);
        const next = (localized || localizeShot(r.abs, loc)) + r.suffix;
        if (next !== at.value) edits.push({ start: at.vs, end: at.ve, text: next });
      }
      if ((name === 'srcset' || name === 'imagesrcset') && !('data-i18n-abs' in a)) {
        const next = rewriteSrcset(at.value, pageRel, loc);
        if (next !== at.value) edits.push({ start: at.vs, end: at.ve, text: next });
      }
    }
  }

  return applyEdits(html, edits);
}

/*
 * A block is substituted whole, so the tags inside it never pass the main URL
 * loop. Rewrite them on the translated fragment instead — 65 of the split
 * sentences contain a link, and they would otherwise all point at the English
 * page from every locale.
 */
export function rewriteUrls(fragment, pageRel, loc) {
  const edits = [];
  for (const tag of scan(fragment).tags) {
    if ('data-i18n-abs' in tag.attrs) continue;
    for (const name of ['href', 'src']) {
      const at = tag.attrs[name];
      if (!at || at.vs < 0) continue;
      const r = absolutize(at.value, pageRel);
      if (!r) continue;
      const next = (localizePath(r.abs, loc) || localizeShot(r.abs, loc)) + r.suffix;
      if (next !== at.value) edits.push({ start: at.vs, end: at.ve, text: next });
    }
    for (const name of ['srcset', 'imagesrcset']) {
      const at = tag.attrs[name];
      if (!at || at.vs < 0) continue;
      const next = rewriteSrcset(at.value, pageRel, loc);
      if (next !== at.value) edits.push({ start: at.vs, end: at.ve, text: next });
    }
  }
  return applyEdits(fragment, edits);
}

// ---------------------------------------------------------------- injection

function alternatesBlock(rel) {
  const p = urlPathOf(rel);
  const lines = [`  <link rel="alternate" hreflang="en" href="${ORIGIN}${p}">`];
  for (const loc of LOCALES) {
    lines.push(`  <link rel="alternate" hreflang="${loc.hreflang}" href="${ORIGIN}${localizePath(p, loc)}">`);
  }
  lines.push(`  <link rel="alternate" hreflang="x-default" href="${ORIGIN}${p}">`);
  return `  <!-- i18n:alternates -->\n${lines.join('\n')}\n  <!-- /i18n:alternates -->\n`;
}

function switcherBlock(rel) {
  const p = urlPathOf(rel);
  // The English source is itself a rendered page, so it carries the current-page
  // marker; render() moves it to whichever locale it is emitting.
  const row = (href, l, current) =>
    `        <li><a data-i18n-abs translate="no" data-lang="${l.hreflang}" lang="${l.hreflang}" `
    + `hreflang="${l.hreflang}" href="${href}"${current ? ' aria-current="page"' : ''}>`
    + `<span aria-hidden="true">${l.flag}</span> ${l.name}</a></li>`;
  return [
      '      <!-- i18n:switcher -->',
      '      <div class="mv-lang" role="navigation" aria-label="Choose a language">',
      '        <ul>',
      row(p, EN, true),
      ...LOCALES.map((loc) => row(localizePath(p, loc), loc)),
      '        </ul>',
      '      </div>',
      '      <!-- /i18n:switcher -->',
      '',
  ].join('\n');
}

function spliceMarked(html, name, block, anchor) {
  const re = new RegExp(`[ \\t]*<!-- i18n:${name} -->[\\s\\S]*?<!-- /i18n:${name} -->\\n?`);
  if (re.test(html)) return html.replace(re, block);
  const at = html.lastIndexOf(anchor);
  if (at === -1) return null;
  return html.slice(0, at) + block + html.slice(at);
}

function ensureOgLocale(html) {
  if (/property=["']og:locale["']/.test(html)) return html;
  const anchor = html.match(/[ \t]*<meta property="og:site_name"[^>]*>\n/)
    || html.match(/[ \t]*<meta property="og:type"[^>]*>\n/);
  if (!anchor) return html;
  const at = html.indexOf(anchor[0]) + anchor[0].length;
  return html.slice(0, at) + '  <meta property="og:locale" content="en_US">\n' + html.slice(at);
}

export function inject() {
  let touched = 0, missing = [], noFooter = [];
  for (const rel of sourcePages()) {
    const file = path.join(ROOT, rel);
    const src = fs.readFileSync(file, 'utf8');
    let out = ensureOgLocale(src);
    const withAlt = spliceMarked(out, 'alternates', alternatesBlock(rel), '</head>');
    if (!withAlt) { missing.push(`${rel}: no </head>`); continue; }
    out = withAlt;
    // The flag row lives inside the fixed banner nav, as a second row under the
    // links — the same position graphicmeat.com puts it in. Any previously
    // injected block (this used to sit in the footer) is stripped first, so the
    // switcher moves rather than being duplicated.
    out = out.replace(/[ \t]*<!-- i18n:switcher -->[\s\S]*?<!-- \/i18n:switcher -->\n?/, '');
    const navEnd = out.indexOf('\n  </nav>');
    if (navEnd === -1) { noFooter.push(rel); }
    else out = out.slice(0, navEnd + 1) + switcherBlock(rel) + out.slice(navEnd + 1);
    if (out !== src) { fs.writeFileSync(file, out); touched++; }
  }
  console.log(`inject: ${touched} English page(s) updated`
    + (noFooter.length ? ` (no switcher, footerless: ${noFooter.join(', ')})` : ''));
  if (missing.length) { console.error('inject: SKIPPED\n  ' + missing.join('\n  ')); process.exitCode = 1; }
}

// ----------------------------------------------------------------- corpus

const CORPUS = path.join(HERE, 'corpus.json');
const CHUNK_WORDS = 5000;

const words = (s) => s.split(/\s+/).length;
const chunkId = (n) => String(n).padStart(2, '0');

function loadCorpus() {
  if (!fs.existsSync(CORPUS)) return {};
  return JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
}

export function localeDir(loc) { return path.join(HERE, 'locales', loc.dir); }

export function loadDict(loc) {
  const dir = localeDir(loc);
  const dict = {};
  if (!fs.existsSync(dir)) return dict;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    Object.assign(dict, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return dict;
}

/*
 * Chunk membership is sticky: a key keeps the chunk it was first assigned, so
 * editing one sentence of English copy does not reshuffle eight locale files.
 * New keys land in the last chunk until it is full, then open a new one.
 */
export function extract() {
  const corpus = loadCorpus();
  const placed = new Map();
  for (const [id, entries] of Object.entries(corpus)) {
    for (const k of Object.keys(entries)) placed.set(k, id);
  }

  const live = new Map();
  const risky = [];
  for (const rel of sourcePages()) {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const b of scan(html).blocks) {
      if (b.raw.length > 1200) risky.push(`${rel}: block of ${b.raw.length} chars — check it is one sentence`);
    }
    for (const { key, text } of collect(html)) {
      if (!live.has(key)) live.set(key, text);
    }
  }
  if (risky.length) console.error('extract: WARNING\n  ' + risky.join('\n  '));

  const next = {};
  for (const id of Object.keys(corpus).sort()) next[id] = {};
  for (const [key, text] of live) {
    const id = placed.get(key);
    if (id && next[id]) next[id][key] = text;
  }

  let ids = Object.keys(next).sort();
  let cur = ids.length ? ids[ids.length - 1] : null;
  let curWords = cur ? Object.values(next[cur]).reduce((a, s) => a + words(s), 0) : 0;
  let added = 0;
  for (const [key, text] of live) {
    if (placed.has(key) && next[placed.get(key)]) continue;
    if (!cur || curWords >= CHUNK_WORDS) {
      cur = chunkId(Object.keys(next).length + 1);
      next[cur] = {};
      curWords = 0;
    }
    next[cur][key] = text;
    curWords += words(text);
    added++;
  }

  const pruned = placed.size - (placed.size - [...placed.keys()].filter((k) => !live.has(k)).length);
  for (const id of Object.keys(next)) if (!Object.keys(next[id]).length) delete next[id];

  fs.writeFileSync(CORPUS, JSON.stringify(next, null, 2) + '\n');
  const total = Object.values(next).reduce((a, o) => a + Object.keys(o).length, 0);
  console.log(`extract: ${total} strings in ${Object.keys(next).length} chunks `
    + `(+${added} new, -${pruned} stale), ${[...live.values()].reduce((a, s) => a + words(s), 0)} words`);
}

export function status(only) {
  const corpus = loadCorpus();
  const total = Object.values(corpus).reduce((a, o) => a + Object.keys(o).length, 0);
  const allKeys = Object.values(corpus).flatMap((o) => Object.keys(o));
  for (const loc of LOCALES) {
    if (only && loc.dir !== only && loc.hreflang !== only) continue;
    const dict = loadDict(loc);
    const done = allKeys.filter((k) => typeof dict[k] === 'string' && dict[k].trim()).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    console.log(`  ${loc.hreflang.padEnd(7)} ${String(done).padStart(5)}/${total}  ${pct}%`);
  }
}

/*
 * Drop translations whose English no longer exists. `extract` only rewrites the
 * corpus, so after a copy change the locale files still carry the old keys and
 * `check` reports every one of them as unknown. Removing them is the point where
 * a translation is genuinely discarded, so it prints what it dropped.
 */
export function prune(only) {
  const corpus = loadCorpus();
  const live = new Set(Object.values(corpus).flatMap((o) => Object.keys(o)));
  for (const loc of LOCALES) {
    if (only && loc.dir !== only && loc.hreflang !== only) continue;
    const dir = localeDir(loc);
    if (!fs.existsSync(dir)) continue;
    let dropped = 0, emptied = 0;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(dir, f);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const kept = {};
      for (const [k, v] of Object.entries(data)) {
        if (live.has(k)) kept[k] = v; else dropped++;
      }
      if (!Object.keys(kept).length) { fs.unlinkSync(file); emptied++; continue; }
      fs.writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
    }
    console.log(`prune: ${loc.hreflang.padEnd(7)} dropped ${dropped} stale`
      + (emptied ? `, removed ${emptied} empty chunk file(s)` : ''));
  }
}

// ------------------------------------------------------------------ check

/*
 * A locale is only shippable when every chunk file carries exactly the corpus
 * keys, with values that kept the moving parts (brace placeholders, HTML
 * entities, USD amounts) intact. Agents and humans both drop keys silently, so
 * nothing is trusted without this.
 */
export function check(only) {
  const corpus = loadCorpus();
  const entries = Object.assign({}, ...Object.values(corpus));
  let failed = 0;
  for (const loc of LOCALES) {
    if (only && loc.dir !== only && loc.hreflang !== only) continue;
    const dict = loadDict(loc);
    const problems = [];
    let done = 0;

    for (const k of Object.keys(dict)) {
      if (!(k in entries)) problems.push(`unknown key ${k} — its English no longer exists, run prune`);
    }
    for (const [k, en] of Object.entries(entries)) {
      const v = dict[k];
      if (typeof v !== 'string' || !v.trim()) {
        problems.push(`untranslated ${k} — ${JSON.stringify(en.slice(0, 60))}`);
        continue;
      }
      done++;
      for (const ph of en.match(/\{[a-zA-Z]\w*\}/g) || []) {
        if (!v.includes(ph)) problems.push(`lost placeholder ${ph} in ${k}`);
      }
      for (const amt of en.match(/\$\d+/g) || []) {
        if (!v.includes(amt)) problems.push(`lost price ${amt} in ${k}`);
      }
      if (/&[a-zA-Z#][a-zA-Z0-9]*;/.test(en) && /&(?![a-zA-Z#][a-zA-Z0-9]*;)/.test(v)) {
        problems.push(`unescaped & in ${k}`);
      }
      // A block carries markup; its translation must carry the same tags, no
      // more and no fewer, or the emphasis or link is silently dropped.
      // data-mv-price is the runtime price *template*, rendered to the reader by
      // pricing-localize.js — not an identifier. Left in English inside a block it
      // silently prints "/month" on a localized page.
      for (const tpl of en.match(/data-mv-price="[^"]*"/g) || []) {
        if (/\b(month|year)\b/.test(tpl) && v.includes(tpl) && v !== en) {
          problems.push(`untranslated price template in ${k} — ${tpl}`);
        }
      }
      const enTags = (en.match(/<[a-zA-Z][^>]*>/g) || []).length;
      const vTags = (v.match(/<[a-zA-Z][^>]*>/g) || []).length;
      if (enTags !== vTags) problems.push(`tag count ${vTags} vs ${enTags} in ${k}`);
    }

    const total = Object.keys(entries).length;
    const head = `  ${loc.hreflang.padEnd(7)} ${String(done).padStart(5)}/${total}`;
    if (problems.length) {
      failed++;
      console.log(`${head}  FAIL (${problems.length})`);
      problems.slice(0, 10).forEach((x) => console.log(`      ${x}`));
      if (problems.length > 10) console.log(`      … ${problems.length - 10} more`);
    } else {
      console.log(`${head}  ok`);
    }
  }
  if (failed) process.exitCode = 1;
}

/*
 * The untranslated strings for one locale, in ~5000-word parts, as a ready-to-save
 * JSON object. `missing de` lists the parts; `missing de:2` prints part 2.
 */
export function missing(spec) {
  const [dir, part] = String(spec || '').split(':');
  const loc = LOCALES.find((l) => l.dir === dir || l.hreflang === dir);
  if (!loc) { console.error(`unknown locale ${dir}`); process.exit(2); }
  const entries = Object.assign({}, ...Object.values(loadCorpus()));
  const dict = loadDict(loc);
  const todo = Object.entries(entries).filter(([k]) => !(dict[k] || '').trim());

  const parts = [];
  let cur = {}, curWords = 0;
  for (const [k, en] of todo) {
    cur[k] = en;
    curWords += words(en);
    if (curWords >= CHUNK_WORDS) { parts.push(cur); cur = {}; curWords = 0; }
  }
  if (Object.keys(cur).length) parts.push(cur);

  if (!part) {
    const total = todo.reduce((a, [, en]) => a + words(en), 0);
    console.log(`${loc.hreflang}: ${todo.length} untranslated, ${total} words, ${parts.length} part(s)`);
    parts.forEach((p, i) => console.log(`  ${dir}:${i + 1}  ${Object.keys(p).length} strings, `
      + `${Object.values(p).reduce((a, s) => a + words(s), 0)} words`));
    return;
  }
  const p = parts[Number(part) - 1];
  if (!p) { console.error(`no part ${part}; have ${parts.length}`); process.exit(2); }
  console.log(JSON.stringify(p, null, 2));
}

// ---------------------------------------------------------------- sitemap

const SITEMAP = path.join(ROOT, 'sitemap.xml');

function buildSitemap() {
  const src = fs.readFileSync(SITEMAP, 'utf8');
  const blocks = [...src.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  // Regenerating reads the file this function last wrote, so the locale entries
  // it already added have to be dropped before expanding again — otherwise every
  // build multiplies them.
  const generated = LOCALES.map((l) => `${ORIGIN}/${l.dir}/`);
  const out = [];
  for (const b of blocks) {
    const loc = (b.match(/<loc>([^<]+)<\/loc>/) || [])[1];
    if (!loc) continue;
    if (generated.some((prefix) => loc.startsWith(prefix))) continue;
    const lastmod = (b.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1];
    const priority = (b.match(/<priority>([^<]+)<\/priority>/) || [])[1];
    const abs = loc.replace(ORIGIN, '') || '/';
    const localizable = LOCALIZABLE.has(abs);
    const alts = localizable ? [
      `      <xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}${abs}"/>`,
      ...LOCALES.map((l) => `      <xhtml:link rel="alternate" hreflang="${l.hreflang}" href="${ORIGIN}${localizePath(abs, l)}"/>`),
      `      <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}${abs}"/>`,
    ].join('\n') : '';

    const entry = (href, extraAlts) => [
      '  <url>',
      `    <loc>${href}</loc>`,
      lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
      priority ? `    <priority>${priority}</priority>` : null,
      extraAlts || null,
      '  </url>',
    ].filter(Boolean).join('\n');

    out.push(entry(loc, alts));
    if (localizable) {
      for (const l of LOCALES) out.push(entry(ORIGIN + localizePath(abs, l), alts));
    }
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n'
    + '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
    + out.join('\n') + '\n</urlset>\n';
  fs.writeFileSync(SITEMAP, xml);
  console.log(`sitemap: ${out.length} urls`);
}

/*
 * End-to-end check on the generated pages, not the strings. Two invariants:
 * a translated page must contain exactly the same tags as its English source,
 * and every root-relative link must resolve to a file that exists.
 *
 * Same *tags*, deliberately not the same *order*. A block translation is allowed
 * to move its inline elements — that is the entire reason blocks exist — and
 * Chinese duly moved a <code> span ahead of a <strong> to match its own word
 * order. Comparing sequences flagged that as corruption. Comparing the multiset
 * still catches the failure that matters: a tag dropped or invented.
 */
export function verify() {
  const strip = (h) => h.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const tagBag = (h) => (strip(h).match(/<\s*\/?\s*[a-zA-Z][\w:-]*/g) || [])
    .map((t) => t.replace(/\s+/g, '').toLowerCase()).sort().join(',');
  const problems = [];
  let pages = 0, links = 0, images = 0;

  for (const rel of sourcePages()) {
    const en = tagBag(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const loc of LOCALES) {
      const file = path.join(ROOT, loc.dir, rel);
      if (!fs.existsSync(file)) { problems.push(`${loc.dir}/${rel}: not built`); continue; }
      const html = fs.readFileSync(file, 'utf8');
      pages++;
      if (tagBag(html) !== en) problems.push(`${loc.dir}/${rel}: tags differ from the English page`);

      for (const tag of scan(html).tags) {
        for (const name of ['href', 'src']) {
          const at = tag.attrs[name];
          if (!at || at.vs < 0) continue;
          const v = at.value;
          if (!v.startsWith('/') || v.startsWith('//')) continue;
          const p = v.split(/[?#]/)[0];
          if (!p || p === '/') continue;
          links++;
          const target = p.endsWith('/') ? `${p}index.html` : p;
          // /gm.js is injected in production only; it is legitimately absent here.
          if (target === '/gm.js') continue;
          if (!fs.existsSync(path.join(ROOT, target.slice(1)))) {
            problems.push(`${loc.dir}/${rel}: dead link ${v}`);
          }
        }
        // srcset was never checked, and the loop above skips relative values —
        // which is exactly how every localized page came to ship candidates
        // resolving under /<dir>/screenshots and 404ing. A browser that picks a
        // srcset candidate does not fall back to src, so those were broken
        // images, and nothing in this function could see them.
        for (const name of ['srcset', 'imagesrcset']) {
          const at = tag.attrs[name];
          if (!at || at.vs < 0) continue;
          for (const part of at.value.split(',')) {
            const url = part.trim().split(/\s/)[0];
            if (!url) continue;
            if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) continue;
            images++;
            if (!url.startsWith('/')) {
              problems.push(`${loc.dir}/${rel}: relative srcset candidate ${url}`);
              continue;
            }
            if (!fs.existsSync(path.join(ROOT, url.split(/[?#]/)[0].slice(1)))) {
              problems.push(`${loc.dir}/${rel}: missing image ${url}`);
            }
          }
        }
      }
    }
  }

  const uniq = [...new Set(problems)];
  console.log(`verify: ${pages} pages, ${links} internal links, ${images} srcset candidates`);
  if (!uniq.length) { console.log('verify: ok'); return; }
  uniq.slice(0, 15).forEach((x) => console.log(`  ${x}`));
  if (uniq.length > 15) console.log(`  … ${uniq.length - 15} more`);
  process.exitCode = 1;
}

// ------------------------------------------------------------------ build

export function build(only) {
  const pages = sourcePages();
  for (const loc of LOCALES) {
    if (only && loc.dir !== only && loc.hreflang !== only) continue;
    const dict = loadDict(loc);
    for (const rel of pages) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const dest = path.join(ROOT, loc.dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, render(src, rel, loc, dict));
    }
    const done = Object.keys(dict).filter((k) => dict[k] && dict[k].trim()).length;
    console.log(`build: ${loc.dir.padEnd(6)} ${pages.length} pages, ${done} strings translated`);
  }
  buildSitemap();
}

// -------------------------------------------------------------------- cli

// Print one chunk so a translator reads only the slice they are working on.
export function chunk(id) {
  const corpus = loadCorpus();
  if (!id) { console.log(Object.keys(corpus).join('\n')); return; }
  if (!corpus[id]) { console.error(`no chunk ${id}; have: ${Object.keys(corpus).join(', ')}`); process.exit(2); }
  console.log(JSON.stringify(corpus[id], null, 2));
}

const CMDS = { extract, inject, build, status, check, chunk, prune, missing, verify };
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2];
  if (!CMDS[cmd]) {
    console.error(`usage: node i18n/i18n.mjs <${Object.keys(CMDS).join('|')}>`);
    process.exit(2);
  }
  CMDS[cmd](process.argv[3]);
}
