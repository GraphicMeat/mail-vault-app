// Demo-only policy adapter. The backend supplies every account and setting;
// production callers never import this module or use it as an RPC fallback.
import { computeReplyRecipients, buildReplyHeaders } from '../utils/emailParser';
import { composeIdentities } from '../utils/sendAsSuggestions';
import { parseMailto } from '../utils/mailtoPolicy';
import { textToHtml } from '../utils/textToHtml';

const escapeHtml = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const original = ({ header: m, html, text }, label, dateLabel) => {
  const header = `<p><strong>${label}</strong><br>From: ${escapeHtml(m.from?.name || '')} &lt;${escapeHtml(m.from?.address || '')}&gt;<br>Date: ${escapeHtml(dateLabel)}<br>Subject: ${escapeHtml(m.subject || '')}<br>To: ${escapeHtml(m.to?.map(r => r.address).join(', ') || '')}</p>`;
  return { header, body: m._bodyLoading ? '' : html || textToHtml(text || '') };
};
export function prepareDemoCompose(p, { accounts, values, version }) {
  if (typeof p.requestId !== 'string' || !p.requestId.trim()) throw new Error('compose.preparationUnavailable');
  if (p.expectedSettingsVersion != null && p.expectedSettingsVersion !== version) throw new Error('errors.settingsConflict');
  const accountId = accounts.find(a => a.id === p.accountId)?.id || accounts[0]?.id || null;
  const base = { requestId: p.requestId, settingsVersion: version };
  if (p.kind === 'mailto') return { ...base, initialData: parseMailto(p.href, accountId) };
  if (p.kind !== 'message' || !p.original?.header || !['reply', 'replyAll', 'forward'].includes(p.mode) || !p.presentation) throw new Error('compose.preparationUnavailable');
  const settings = values['mailvault-settings']?.state || {};
  const own = composeIdentities(accounts, settings.sendAsAddresses, settings.aliases).map(i => i.address);
  if (p.pickedFrom) own.push(p.pickedFrom);
  const m = p.original.header;
  const forward = p.mode === 'forward';
  const recipients = forward ? { to: '', cc: '' } : computeReplyRecipients(m, p.mode, own);
  const pieces = original(p.original, p.presentation.originalLabel, p.presentation.dateLabel);
  const fullOriginalHtml = pieces.header + pieces.body;
  const subject = m.subject || '';
  return { ...base, accountId, ...recipients, bcc: '',
    subject: subject.startsWith(forward ? 'Fwd:' : 'Re:') ? subject : p.presentation.subjectCandidate,
    ...(forward ? { inReplyTo: '', references: '' } : buildReplyHeaders(m)),
    quotedHeaderHtml: pieces.header, fullQuotedBodyHtml: pieces.body, fullOriginalHtml,
    quotedHtml: pieces.header + (!forward && p.selectedQuoteHtml || pieces.body),
    contextHtml: p.threadContext?.length ? p.threadContext.map(item => { const x = original(item.original, p.presentation.originalLabel, item.dateLabel); return x.header + x.body; }).join('<hr>') : fullOriginalHtml,
    bodyAvailable: !m._bodyLoading && Boolean(p.original.html || p.original.text),
  };
}
