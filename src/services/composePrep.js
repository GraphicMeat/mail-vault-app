import { send } from './transport';
import { flushSafeStorage } from '../stores/safeStorage';
import { formatDateTime } from '../utils/dateFormat';
import { t } from '../i18n/index.js';
import { withoutSnippet } from '../utils/withoutSnippet';

const unavailable = () => new Error('compose.preparationUnavailable');
const copy = value => JSON.parse(JSON.stringify(value));
const headerKeys = ['from', 'to', 'cc', 'replyTo', 'subject', 'date', 'messageId', 'message_id', 'references', '_bodyLoading'];
const project = message => {
  const m = withoutSnippet(message);
  return copy({ header: Object.fromEntries(headerKeys.filter(key => m[key] !== undefined).map(key => [key, m[key]])),
    ...(m.html != null && { html: m.html }), ...(m.text != null && { text: m.text }) });
};
const dateLabel = m => m.date ? formatDateTime(m.date) : '';
export function messagePreparation({ replyTo, mode, accountId, pickedFrom }) {
  return { kind: 'message', mode, ...(accountId && { accountId }), ...(pickedFrom && { pickedFrom }),
    original: project(replyTo), ...(replyTo._selectedQuoteHtml != null && { selectedQuoteHtml: replyTo._selectedQuoteHtml }),
    threadContext: (replyTo._threadContext || []).map(m => ({ original: project(m), dateLabel: dateLabel(m) })),
    presentation: { originalLabel: t('compose.originalMessage'), dateLabel: dateLabel(replyTo), subjectCandidate: t(mode === 'forward' ? 'compose.fwd' : 'compose.re', { originalSubject: replyTo.subject || '' }) } };
}
export async function prepareCompose(input, { acknowledge = () => flushSafeStorage({ acknowledge: true }), isCurrent = () => true } = {}) {
  const frozen = copy(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    const version = await acknowledge();
    if (!isCurrent()) throw unavailable();
    if (!Number.isInteger(version) || version < 0) throw unavailable();
    const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    let result;
    try { result = await send('compose.reply_context', { ...frozen, requestId, expectedSettingsVersion: version }); }
    catch (error) {
      if (attempt === 0 && (error?.message || error) === 'errors.settingsConflict' && isCurrent()) continue;
      throw error;
    }
    if (!isCurrent() || result?.requestId !== requestId || result.settingsVersion !== version) throw unavailable();
    if (frozen.kind === 'message') {
      if (result.accountId !== null && typeof result.accountId !== 'string') throw unavailable();
      const fields = ['to', 'cc', 'bcc', 'subject', 'inReplyTo', 'references', 'quotedHeaderHtml', 'fullQuotedBodyHtml', 'quotedHtml', 'contextHtml', 'fullOriginalHtml'];
      if (fields.some(key => typeof result[key] !== 'string') || result.bcc !== '' || typeof result.bodyAvailable !== 'boolean') throw unavailable();
      if (frozen.accountId && result.accountId !== frozen.accountId) {
        const error = unavailable(); error.accountMismatch = true; throw error;
      }
    } else if (frozen.kind === 'mailto') {
      const data = result.initialData;
      if (data !== null && (!data || data._prefill !== true || ['to', 'cc', 'bcc', 'subject', 'body'].some(key => typeof data[key] !== 'string'))) throw unavailable();
      if (data && data._accountId !== undefined && typeof data._accountId !== 'string') throw unavailable();
      if (frozen.accountId && data && data._accountId !== frozen.accountId) throw unavailable();
    } else throw unavailable();
    return result;
  }
  throw unavailable();
}
export const prepareMessage = (input, options) => prepareCompose(messagePreparation(input), options);
export const prepareMailto = (href, accountId, options) => prepareCompose({ kind: 'mailto', href, ...(accountId && { accountId }) }, options);

export const preparationIdentity = ({ accountId, fromAddress, accounts, aliases, sendAsAddresses }) => JSON.stringify({ accountId, from: fromAddress, accounts: accounts.map(a => [a.id, a.email]), aliases, sendAs: sendAsAddresses });
