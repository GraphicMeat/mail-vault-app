// ── The original a reply/forward carries, as it leaves and as a draft keeps it ──
//
// No imports: localDrafts reads drafts back through splitWireHtml from App's
// own chunk, which must stay free of TipTap (replyQuote.js pulls it in).
//
// The <hr> before the original is marked, so a draft read back from the vault
// splits into the body the editor gets and the original that rides beside it.
// The editor never sees that attribute: a body typed in it cannot fake one.

// The reply as sent (and as a draft saves it). The header buildQuoteBlocks
// writes goes above the blockquote, not inside it: a reader that folds the
// quote, ours included, still shows who wrote it. A forward's original is
// the message itself, not a quote to fold away: no blockquote.
export function replyWireHtml(bodyHtml, quotedHtml, forward = false) {
  if (!quotedHtml) return bodyHtml;
  if (forward) return `${bodyHtml}<hr data-mailvault-quote="forward">${quotedHtml}`;
  const headerEnd = quotedHtml.startsWith('<p><strong>') ? quotedHtml.indexOf('</p>') + 4 : 0;
  return `${bodyHtml}<hr data-mailvault-quote="reply">${quotedHtml.slice(0, headerEnd)}<blockquote>${quotedHtml.slice(headerEnd)}</blockquote>`;
}

// replyWireHtml's inverse. The first mark is ours: a forwarded original can
// hold an earlier forward's mark further down.
export function splitWireHtml(html) {
  const mark = /<hr data-mailvault-quote="(reply|forward)">/.exec(html || '');
  if (!mark) return { body: html, quotedHtml: '', forward: false };
  const rest = html.slice(mark.index + mark[0].length);
  const forward = mark[1] === 'forward';
  return {
    body: html.slice(0, mark.index),
    quotedHtml: forward ? rest : rest.replace('<blockquote>', '').replace(/<\/blockquote>\s*$/, ''),
    forward,
  };
}
