import React, { useEffect, useState } from 'react';
import { MailX } from 'lucide-react';
import { useMailStore } from '../../stores/mailStore';
import { useUnsubscribeStore, unsubscribeTarget } from '../../stores/unsubscribeStore';
import { daemonCall } from '../../services/daemonClient';
import { formatDateTime } from '../../utils/dateFormat';
import { formatCount } from '../../utils/formatCount';
import { Button } from '../ui/Button';
import { SettingsPageLayout, SettingsSection } from '../ui/SettingsForm';
import { useT } from '../../i18n/index.js';

const CELL = 'py-1.5 px-2 text-left align-middle';

/**
 * Settings > Unsubscribe: senders whose mail carries List-Unsubscribe
 * (`unsubscribe.senders`, paged from the daemon's Insights snapshot) and the
 * app.db history of unsubscribes (`unsubscribe.history`), for all accounts or
 * one. The button goes through the same confirm flow as the row and reader.
 */
export function UnsubscribeSettings() {
  const t = useT();
  const accounts = useMailStore(s => s.accounts);
  const version = useUnsubscribeStore(s => s.version);
  const [scope, setScope] = useState('');
  const [senders, setSenders] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const accountId = scope || null;
    setError('');
    Promise.all([daemonCall('unsubscribe.senders', { accountId }), daemonCall('unsubscribe.history', { accountId })])
      .then(([rows, past]) => {
        if (!live) return;
        setSenders(Array.isArray(rows) ? rows : []);
        setHistory(Array.isArray(past) ? past : []);
      })
      .catch(e => {
        if (!live) return;
        setSenders([]);
        setError(String(e?.message || e));
      });
    return () => { live = false; };
  }, [scope, version]);

  const accountLabel = id => accounts.find(a => a.id === id)?.email || id;
  const methodLabel = method => method === 'one-click' ? t('unsubscribe.methodOneClick')
    : method === 'browser' ? t('unsubscribe.methodLink') : t('unsubscribe.methodEmail');
  const statusLabel = status => status === 'ok' ? t('common.done')
    : status === 'failed' ? t('unsubscribe.statusFailed') : t('unsubscribe.statusOpened');

  return <SettingsPageLayout as="section" spaced={false} data-testid="unsubscribe-settings" aria-label={t('unsubscribe.tabLabel')}>
    <SettingsSection title={t('unsubscribe.subscriptions')} description={t('unsubscribe.intro')}>
      <label className="flex items-center gap-2 text-sm mb-3">
        <span className="text-mail-text-muted">{t('unsubscribe.scope')}</span>
        <select data-testid="unsubscribe-scope" value={scope} onChange={e => { setSenders(null); setScope(e.target.value); }}
          className="bg-mail-bg border border-mail-border rounded-md px-2 py-1 text-sm">
          <option value="">{t('unsubscribe.allAccounts')}</option>
          {accounts.map(account => <option key={account.id} value={account.id}>{account.email}</option>)}
        </select>
      </label>
      {error && <p className="text-sm text-mail-danger" role="alert">{t('unsubscribe.loadFailed', { error })}</p>}
      {senders === null && <p className="text-sm text-mail-text-muted" aria-busy="true">{t('unsubscribe.loading')}</p>}
      {senders?.length === 0 && !error && <p className="text-sm text-mail-text-muted" data-testid="unsubscribe-empty">{t('unsubscribe.empty')}</p>}
      {senders?.length > 0 && <table className="w-full text-sm" data-testid="unsubscribe-senders">
        <thead><tr className="border-b border-mail-border text-mail-text-muted text-xs">
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colSender')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colMessages')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colLast')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colMethod')}</th>
          <th className={CELL}><span className="sr-only">{t('unsubscribe.action')}</span></th>
        </tr></thead>
        <tbody>{senders.map(sender => <tr key={sender.address} data-sender={sender.address} className="border-b border-mail-border last:border-0">
          <td className={CELL}>
            <div className="font-medium text-mail-text truncate">{sender.name || sender.address}</div>
            {sender.name && <div className="text-xs text-mail-text-muted truncate">{sender.address}</div>}
          </td>
          <td className={CELL}>{formatCount(sender.count)}</td>
          <td className={`${CELL} text-xs text-mail-text-muted`}>{sender.lastAt ? formatDateTime(sender.lastAt) : ''}</td>
          <td className={CELL}><span className="text-xs rounded-full px-2 py-0.5 bg-mail-accent/10 text-mail-accent-text">{methodLabel(sender.method)}</span></td>
          <td className={`${CELL} text-right`}>
            <Button variant="secondary" size="sm" data-testid="unsubscribe-sender"
              onClick={() => useUnsubscribeStore.getState().request(unsubscribeTarget(sender, sender.accountId))}>
              <MailX size={14} aria-hidden="true" />{t('unsubscribe.action')}
            </Button>
          </td>
        </tr>)}</tbody>
      </table>}
    </SettingsSection>

    <SettingsSection title={t('unsubscribe.history')}>
      {history.length === 0 && <p className="text-sm text-mail-text-muted">{t('unsubscribe.historyEmpty')}</p>}
      {history.length > 0 && <table className="w-full text-sm" data-testid="unsubscribe-history">
        <thead><tr className="border-b border-mail-border text-mail-text-muted text-xs">
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colSender')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colAccount')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colDate')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colStatus')}</th>
        </tr></thead>
        <tbody>{history.map((row, index) => <tr key={`${row.address}-${row.unsubscribedAt}-${index}`} className="border-b border-mail-border last:border-0">
          <td className={CELL}>{row.address}</td>
          <td className={`${CELL} text-xs text-mail-text-muted`}>{accountLabel(row.accountId)}</td>
          <td className={`${CELL} text-xs text-mail-text-muted`}>{formatDateTime(row.unsubscribedAt)}</td>
          <td className={`${CELL} text-xs`}>{methodLabel(row.method)} · {statusLabel(row.status)}</td>
        </tr>)}</tbody>
      </table>}
    </SettingsSection>
  </SettingsPageLayout>;
}
