import { checkSenderVerification, parseAuthResults } from '../../../utils/senderCheck';
import { maskText, maskString } from '../../../utils/privacy/piiDetector';
import { t } from '../../../i18n/index.js';
import { esc } from '../exportDocument';

/**
 * The sender-details box of a social card: the in-app AuthDetailPopover's
 * content as a model, a redaction step and card HTML. The model is computed
 * from the hydrated, UNREDACTED message with the popover's own rules (it reads
 * the address, the name only when it differs, the danger and warning issues,
 * the SPF/DKIM/DMARC results and a Reply-To domain check); the mask comes
 * after, so what the verdicts say is never worked out from masked text.
 */

const domainOf = (address) => address?.split('@')[1]?.toLowerCase() || '';

export function senderDetailsModel(message) {
  const from = message?.from;
  const address = from?.address || 'unknown';
  const name = from?.name && from.name !== from.address ? from.name : null;
  const issues = (checkSenderVerification(message).issues || [])
    .filter(i => i.level === 'danger' || i.level === 'warning')
    .map(({ level, text }) => ({ level, text }));
  const parsed = parseAuthResults(message?.authenticationResults);
  const hasAuth = parsed.spf !== null || parsed.dkim !== null || parsed.dmarc !== null;
  // The popover's read: an object or the first of an array.
  const replyToAddress = Array.isArray(message?.replyTo) ? message.replyTo[0]?.address : message?.replyTo?.address;
  const replyTo = replyToAddress
    ? { address: replyToAddress, matches: domainOf(replyToAddress) === domainOf(from?.address) }
    : null;
  return { address, name, issues, auth: hasAuth ? parsed : null, replyTo, noData: !hasAuth && issues.length === 0 };
}

/**
 * The model as a redacted image may show it: addresses and the name masked
 * unless the dictionary reveals that exact value, the issue lines masked like
 * any text (they quote addresses and names).
 */
export function maskSenderDetails(model, dict) {
  const reveal = dict?.reveal;
  const mask = (v) => (reveal?.has(String(v).trim().toLowerCase()) ? v : maskText(v));
  return {
    ...model,
    address: mask(model.address),
    name: model.name ? mask(model.name) : model.name,
    issues: model.issues.map(i => ({ ...i, text: maskString(i.text, dict) })),
    replyTo: model.replyTo ? { ...model.replyTo, address: mask(model.replyTo.address) } : null,
  };
}

const dotClass = (result) => {
  if (result === 'pass' || result === 'bestguesspass') return 'mv-ok';
  if (result === 'fail' || result === 'softfail') return 'mv-bad';
  return '';
};

const authRow = (label, result) =>
  `<div class="mv-row"><span class="mv-dot ${dotClass(result)}"></span><span class="mv-k">${esc(label)}</span><span class="mv-val">${esc(result || 'none')}</span></div>`;

/** The box, for the header block's document (PANEL_CSS styles it). Every value escaped. */
export function senderDetailsHtml(model) {
  const rows = [`<div class="mv-row"><span class="mv-k">${esc(t('common.from'))}</span><span class="mv-val">${esc(model.address)}</span></div>`];
  if (model.name) rows.push(`<div class="mv-row"><span class="mv-k">${esc(t('email.header.name'))}</span><span class="mv-val">${esc(model.name)}</span></div>`);

  let body = `<div>${rows.join('')}</div>`;
  if (model.issues.length) {
    body += `<div class="mv-sep">${model.issues.map(i => {
      const tone = i.level === 'danger' ? 'bad' : 'warn';
      return `<div class="mv-row"><span class="mv-dot mv-${tone}"></span><span class="mv-t-${tone}">${esc(i.text)}</span></div>`;
    }).join('')}</div>`;
  }
  if (model.auth) {
    body += `<div class="mv-sep"><h3 class="mv-sub">${esc(t('email.header.authentication'))}</h3>`
      + authRow(t('email.header.spf'), model.auth.spf)
      + authRow(t('email.header.dkim'), model.auth.dkim)
      + authRow(t('email.header.dmarc'), model.auth.dmarc);
    if (model.replyTo) {
      body += `<div class="mv-row mv-sep"><span class="mv-dot ${model.replyTo.matches ? 'mv-ok' : 'mv-warn'}"></span><span class="mv-k">${esc(t('email.header.reply'))}</span><span class="mv-val">${esc(model.replyTo.matches ? t('email.header.matchesSender') : model.replyTo.address)}</span></div>`;
    }
    body += '</div>';
  } else if (model.noData) {
    body += `<div class="mv-sep mv-muted">${esc(t('email.header.noAuthenticationDataAvailableEmail'))}</div>`;
  }
  return `<section class="mv-box" data-mv-box="sender"><h2 class="mv-box-title">${esc(t('email.header.senderDetails'))}</h2>${body}</section>`;
}
