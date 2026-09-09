import { useMailStore } from '../../stores/mailStore';
import { useConnectivityStore } from '../../stores/connectivityStore';
import { t } from '../../i18n/index.js';
export { cancelInsightsSelection } from './selectEmail.js';

/** Open one verified physical copy without changing the active mailbox. */
export async function openInsightsMessage(match) {
  const accounts = useMailStore.getState().accounts;
  const online = useConnectivityStore.getState().online;
  const copies = (match?.copies || []).filter(copy => accounts.some(a => a.id === copy.accountId))
    .filter(copy => copy.source === 'vault'
      ? copy.locationLimitation !== 'vault-file-missing' && !!(copy.localMailbox || !copy.locationLimitation)
      : online && !copy.locationLimitation && !copy.serverDeleted && !copy.serverAbsent)
    .sort((a, b) => Number(b.source === 'vault') - Number(a.source === 'vault'));
  let lastError;
  for (const copy of copies) {
    const local = copy.source === 'vault';
    const unresolved = copy.locationLimitation === 'server-mailbox-unresolved';
    const mailbox = unresolved ? copy.localMailbox : copy.mailbox;
    if (!mailbox) continue;
    const header = { ...copy, _accountId: copy.accountId, _mailbox: mailbox,
      _origin: copy.origin ?? null, _insightsNoServerActions: unresolved, _insightsReadOnly: true,
      isArchived: local,
    };
    try {
      return await useMailStore.getState().selectEmail(copy.uid, local ? 'local-only' : 'server', mailbox,
        { accountId: copy.accountId, mailbox, uid: copy.uid, header });
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error(t('insights.messageUnavailable'));
}
