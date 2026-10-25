// Demo-only policy adapter. The backend supplies every account and setting;
// production callers never import this module or use it as an RPC fallback.
import { computeReplyRecipients, buildReplyHeaders } from '../utils/replyPolicy';
import { composeIdentities } from '../utils/sendAsSuggestions';
import { parseMailto } from '../utils/mailtoPolicy';
import { textToHtml } from '../utils/textToHtml';
import { invalidRecipients } from '../utils/recipientTokens';
import { missingAttachment } from '../utils/missingAttachment';
import { routeSend } from '../utils/sendPlan';
import { zonedTimeToEpoch } from '../utils/scheduledTime';

const escapeHtml = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const original = ({ header: m, html, text }, label, dateLabel) => {
  const header = `<p><strong>${label}</strong><br>From: ${escapeHtml(m.from?.name || '')} &lt;${escapeHtml(m.from?.address || '')}&gt;<br>Date: ${escapeHtml(dateLabel)}<br>Subject: ${escapeHtml(m.subject || '')}<br>To: ${escapeHtml(m.to?.map(r => r.address).join(', ') || '')}</p>`;
  return { header, body: html || textToHtml(m._bodyLoading ? '' : text || '') };
};
export function prepareDemoCompose(p, { accounts, values, version }) {
  if (typeof p.requestId !== 'string' || !p.requestId.trim()) throw new Error('compose.preparationUnavailable');
  if (p.expectedSettingsVersion != null && p.expectedSettingsVersion !== version) throw new Error('errors.settingsConflict');
  const accountId = accounts.find(a => a.id === p.accountId)?.id || accounts[0]?.id || null;
  const base = { requestId: p.requestId, settingsVersion: version };
  if (p.kind === 'mailto') return { ...base, initialData: parseMailto(p.href, p.accountId) };
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
    bodyAvailable: Boolean(p.original.html || !m._bodyLoading && p.original.text),
  };
}

// This adapter receives only backend-owned state and clock, never a caller's
// entitlement bit or a live store. Production has no fallback to this policy.
export function checkDemoCompose(p, { accounts, values, version, now }) {
  const fail = () => { throw new Error('compose.preparationUnavailable'); };
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const only = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
  const uint = v => Number.isSafeInteger(v) && v >= 0;
  const keys = ['requestId', 'expectedSettingsVersion', 'draftId', 'revision', 'accountId', 'fromAddress', 'mode', 'inReplyTo', 'forward', 'to', 'cc', 'bcc', 'subject', 'authoredBodyText', 'attachmentCount', 'sendPlan', 'scheduleDraft', 'timeZone', 'sendAnyway'];
  if (!only(p, keys) || ['requestId', 'accountId', 'fromAddress', 'to', 'authoredBodyText', 'timeZone'].some(k => typeof p[k] !== 'string') || !p.requestId.trim()
    || !['new', 'reply', 'replyAll', 'forward'].includes(p.mode) || !uint(p.attachmentCount) || p.attachmentCount > 4294967295
    || ['cc', 'bcc', 'subject'].some(k => p[k] !== undefined && typeof p[k] !== 'string')
    || ['forward', 'sendAnyway'].some(k => p[k] !== undefined && typeof p[k] !== 'boolean')
    || ['draftId', 'inReplyTo'].some(k => p[k] != null && typeof p[k] !== 'string')
    || ['revision', 'expectedSettingsVersion'].some(k => p[k] != null && !uint(p[k]))) fail();
  if (p.expectedSettingsVersion != null && p.expectedSettingsVersion !== version) throw new Error('errors.settingsConflict');
  const zone = tz => { try { if (typeof tz !== 'string' || !tz) fail(); new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { fail(); } };
  zone(p.timeZone);
  const base = { requestId: p.requestId, settingsVersion: version, ...(p.draftId != null && { draftId: p.draftId }), ...(p.revision != null && { revision: p.revision }) };
  const invalid = (key, args) => ({ ...base, kind: 'invalid', key, ...(args && { args }) });
  if (!p.to.trim()) return invalid('compose.pleaseEnterLeastOneRecipient');
  const bad = [p.to, p.cc, p.bcc].flatMap(invalidRecipients)[0];
  if (bad !== undefined) return invalid('compose.invalidRecipient', { address: bad });
  if (!accounts.some(a => a.id === p.accountId)) return invalid('compose.noAccountSelected');
  const settings = values['mailvault-settings']?.state || {};
  const bp = settings.billingProfile;
  const premium = settings.shareGrant?.expiresAt > now || !!bp?.hasSubscription && (
    typeof bp.clientAccessGranted === 'boolean' ? bp.clientAccessGranted : typeof bp.premiumAccess === 'boolean' ? bp.premiumAccess
      : ['trialing', 'active', 'past_due'].includes(bp.status) || bp.status === 'canceled' && !!bp.currentPeriodEnd && new Date(bp.currentPeriodEnd).getTime() > now);
  const mode = p.forward || p.mode === 'forward' ? 'forward' : p.inReplyTo || p.mode !== 'new' ? 'reply' : 'new';
  if (!p.sendAnyway && (settings.attachmentReminder === undefined || settings.attachmentReminder) && premium
    && missingAttachment({ mode, subject: p.subject || '', bodyText: p.authoredBodyText, attachmentCount: p.attachmentCount })) return { ...base, kind: 'confirm_attachment' };
  const plan = p.sendPlan;
  if (plan != null && (!only(plan, plan.kind === 'in' ? ['kind', 'minutes'] : ['kind']) || !['in', 'at'].includes(plan.kind)
    || plan.kind === 'in' && (!uint(plan.minutes) || plan.minutes > 1440))) fail();
  if (plan?.kind === 'at') {
    const draft = p.scheduleDraft;
    if (!only(draft, ['localTime', 'tz']) || typeof draft.localTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.localTime)) fail();
    zone(draft.tz);
    const guess = Date.parse(`${draft.localTime}:00Z`);
    if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 16) !== draft.localTime) fail();
  }
  const route = routeSend(plan, p.scheduleDraft, now, p.timeZone);
  if (route.draft && zonedTimeToEpoch(route.draft.localTime, route.draft.tz) <= now) return invalid('scheduled.picker.pastTime');
  return { ...base, kind: 'ready', route };
}
