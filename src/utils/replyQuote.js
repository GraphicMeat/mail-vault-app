// ── The quote a reply/forward carries ───────────────────────────────────────
//
// Shared by ComposeModal (the live editor) and App's compose-window state
// (patching a minimized window's saved snapshot, which has no live editor to
// react to a fuller `replyTo` — see openCompose's `_fillFrom` branch). Pulls
// in RichTextEditor's textToHtml, so App only reaches this through a dynamic
// import() at call time, never a static one — see composeSend.js for the
// same rule and why (TipTap must stay out of the eagerly-loaded App chunk).

import { formatDateTime } from './dateFormat';
import { textToHtml } from '../components/RichTextEditor';

// Fields of a received message go into the quote's HTML as text.
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function originalHtml(message, label) {
  const fromAddress = message.from?.address || '';
  const fromName = message.from?.name || '';
  const originalDate = message.date ? formatDateTime(message.date) : '';
  const originalTo = message.to?.map(recipient => recipient.address).join(', ') || '';
  const header = `<p><strong>${label}</strong><br>From: ${escapeHtml(fromName)} &lt;${escapeHtml(fromAddress)}&gt;<br>Date: ${escapeHtml(originalDate)}<br>Subject: ${escapeHtml(message.subject || '')}<br>To: ${escapeHtml(originalTo)}</p>`;
  return header + (message.html || textToHtml(message.text || ''));
}

// The quote toggle and the full-thread context panel, both built from
// `replyTo`'s body.
export function buildQuoteBlocks(replyTo, label) {
  const fullQuotedHtml = originalHtml(replyTo, label);
  const quotedHeaderHtml = fullQuotedHtml.slice(0, fullQuotedHtml.indexOf('</p>') + 4);
  const fullQuotedBodyHtml = fullQuotedHtml.slice(quotedHeaderHtml.length);
  const contextMessages = replyTo._threadContext?.length ? replyTo._threadContext : [replyTo];
  return {
    quotedHeaderHtml,
    fullQuotedBodyHtml,
    quotedHtml: quotedHeaderHtml + (replyTo._selectedQuoteHtml || fullQuotedBodyHtml),
    contextHtml: contextMessages.map(message => originalHtml(message, label)).join('<hr>'),
  };
}

export { replyWireHtml } from './quoteWire';
