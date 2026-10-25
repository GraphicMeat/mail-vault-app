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

// A final owner check supplies settingsVersion explicitly: it must refuse a
// conflict against that captured authority, never acknowledge a newer version.
export async function checkCompose(input, options = {}) {
  const frozen = copy(checkInput(input));
  const finalVersion = Object.prototype.hasOwnProperty.call(options, 'settingsVersion');
  const { acknowledge = () => flushSafeStorage({ acknowledge: true, purpose: 'send-check' }), isCurrent = () => true } = options;
  for (let attempt = 0; attempt < (finalVersion ? 1 : 2); attempt++) {
    if (!isCurrent()) throw unavailable();
    const version = finalVersion ? options.settingsVersion : await acknowledge();
    if (!isCurrent() || !Number.isSafeInteger(version) || version < 0) throw unavailable();
    const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    let result;
    try { result = await send('compose.check', { ...frozen, requestId, expectedSettingsVersion: version }); }
    catch (error) {
      if (!finalVersion && attempt === 0 && (error?.message || error) === 'errors.settingsConflict' && isCurrent()) continue;
      throw error;
    }
    if (!isCurrent()) throw unavailable();
    validateCheck(result, frozen, requestId, version);
    return result;
  }
  throw unavailable();
}
function checkInput(input) {
  const keys = ['mode', 'inReplyTo', 'forward', 'to', 'cc', 'bcc', 'subject', 'authoredBodyText', 'attachmentCount', 'timeZone', 'sendAnyway'];
  const plan = input.sendPlan;
  const draft = input.scheduleDraft;
  return { ...Object.fromEntries(keys.filter(k => input[k] !== undefined).map(k => [k, input[k]])),
    accountId: input.accountId ?? '', fromAddress: input.fromAddress ?? '',
    ...(input.draftId != null && { draftId: input.draftId }), ...(input.revision != null && { revision: input.revision }),
    sendPlan: plan && typeof plan === 'object' && !Array.isArray(plan) ? { kind: plan.kind, ...(plan.kind === 'in' && { minutes: plan.minutes }) } : plan ?? null,
    scheduleDraft: draft && typeof draft === 'object' && !Array.isArray(draft) ? { localTime: draft.localTime, tz: draft.tz } : draft ?? null };
}
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
function validateCheck(result, input, requestId, version) {
  const base = ['requestId', 'settingsVersion', 'kind', ...['draftId', 'revision'].filter(key => input[key] !== undefined)];
  if (!object(result) || result.requestId !== requestId || result.settingsVersion !== version
    || ['draftId', 'revision'].some(key => result[key] !== input[key] || Object.hasOwn(result, key) !== Object.hasOwn(input, key))) throw unavailable();
  if (result.kind === 'confirm_attachment' && only(result, base)) return;
  if (result.kind === 'invalid' && only(result, [...base, 'key', 'args'])) {
    if (result.key === 'compose.invalidRecipient' && only(result.args, ['address']) && typeof result.args.address === 'string') return;
    if (['compose.pleaseEnterLeastOneRecipient', 'compose.noAccountSelected', 'scheduled.picker.pastTime'].includes(result.key) && !Object.hasOwn(result, 'args')) return;
  }
  if (result.kind === 'ready' && only(result, [...base, 'route'])) {
    const route = result.route;
    if (only(route, ['delay']) && Object.hasOwn(route, 'delay') && (route.delay === null || Number.isInteger(route.delay) && route.delay >= 60 && route.delay <= 300 && route.delay % 60 === 0)) return;
    if (only(route, ['draft']) && validCheckDraft(route.draft)) return;
  }
  throw unavailable();
}

function validCheckDraft(draft) {
  if (!only(draft, ['localTime', 'tz']) || typeof draft.localTime !== 'string' || typeof draft.tz !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(draft.localTime);
  if (!parts) return false;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59) return false;
  // Validate zone support only. Wall-time conversion would normalize invalid
  // dates and could change legitimate DST gap/fold times owned by native policy.
  try { new Intl.DateTimeFormat('en-US', { timeZone: draft.tz }); return true; }
  catch { return false; }
}
