import { t } from '../i18n/index.js';
import { notify } from '../stores/focusStore.js';
import { useCodeBubbleStore } from '../stores/codeBubbleStore.js';

const text = value => typeof value === 'string' ? value : '';
const positiveUid = value => Number.isSafeInteger(value) && value > 0;

/** Native chooses the variant, membership, policy and target. This adapter
 * only fills the selected catalog template in the current UI language. */
export function renderPreparedNotice(notice) {
  if (!notice || typeof notice !== 'object') return null;
  const { kind, data = {} } = notice.presentation || {};
  const count = Number.isSafeInteger(data.count) && data.count > 0 ? data.count : 1;
  const sender = text(data.sender) || t('notify.arrival.unknownSender');
  const subject = text(data.subject) || t('common.noSubject');
  const accountEmail = text(data.accountEmail);
  let title, body;
  switch (kind) {
    case 'singlePreview':
      title = sender;
      body = text(data.code) ? `${data.code}\n${subject}` : subject;
      break;
    case 'batchPreview':
      title = t('notify.arrival.newEmails', { count });
      body = t('notify.arrival.batchPreviewBody', { sender, subject, more: count - 1 });
      break;
    case 'singlePrivate':
      title = t('notify.arrival.newEmail');
      body = t('notify.arrival.singlePrivateBody', { accountEmail });
      break;
    case 'batchPrivate':
      title = t('notify.arrival.newEmail');
      body = t('notify.arrival.batchPrivateBody', { count, accountEmail });
      break;
    default: return null;
  }
  const target = { accountId: notice.accountId, mailbox: notice.mailbox };
  if ((kind === 'singlePreview' || kind === 'batchPreview')
    && positiveUid(notice.target?.uid)) target.uid = notice.target.uid;
  if (text(notice.target?.code) && target.uid) target.code = notice.target.code;
  return { title, body, target };
}

export function offerPreparedCode(ready) {
  if (!ready || !text(ready.accountId) || !text(ready.mailbox)
    || !positiveUid(ready.uid) || !text(ready.code)) return false;
  useCodeBubbleStore.getState().offer({
    accountId: ready.accountId, mailbox: ready.mailbox, uid: ready.uid,
    code: ready.code, sender: text(ready.sender), subject: text(ready.subject),
  });
  return true;
}

/** A prepared mail enters the existing Focus/privacy chokepoint once. */
export async function deliverPreparedNotice(notice) {
  const rendered = renderPreparedNotice(notice);
  if (!rendered) return false;
  if (notice.banner || notice.logPolicy) {
    const mailCtx = { accountId: notice.accountId, folder: notice.mailbox,
      from: text(notice.fromAddress), viewIds: [] };
    const sound = notice.sound === 'none' ? undefined : notice.sound;
    await notify(rendered.title, rendered.body, sound, rendered.target, mailCtx,
      { deliver: notice.deliver === true, reason: text(notice.reason) });
  }
  if (notice.codeReady) offerPreparedCode({
    ...notice.codeReady, accountId: notice.accountId, mailbox: notice.mailbox,
    sender: text(notice.from), subject: text(notice.presentation?.data?.subject),
  });
  return true;
}
