import { classifyLink } from '../../../utils/linkSafety';
import { findPii, maskString, maskText, EMPTY_DICTIONARY } from '../../../utils/privacy/piiDetector';
import { t } from '../../../i18n/index.js';
import { esc } from '../exportDocument';

/**
 * The links box of a social card: what a mail's links really point at, worst
 * first, so a screenshot of a phishing mail shows the trap. Collected from the
 * UNREDACTED body (redaction strips every href, and the export sanitizer drops
 * javascript: ones), then reduced for a redacted image: only the host of a web
 * link survives, because its path and query carry the recipient's tokens.
 */
export const MAX_SOCIAL_LINKS = 10;

const SHOWN_SCHEME = /^\s*(https?:\/\/|javascript:|data:)/i;
const SCRIPT_SCHEME = /^\s*(javascript|data):/i;
const URL_LIKE = /^\s*(https?:\/\/|www\.)/i;

// A host is lowercase and the name detector wants capitals, so it looks at a
// capitalised copy and masks the same positions in the real one: "rokas.shop.example"
// shows "xxxxx.shop.example". (Over-masking is the accepted failure.)
function maskHost(host, dict) {
  const probe = host.replace(/(^|[.-])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase());
  let out = '';
  let last = 0;
  for (const { start, end } of findPii(probe, dict)) {
    out += host.slice(last, start) + maskText(host.slice(start, end));
    last = end;
  }
  return out + host.slice(last);
}

// Scheme and host only. A script or data link is its scheme alone: what follows is code or a payload.
function hostOnly(href, dict = EMPTY_DICTIONARY) {
  const script = SCRIPT_SCHEME.exec(href);
  if (script) return `${script[1].toLowerCase()}:`;
  try {
    const url = new URL(/^\s*www\./i.test(href) ? `https://${href.trim()}` : href.trim());
    return `${url.protocol}//${maskHost(url.hostname, dict)}`;
  } catch {
    return '';
  }
}

const rank = (l) => (l.level === 'red' ? 0 : l.level === 'yellow' ? 1 : l.insecure ? 2 : 3);

/** `{ links: [{ text, href, level: 'red'|'yellow'|null, insecure }], more }`, worst first, capped. */
export function collectSocialLinks(bodyHtml, { dict, redact = false } = {}) {
  if (!bodyHtml) return { links: [], more: 0 };
  const doc = new DOMParser().parseFromString(`<body>${bodyHtml}</body>`, 'text/html');
  const seen = new Set();
  const found = [];
  for (const a of doc.body.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') || '').trim();
    if (!SHOWN_SCHEME.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text = a.textContent?.trim() || '';
    // classifyLink reads a lowercase scheme: "JavaScript:" is the same trap.
    const level = classifyLink(href.replace(/^\w+(?=:)/, m => m.toLowerCase()), text).level;
    found.push({ text, href, level, insecure: /^http:/i.test(href) });
  }
  // Array sort is stable: links of one rank keep the mail's order.
  const sorted = found.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map(x => x.l);
  const links = sorted.slice(0, MAX_SOCIAL_LINKS).map(l => (redact
    ? {
      ...l,
      href: hostOnly(l.href, dict),
      text: URL_LIKE.test(l.text) ? hostOnly(l.text, dict) : maskString(l.text, dict),
    }
    : l));
  return { links, more: Math.max(0, sorted.length - MAX_SOCIAL_LINKS) };
}

const SHOWN_CHARS = 100;
const clip = (s) => (s.length > SHOWN_CHARS ? `${s.slice(0, SHOWN_CHARS)}…` : s);

/** The box (PANEL_CSS styles it), or '' when the mail has no web link. Every value escaped. */
export function socialLinksHtml({ links, more } = {}) {
  if (!links?.length) return '';
  const rows = links.map((l) => {
    const badges = [
      l.level === 'red' && `<span class="mv-badge mv-bad">${esc(t('alert.link.dangerous'))}</span>`,
      l.level === 'yellow' && `<span class="mv-badge mv-warn">${esc(t('alert.link.suspicious'))}</span>`,
      l.insecure && `<span class="mv-badge mv-warn">${esc(t('export.social.linkInsecure'))}</span>`,
    ].filter(Boolean).join('');
    return `<div class="mv-row">${badges}<div class="mv-val">${l.text ? `<div class="mv-link-text">${esc(clip(l.text))}</div>` : ''}<div class="mv-mono">${esc(clip(l.href))}</div></div></div>`;
  }).join('');
  const rest = more > 0 ? `<div class="mv-muted mv-sep">${esc(t('export.social.linksMore', { count: more }))}</div>` : '';
  return `<section class="mv-box" data-mv-box="links"><h2 class="mv-box-title">${esc(t('export.social.linksTitle'))}</h2>${rows}${rest}</section>`;
}
