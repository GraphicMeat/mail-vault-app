import { sanitizeForExport } from './exportSanitize';
import { t } from '../../i18n/index.js';
import { formatDateTime } from '../../utils/dateFormat.js';
import { REDACT_CSS } from './exportRedact';
import { stripInlineColorImportant } from '../../utils/emailIframeTemplate';

// One width, one scale, used by the rasterizer, the packer and the HTML
// document alike. A baked iframe height is only honest while the column that
// produced it cannot reflow.
export const EXPORT_WIDTH_PX = 820;
export const EXPORT_SCALE = 2;

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// `from` is a {name, address} object and `to`/`cc` are arrays of them —
// that is the shape the whole app reads (`email.from.address` everywhere).
// Export was the one place treating them as "Name <addr>" strings, so every
// filename and every header card said "[object Object]". The string form is
// still accepted because the sample fixtures and the unit tests use it.
const oneAddress = (a) => (typeof a === 'string' ? a.trim()
  : [a?.name, a?.address && `<${a.address}>`].filter(Boolean).join(' '));

/** Full `Name <addr>` form, comma-joined for a recipient list. */
export const addressLine = (value) => (Array.isArray(value) ? value : [value])
  .filter(Boolean).map(oneAddress).filter(Boolean).join(', ');

/** Short form for a filename or a thread summary: the name, else the address. */
export const displayName = (value) => {
  const a = Array.isArray(value) ? value[0] : value;
  if (a && typeof a === 'object') return a.name || a.address || '';
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(a || '');
  return match ? (match[1] || match[2]) : String(a || '');
};

/**
 * The stamp on an exported document. This was pinned to `en-GB` and built once
 * at module load, so a German export carried "05 Jan 2026" and a language
 * switch never reached it. `formatDateTime` is the app's own formatter: it
 * follows the chosen language AND the reader's date/time preference, and it is
 * re-read on every call.
 */
export function formatStamp(date) {
  return formatDateTime(date);
}

export function headerCardHtml(message) {
  const row = (label, value) => value
    ? `<tr><td class="mv-l">${esc(label)}</td><td class="mv-v">${esc(value)}</td></tr>`
    : '';
  return `<header class="mv-head">
  <h1 class="mv-subject">${esc(message.subject || t('svc.exportDocument.noSubject'))}</h1>
  <table class="mv-meta">
    ${row(t('common.from'), addressLine(message.from))}
    ${row(t('common.to'), addressLine(message.to))}
    ${row(t('svc.exportDocument.cc'), addressLine(message.cc))}
    ${row(t('svc.exportDocument.date'), formatStamp(message.date))}
  </table>
</header>`;
}

export function provenanceHtml({ account, mailbox, messages, stats }) {
  // The denominator is what we TRIED to mirror. A tracking pixel was never a
  // candidate — it was dropped on purpose — so it is counted beside the ratio,
  // not inside it.
  const attempted = (stats?.mirrored || 0) + (stats?.failed || 0);
  const removed = stats?.pixelsRemoved || 0;
  const parts = [];
  if (attempted > 0) {
    parts.push(t('svc.exportDocument.remoteAssetsMirrored', { stats: stats.mirrored, attempted }));
    if (stats.failed) parts.push(t('svc.exportDocument.unavailable', { stats: stats.failed }));
  }
  if (removed) parts.push(t('svc.exportDocument.trackingPixelsRemoved', { removed }));
  const mirrorLine = parts.length ? `<div>${parts.join(' &middot; ')}</div>` : '';
  const ids = messages
    .map(m => `<div class="mv-id">${esc(m.messageId || t('svc.exportDocument.noMessageId'))}${m.custody ? ` &middot; ${esc(m.custody)}` : ''}</div>`)
    .join('');
  return `<footer class="mv-prov">
  <div>${esc(account)} &middot; ${esc(mailbox)} &middot; ${esc(t('common.messageCount', { count: messages.length }))}</div>
  ${ids}
  ${mirrorLine}
  <div class="mv-mark">${esc(t('svc.exportDocument.exportedFromMailvault'))}</div>
</footer>`;
}

// Light always. The export is a document, not a screenshot of the app, so it
// does not inherit the reading pane's theme.
export const EXPORT_CSS = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  /* max-width, not width: the rasterizer renders in a frame of exactly
     EXPORT_WIDTH_PX so it measures the same either way, while the HTML export
     opens in a window of any size — and a fixed width there is a horizontal
     scrollbar on every screen narrower than the column. */
  body { max-width: ${EXPORT_WIDTH_PX}px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #16181d; }
  /* Mail is full of fixed-width tables and unbreakable URLs. Contained here so
     the message scrolls with the page instead of sideways inside its frame. */
  .mv-body { overflow-wrap: anywhere; }
  .mv-body table { max-width: 100%; }
  .mv-body pre { white-space: pre-wrap; word-break: break-word; }
  .mv-head { padding: 20px 24px 14px; border-bottom: 1px solid #e3e5ea; }
  .mv-subject { margin: 0 0 10px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
  .mv-meta { border-collapse: collapse; font-size: 12.5px; }
  .mv-l { padding: 1px 10px 1px 0; color: #6b7280; vertical-align: top; white-space: nowrap; }
  .mv-v { padding: 1px 0; overflow-wrap: anywhere; }
  .mv-body { padding: 18px 24px; }
  .mv-body img { max-width: 100%; height: auto; }
  .mv-prov { padding: 12px 24px 18px; border-top: 1px solid #e3e5ea; color: #6b7280; font-size: 11.5px; }
  .mv-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow-wrap: anywhere; }
  .mv-mark { margin-top: 6px; color: #9aa1ab; }
`;

// The header block of a social card, dark. Plain CSS over the light sheet:
// no scripts. The background is the dark card's (composeSocialImage CARD_BG).
export const EXPORT_HEAD_DARK = Object.freeze({ bg: '#1e1f22', text: '#e6e7ea', muted: '#9aa1ab', border: '#34363b' });
const HEAD_DARK_CSS = `
  :root { color-scheme: dark; }
  html, body { background: ${EXPORT_HEAD_DARK.bg}; }
  body { color: ${EXPORT_HEAD_DARK.text}; }
  .mv-head { border-bottom-color: ${EXPORT_HEAD_DARK.border}; }
  .mv-l { color: ${EXPORT_HEAD_DARK.muted}; }
`;

// The boxes a social card can carry under the header (sender details, links),
// styled like the app's popovers: rounded, hairline-bordered, a coloured dot per
// verdict. Light always; the dark header re-colours them below.
export const PANEL_CSS = `
  .mv-panels { padding: 14px 24px 18px; display: grid; gap: 10px; }
  .mv-box { border: 1px solid #e3e5ea; border-radius: 12px; padding: 12px 14px; font-size: 12.5px; }
  .mv-box-title { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; }
  .mv-sub { margin: 0 0 6px; font-size: 12.5px; font-weight: 600; }
  .mv-row { display: flex; align-items: flex-start; gap: 10px; padding: 1px 0; }
  .mv-k { width: 64px; flex: none; color: #6b7280; }
  .mv-val { min-width: 0; overflow-wrap: anywhere; }
  .mv-sep { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e3e5ea; }
  .mv-muted { color: #6b7280; }
  .mv-dot { display: inline-block; flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: #6b7280; }
  .mv-dot.mv-ok { background: #166534; }
  .mv-dot.mv-warn { background: #9a3412; }
  .mv-dot.mv-bad { background: #991b1b; }
  .mv-t-warn { color: #9a3412; }
  .mv-t-bad { color: #991b1b; }
  .mv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  .mv-badge { flex: none; margin-top: 1px; padding: 0 6px; border-radius: 6px; font-size: 11px; font-weight: 600; line-height: 18px; color: #6b7280; background: #eef0f3; }
  .mv-badge.mv-warn { color: #9a3412; background: #f2d5ca; }
  .mv-badge.mv-bad { color: #991b1b; background: #f0cdcd; }
  .mv-link-text { overflow-wrap: anywhere; }
`;
const PANEL_DARK_CSS = `
  .mv-box { border-color: ${EXPORT_HEAD_DARK.border}; }
  .mv-k, .mv-muted { color: ${EXPORT_HEAD_DARK.muted}; }
  .mv-sep { border-top-color: ${EXPORT_HEAD_DARK.border}; }
  .mv-dot { background: ${EXPORT_HEAD_DARK.muted}; }
  .mv-dot.mv-ok { background: #22c55e; }
  .mv-dot.mv-warn { background: #fb923c; }
  .mv-dot.mv-bad { background: #f87171; }
  .mv-t-warn { color: #fb923c; }
  .mv-t-bad { color: #f87171; }
  .mv-badge { color: ${EXPORT_HEAD_DARK.muted}; background: #2a2c31; }
  .mv-badge.mv-warn { color: #fb923c; background: #4d301e; }
  .mv-badge.mv-bad { color: #f87171; background: #4d272d; }
`;

// `redactStyle` ('blur' | 'bar'): how a redacted body's `.mv-pii` spans paint.
// `part` ('head' | 'body'): only the header block or only the mail body, for a
// social card that rasterizes them apart (`theme` 'dark' then styles the header
// dark, or readies the body for Dark Reader). `extraHead`: raw markup after the
// stylesheet, e.g. a CSP meta and the nonced Dark Reader scripts. All three
// default to the whole light document every other export gets. `extrasHtml`:
// boxes under the header block (sender details, links), never in a body-only part.
export function buildMessageDocument({ message, bodyHtml, account, mailbox, stats, redactStyle, part, theme = 'light', extraHead = '', extrasHtml = '' }) {
  const dark = theme === 'dark';
  const extras = part !== 'body' && extrasHtml ? extrasHtml : '';
  const headDarkCss = part === 'head' && dark ? HEAD_DARK_CSS + (extras ? PANEL_DARK_CSS : '') : '';
  // Dark Reader needs an inline `!important` colour's priority gone, as in the reader.
  const body = sanitizeForExport(part === 'body' && dark ? stripInlineColorImportant(bodyHtml) : bodyHtml);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${EXPORT_CSS}${extras ? PANEL_CSS : ''}${headDarkCss}${redactStyle ? REDACT_CSS[redactStyle] : ''}</style>${extraHead}</head>
<body>
${part === 'body' ? '' : headerCardHtml(message)}${extras ? `\n<section class="mv-panels">${extras}</section>` : ''}
${part === 'head' ? '' : `<main class="mv-body">${body}</main>`}
${account && !part ? provenanceHtml({ account, mailbox, messages: [message], stats }) : ''}
</body></html>`;
}
