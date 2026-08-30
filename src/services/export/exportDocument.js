import { sanitizeForExport } from './exportSanitize';
import { t } from '../../i18n/index.js';
import { formatDateTime } from '../../utils/dateFormat.js';

// One width, one scale, used by the rasterizer, the packer and the HTML
// document alike. A baked iframe height is only honest while the column that
// produced it cannot reflow.
export const EXPORT_WIDTH_PX = 820;
export const EXPORT_SCALE = 2;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

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
    ${row(t('common.from'), message.from)}
    ${row(t('common.to'), message.to)}
    ${row(t('svc.exportDocument.cc'), message.cc)}
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

export function buildMessageDocument({ message, bodyHtml, account, mailbox, stats }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${EXPORT_CSS}</style></head>
<body>
${headerCardHtml(message)}
<main class="mv-body">${sanitizeForExport(bodyHtml)}</main>
${account ? provenanceHtml({ account, mailbox, messages: [message], stats }) : ''}
</body></html>`;
}
