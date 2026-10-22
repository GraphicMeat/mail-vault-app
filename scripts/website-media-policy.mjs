/** Capture-version tags for website media. Never use the current package version as a fallback. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION_SUFFIX = /(?:\s*[·—-]\s*)?(?:Reviewed for )?MailVault version \d+\.\d+\.\d+(?: (?:en|de|fr|es|it|ja|ko|zh|pt-br))?\s*$/;
export const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'website/media-versions.json'), 'utf8'));
const helpFile = path.join(ROOT, 'website/help-media.json');
const helpManifest = fs.existsSync(helpFile) ? JSON.parse(fs.readFileSync(helpFile,'utf8')) : null;

export function assetKey(src) {
  const clean = src.split(/[?#]/)[0];
  if (clean.startsWith('/assets/help-media/')) return clean.replace(/\.(?:webp|jpg|mp4|vtt)$/, '');
  if (clean.startsWith('/screenshots/')) return clean.replace(/^\/screenshots\/(?:de|fr|es|it|pt-br|ja|ko|zh)\//, '/screenshots/').replace(/-(?:light-)?\d+\.webp$/, '');
  if (clean.startsWith('/assets/clips/')) return clean.replace(/\/clips\/(?:de|fr|es|it|pt-br|ja|ko|zh)\//, '/clips/en/').replace(/(?:-poster)?(?:\.light)?\.(?:mp4|jpg)$/, '');
  return clean.replace(/\/videos\/guides\/(?:de|fr|es|it|pt-br|ja|ko|zh)\//, '/videos/guides/');
}

export function mediaRecord(src, records = manifest.captures) {
  const known = records.find(record => record.assets.includes(assetKey(src)));
  if (known) return known;
  const help = /^\/assets\/help-media\/([^/]+)\/([^/.]+)\.(?:webp|jpg|mp4)$/.exec(src);
  const workflow = help && helpManifest?.locales?.[help[1]]?.workflows?.[help[2]];
  if (workflow && [workflow.image,workflow.video,workflow.poster].includes(src)) return { version:helpManifest.version, kind:'capture', locale:help[1] };
  return null;
}
export function captureVersion(src, records = manifest.captures) {
  return mediaRecord(src, records)?.version || null;
}
export const versionLabel = record => `${record.kind === 'reviewed' ? 'Reviewed for ' : ''}MailVault version ${record.version}${record.locale ? ` ${record.locale}` : ''}`;
export function isAppMedia(src) {
  return /^\/(?:screenshots\/|assets\/(?:help-media\/|clips\/|videos\/guides\/|blog\/email-client-reviews\/mailvault-|demo-preview-))/.test(src);
}

// Source-range edits preserve hand-written HTML, script strings, and localized links.
export function media(html) {
  const masked = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, match => ' '.repeat(match.length));
  return [...masked.matchAll(/<(img|video)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)].map(match => {
    const tag = html.slice(match.index, match.index + match[0].length);
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], m[2] ?? m[3]]));
    const body = match[1] === 'video' ? html.slice(match.index + tag.length, html.indexOf('</video', match.index)) : '';
    const src = attrs.src || body.match(/<source\b[^>]*\bsrc=["']([^"']+)/)?.[1] || attrs.poster || '';
    return { tag, attrs, src, name: match[1].toLowerCase(), start: match.index, end: match.index + tag.length };
  });
}
const escape = text => text.replace(/"/g, '&quot;');
function attribute(tag, name, value) {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'i');
  const attr = ` ${name}="${escape(value)}"`;
  return re.test(tag) ? tag.replace(re, () => attr) : tag.replace(/\s*\/?>$/, end => attr + end);
}

export function tagMedia(html, records = manifest.captures, descriptions = new Map()) {
  const edits = [], translations = [], unresolved = [];
  const items = media(html);
  for (const item of items) {
    if (!isAppMedia(item.src)) continue;
    const record = mediaRecord(item.src, records);
    const version = record?.version;
    if (!version) unresolved.push(item.src);
    const name = item.name === 'img' ? 'alt' : 'aria-label';
    let description = item.attrs[name]?.trim() || descriptions.get(assetKey(item.src)) || '';
    // Posters repeat the adjacent video's content, but still get an explicit description.
    if (!description && item.name === 'img' && item.attrs.class?.includes('mv-clip-poster')) {
      description = items.find(next => next.name === 'video' && assetKey(next.src) === assetKey(item.src))?.attrs['aria-label'] || '';
    }
    if (!description) throw new Error(`Missing descriptive ${name}: ${item.src}`);
    const base = description.replace(VERSION_SUFFIX, '').trim();
    const lang = description.match(/MailVault version \d+\.\d+\.\d+ (en|de|fr|es|it|ja|ko|zh|pt-br)$/)?.[1];
    const labelRecord = lang && !record?.locale ? { ...record, locale:lang } : record;
    const label = version ? `${base} · ${versionLabel(labelRecord)}` : base;
    let tag = attribute(item.tag, name, label);
    if (version) {
      tag = attribute(tag, 'data-mailvault-version', version);
      tag = attribute(tag, 'data-mailvault-version-kind', record.kind || 'capture');
      // The native tooltip exposes the capture version without moving image layout.
      tag = attribute(tag, 'title', versionLabel(labelRecord));
    }
    if (label !== description) translations.push({ from: base, to: label, suffix: version ? ` · ${versionLabel(record)}` : '' });
    if (tag !== item.tag) edits.push({ ...item, tag });
  }
  for (const edit of edits.reverse()) html = html.slice(0, edit.start) + edit.tag + html.slice(edit.end);
  return { html, translations, unresolved: [...new Set(unresolved)] };
}

export function validateMedia(html, records = manifest.captures) {
  const errors = [];
  for (const item of media(html)) {
    const name = item.name === 'img' ? 'alt' : 'aria-label';
    const label = item.attrs[name];
    if (label === undefined) errors.push(`${item.src || item.attrs.id}: missing ${name}`);
    if (item.name === 'video' && !label?.trim()) errors.push(`${item.src}: video needs a descriptive accessible name`);
    if (!isAppMedia(item.src)) continue;
    const record = mediaRecord(item.src, records);
    const version = record?.version;
    if (!version) { errors.push(`${item.src}: capture version has not been verified`); continue; }
    if (item.attrs['data-mailvault-version'] !== version) errors.push(`${item.src}: expected data-mailvault-version=${version}`);
    if (item.attrs['data-mailvault-version-kind'] !== (record.kind || 'capture')) errors.push(`${item.src}: missing or incorrect version kind`);
    const labelMatches = label?.endsWith(versionLabel(record)) || (!record.locale && label?.match(/ (en|de|fr|es|it|ja|ko|zh|pt-br)$/) && label.replace(/ (en|de|fr|es|it|ja|ko|zh|pt-br)$/, '').endsWith(versionLabel(record)));
    if (!labelMatches || !label.replace(VERSION_SUFFIX, '').trim()) errors.push(`${item.src}: ${name} needs a description and capture version`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { sourcePages, sourceHtml } = await import('../website/i18n/i18n.mjs');
  const write = process.argv.includes('--write');
  const translations = [], unresolved = new Set();
  const pages = sourcePages().map(rel => [rel, sourceHtml(rel)]);
  const descriptions = new Map();
  for (const [, html] of pages) for (const item of media(html)) {
    const label = item.attrs[item.name === 'img' ? 'alt' : 'aria-label'];
    if (label?.trim()) descriptions.set(assetKey(item.src), label.replace(VERSION_SUFFIX, '').trim());
  }
  for (const [rel, html] of pages) {
    const result = tagMedia(html, manifest.captures, descriptions);
    result.unresolved.forEach(src => unresolved.add(src));
    translations.push(...result.translations);
    if (write) fs.writeFileSync(path.join(ROOT, 'website', rel), result.html);
  }
  console.log(JSON.stringify({ translations: [...new Map(translations.map(row => [row.to, row])).values()], unresolved: [...unresolved].sort() }, null, 2));
  if (unresolved.size) process.exitCode = 1;
}
