import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader, MailX } from 'lucide-react';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore, getAccountColor } from '../../stores/settingsStore';
import { useSearchStore } from '../../stores/searchStore';
import { useViewStore } from '../../stores/viewStore';
import { useUnsubscribeStore, useUnsubscribeSendersStore, unsubscribeTarget } from '../../stores/unsubscribeStore';
import { openNotificationTarget } from '../../utils/notificationOpen';
import { formatDateTime } from '../../utils/dateFormat';
import { formatCount } from '../../utils/formatCount';
import { Button } from '../ui/Button';
import { SettingsPageLayout, SettingsSection } from '../ui/SettingsForm';
import { useT } from '../../i18n/index.js';

const CELL = 'py-1.5 px-2 text-left align-middle';
const byLastAt = (a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0);
const byUnsubscribedAt = (a, b) => (b.unsubscribedAt || 0) - (a.unsubscribedAt || 0);
const PILL_KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** One pill per scope, a radio group with the arrow keys, Home and End. */
function ScopePills({ label, options, value, onChange }) {
  const pills = useRef([]);
  const move = (event, index) => {
    const step = PILL_KEYS[event.key];
    const next = step ? (index + step + options.length) % options.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onChange(options[next].value);
    pills.current[next]?.focus();
  };
  return <div role="radiogroup" aria-label={label} data-testid="unsubscribe-scope" className="flex flex-wrap gap-2 mb-4">
    {options.map((option, index) => {
      const on = option.value === value;
      return <button key={option.value || '*'} ref={node => { pills.current[index] = node; }} type="button"
        role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-scope={option.value}
        data-state={option.state} aria-busy={option.state === 'loading' || undefined} title={option.title}
        onClick={() => onChange(option.value)} onKeyDown={event => move(event, index)}
        className={`inline-flex items-center gap-1.5 min-w-0 max-w-full px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${on
          ? 'bg-mail-accent-fill text-white border-mail-accent'
          : 'border-mail-border text-mail-text-muted hover:border-mail-accent hover:text-mail-text'}`}>
        {option.color && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: option.color }} aria-hidden="true" />}
        <span className="truncate">{option.label}</span>
        {option.state === 'loading' ? <Loader size={12} className="animate-spin shrink-0" aria-hidden="true" />
          : option.state === 'error' ? <AlertCircle size={12} className={`shrink-0 ${on ? '' : 'text-mail-danger'}`} aria-hidden="true" />
          : <span className={`shrink-0 rounded-full px-1.5 text-[11px] leading-4 tabular-nums ${on
            ? 'bg-white/20 text-white' : 'bg-mail-accent/10 text-mail-accent-text'}`}>{formatCount(option.count)}</span>}
      </button>;
    })}
  </div>;
}

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
      return { value: account.id, label: account.email, color: getAccountColor(accountColors, account),
        state: stateOf(entry), count: entry?.senders.length || 0,
        title: entry?.status === 'error' ? t('unsubscribe.accountLoadFailed', { account: account.email, error: entry.error }) : undefined };
    }),
  ];

  const accountOf = id => accounts.find(a => a.id === id);
  const accountLabel = id => accountOf(id)?.email || id;
  const methodLabel = method => method === 'one-click' ? t('unsubscribe.methodOneClick')
    : method === 'browser' ? t('unsubscribe.methodLink') : t('unsubscribe.methodEmail');
  const statusLabel = status => status === 'ok' ? t('common.done')
    : status === 'failed' ? t('unsubscribe.statusFailed') : t('unsubscribe.statusOpened');

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
    await openNotificationTarget({ accountId: sender.accountId, mailbox: sender.mailbox || 'INBOX' }, useMailStore.getState);
    search.setSearchQuery(`from:${sender.address}`);
    await search.performSearch();
  };

  return <SettingsPageLayout as="section" spaced={false} data-testid="unsubscribe-settings" aria-label={t('unsubscribe.tabLabel')}>
    <SettingsSection title={t('unsubscribe.subscriptions')} description={t('unsubscribe.intro')}>
      {accounts.length > 1 && <ScopePills label={t('unsubscribe.scope')} options={scopes} value={current} onChange={setScope} />}
      {failed.length > 0 && <div role="alert" className="mb-3 space-y-1">
        {failed.map(({ account, entry }) => <p key={account.id} className="text-sm text-mail-danger">
          {t('unsubscribe.accountLoadFailed', { account: account.email, error: entry.error })}
        </p>)}
      </div>}
      {loading && senders.length === 0 && <p className="text-sm text-mail-text-muted" aria-busy="true">{t('unsubscribe.loading')}</p>}
      {!loading && senders.length === 0 && failed.length === 0 && <p className="text-sm text-mail-text-muted" data-testid="unsubscribe-empty">{t('unsubscribe.empty')}</p>}
      {senders.length > 0 && <table className="w-full text-sm" data-testid="unsubscribe-senders">
        <thead><tr className="border-b border-mail-border text-mail-text-muted text-xs">
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colSender')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colMessages')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colLast')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colMethod')}</th>
          <th className={CELL}><span className="sr-only">{t('unsubscribe.action')}</span></th>
        </tr></thead>
        <tbody>{senders.map(sender => {
          const label = sender.name || sender.address;
          const account = allShown && accountOf(sender.accountId);
          return <tr key={`${sender.accountId}\u0000${sender.address}`} data-sender={sender.address} className="border-b border-mail-border last:border-0">
            <td className={`${CELL} max-w-0 w-1/2`}>
              {onMinimize
                ? <button type="button" onClick={() => showSenderMail(sender)} aria-label={t('unsubscribe.showMail', { sender: label })}
                  title={t('unsubscribe.showMail', { sender: label })}
                  className="block max-w-full truncate text-left font-medium text-mail-accent-text hover:underline underline-offset-2 rounded-sm">{label}</button>
                : <div className="font-medium text-mail-text truncate">{label}</div>}
              {(sender.name || account) && <div className="flex items-center gap-x-2 min-w-0 text-xs text-mail-text-muted">
                {sender.name && <span className="truncate">{sender.address}</span>}
                {account && <span data-testid="unsubscribe-row-account" className="inline-flex items-center gap-1 min-w-0 shrink-0 max-w-[50%]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: getAccountColor(accountColors, account) }} aria-hidden="true" />
                  <span className="truncate">{account.email}</span>
                </span>}
              </div>}
            </td>
            <td className={`${CELL} tabular-nums`}>{formatCount(sender.count)}</td>
            <td className={`${CELL} text-xs text-mail-text-muted`}>{sender.lastAt ? formatDateTime(sender.lastAt) : ''}</td>
            <td className={CELL}><span className="text-xs rounded-full px-2 py-0.5 bg-mail-accent/10 text-mail-accent-text">{methodLabel(sender.method)}</span></td>
            <td className={`${CELL} text-right`}>
              <Button variant="secondary" size="sm" data-testid="unsubscribe-sender"
                onClick={() => useUnsubscribeStore.getState().request(unsubscribeTarget(sender, sender.accountId))}>
                <MailX size={14} aria-hidden="true" />{t('unsubscribe.action')}
              </Button>
            </td>
          </tr>;
        })}</tbody>
      </table>}
    </SettingsSection>

    <SettingsSection title={t('unsubscribe.history')}>
      {history.length === 0 && !loading && <p className="text-sm text-mail-text-muted">{t('unsubscribe.historyEmpty')}</p>}
      {history.length > 0 && <table className="w-full text-sm" data-testid="unsubscribe-history">
        <thead><tr className="border-b border-mail-border text-mail-text-muted text-xs">
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colSender')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colAccount')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colDate')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colStatus')}</th>
        </tr></thead>
        <tbody>{history.map((row, index) => <tr key={`${row.accountId}-${row.address}-${row.unsubscribedAt}-${index}`} className="border-b border-mail-border last:border-0">
          <td className={CELL}>{row.address}</td>
          <td className={`${CELL} text-xs text-mail-text-muted`}>{accountLabel(row.accountId)}</td>
          <td className={`${CELL} text-xs text-mail-text-muted`}>{formatDateTime(row.unsubscribedAt)}</td>
          <td className={`${CELL} text-xs`}>{methodLabel(row.method)} · {statusLabel(row.status)}</td>
        </tr>)}</tbody>
      </table>}
    </SettingsSection>
  </SettingsPageLayout>;
}
