import React, { useEffect, useState } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore, getAccountColor } from '../../stores/settingsStore';
import { useSearchStore } from '../../stores/searchStore';
import { useViewStore } from '../../stores/viewStore';
import { useUnsubscribeStore, useUnsubscribeSendersStore, unsubscribeTarget } from '../../stores/unsubscribeStore';
import { openNotificationTarget } from '../../utils/notificationOpen';
import { useT } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { DesktopViewEnv } from './DesktopViewEnv';
import { UnsubscribeView } from './views/UnsubscribeView';

const byLastAt = (a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0);
const byUnsubscribedAt = (a, b) => (b.unsubscribedAt || 0) - (a.unsubscribedAt || 0);

/**
 * Settings > Unsubscribe: senders whose mail carries List-Unsubscribe
 * (`unsubscribe.senders`, paged from the daemon's Insights snapshot) and the
 * app.db history of unsubscribes (`unsubscribe.history`). Both are asked once
 * per account, in parallel (useUnsubscribeSendersStore); All accounts and
 * each account are views of those answers, so switching asks nothing. The
 * button goes through the same confirm flow as the row and reader. With
 * `onMinimize` (Settings in the main window) a sender opens its mail.
 */
export function UnsubscribeSettings({ onMinimize }) {
  const t = useT();
  const pa = usePrivateAttr();
  const accounts = useMailStore(s => s.accounts);
  const accountColors = useSettingsStore(s => s.accountColors);
  const byAccount = useUnsubscribeSendersStore(s => s.byAccount);
  const [scope, setScope] = useState('');

  const accountIds = accounts.map(account => account.id);
  useEffect(() => {
    useUnsubscribeSendersStore.getState().load(accountIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIds.join('\n')]);

  // A scope whose account was removed meanwhile falls back to all of them.
  const current = accounts.some(account => account.id === scope) ? scope : '';
  const shown = current ? accounts.filter(account => account.id === current) : accounts;
  const allShown = !current && accounts.length > 1;
  const entries = shown.map(account => ({ account, entry: byAccount[account.id] }));
  const loading = entries.some(({ entry }) => !entry || entry.status === 'loading');
  const failed = entries.filter(({ entry }) => entry?.status === 'error');
  const senders = entries.flatMap(({ entry }) => entry?.senders || []).sort(byLastAt);
  const history = entries.flatMap(({ entry }) => entry?.history || []).sort(byUnsubscribedAt);

  const stateOf = entry => !entry || entry.status === 'loading' ? 'loading' : entry.status;
  const scopes = [
    { value: '', label: t('unsubscribe.allAccounts'),
      state: accounts.some(account => stateOf(byAccount[account.id]) === 'loading') ? 'loading' : 'ready',
      count: accounts.reduce((sum, account) => sum + (byAccount[account.id]?.senders.length || 0), 0) },
    ...accounts.map(account => {
      const entry = byAccount[account.id];
      return { value: account.id, label: pa(account.email, 'email'), color: getAccountColor(accountColors, account),
        state: stateOf(entry), count: entry?.senders.length || 0,
        title: entry?.status === 'error' ? t('unsubscribe.accountLoadFailed', { account: pa(account.email, 'email'), error: entry.error }) : undefined };
    }),
  ];

  const accountOf = id => accounts.find(a => a.id === id);
  const accountLabel = id => accountOf(id)?.email || id;

  // Settings steps aside to the bubble and the list shows this sender's mail
  // in the folder of its newest subscription message, as a `from:` search
  // the search box shows and can clear.
  const showSenderMail = async sender => {
    onMinimize();
    const views = useViewStore.getState();
    if (views.activeViewId) views.closeView();
    const search = useSearchStore.getState();
    // A folder or date filter left from an earlier search must not narrow this one.
    search.clearSearch();
    // An account that cannot reach its server still has its vault to search.
    await openNotificationTarget({ accountId: sender.accountId, mailbox: sender.mailbox || 'INBOX' }, useMailStore.getState)
      .catch(e => console.warn('[unsubscribe] open sender folder failed:', e));
    search.setSearchQuery(`from:${sender.address}`);
    await search.performSearch();
  };

  return <DesktopViewEnv>
    <UnsubscribeView scopes={scopes} scope={current} onScope={setScope}
      failures={failed.map(({ account, entry }) => ({ id: account.id, text: t('unsubscribe.accountLoadFailed', { account: pa(account.email, 'email'), error: entry.error }) }))}
      loading={loading} senders={senders} history={history} showAccounts={allShown}
      accountOf={id => { const account = accountOf(id); return account && { email: account.email, color: getAccountColor(accountColors, account) }; }}
      accountLabel={accountLabel}
      onUnsubscribe={sender => useUnsubscribeStore.getState().request(unsubscribeTarget(sender, sender.accountId))}
      onShowSender={onMinimize ? showSenderMail : undefined} />
  </DesktopViewEnv>;
}
