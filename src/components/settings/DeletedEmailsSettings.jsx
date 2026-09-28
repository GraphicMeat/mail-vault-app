import React, { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { daemonCall } from '../../services/daemonClient';
import { recoverFromBin } from '../../services/workflows/messageMutations';
import { formatDateTime } from '../../utils/dateFormat';
import { Button } from '../ui/Button';
import { SettingsPageLayout, SettingsCard } from '../ui/SettingsForm';
import { useT } from '../../i18n/index.js';

/** How long the bin keeps a deleted email; the daemon clamps to 1..30. */
export const RETENTION_DAYS = [1, 3, 7, 14, 30];
const CELL = 'py-1.5 px-2 text-left align-middle';

const senderOf = (row) => (typeof row?.from === 'string' ? row.from : row?.from?.name || row?.from?.address || '');

/**
 * Settings > Storage > Deleted emails: the daemon's deleted-mail bin
 * (`deleted.list`), newest first, and how long it keeps them. A row goes back
 * to the server (`deleted.recover`, target server), into the vault as a local
 * copy (target local), or away for good (`deleted.discard`). The daemon owns
 * the bin; this page renders it and asks.
 */
export function DeletedEmailsSettings() {
  const t = useT();
  const accounts = useMailStore(s => s.accounts);
  const days = useSettingsStore(s => s.deletedRetentionDays) ?? 1;
  const setDays = useSettingsStore(s => s.setDeletedRetentionDays);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () => daemonCall('deleted.list')
    .then(list => setRows(list || []))
    .catch((e) => {
      console.warn('[deleted] list failed:', e);
      setRows([]);
      setError(t('deletedBin.loadFailed'));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  // A recover's error is already catalog copy (recoverFromBin); anything
  // else says `failKey`, never the daemon's own text.
  const act = async (id, run, failKey = null) => {
    setBusy(id);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(failKey ? t(failKey) : (e?.message || t('deletedBin.recoverFailed')));
    } finally {
      setBusy(null);
      await load();
    }
  };
  const accountLabel = id => accounts.find(a => a.id === id)?.email || id;

  return <SettingsPageLayout data-testid="deleted-emails-settings">
    <SettingsCard title={t('deletedBin.title')} icon={Trash2}>
      <p className="text-sm text-mail-text-muted mt-2 mb-4">{t('deletedBin.intro')}</p>
      <label className="flex items-center gap-3 text-sm text-mail-text mb-4">
        {t('deletedBin.retention')}
        <select data-testid="deleted-retention" value={days} onChange={e => setDays(Number(e.target.value))}
          className="px-3 py-1.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent cursor-pointer">
          {RETENTION_DAYS.map(n => <option key={n} value={n}>{t('deletedBin.days', { count: n })}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="text-sm text-mail-danger mb-3">{error}</p>}
      {rows === null && <p className="text-sm text-mail-text-muted" aria-busy="true">{t('deletedBin.loading')}</p>}
      {rows?.length === 0 && !error && <p className="text-sm text-mail-text-muted" data-testid="deleted-empty">{t('deletedBin.empty')}</p>}
      {rows?.length > 0 && <table className="w-full text-sm" data-testid="deleted-list">
        <thead><tr className="border-b border-mail-border text-mail-text-muted text-xs">
          <th className={`${CELL} font-medium`}>{t('deletedBin.colMessage')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colAccount')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colDate')}</th>
          <th className={`${CELL} font-medium`}>{t('deletedBin.colDeleted')}</th>
          <th className={CELL}><span className="sr-only">{t('deletedBin.actions')}</span></th>
        </tr></thead>
        <tbody>{rows.map(d => <tr key={d.id} data-deleted-id={d.id} className="border-b border-mail-border last:border-0">
          <td className={`${CELL} max-w-0 w-2/5`}>
            <div className="font-medium text-mail-text truncate">{d.row?.subject || t('common.noSubject')}</div>
            <div className="text-xs text-mail-text-muted truncate">{senderOf(d.row)}</div>
          </td>
          <td className={`${CELL} text-xs text-mail-text-muted truncate max-w-0`}>{accountLabel(d.accountId)}</td>
          <td className={`${CELL} text-xs text-mail-text-muted whitespace-nowrap`}>{d.row?.date ? formatDateTime(d.row.date) : ''}</td>
          <td className={`${CELL} text-xs text-mail-text-muted whitespace-nowrap`}>{formatDateTime(d.deletedAt)}</td>
          <td className={`${CELL} text-right`}>
            <div className="flex flex-wrap justify-end gap-1">
              <Button variant="secondary" size="sm" disabled={busy != null} data-action="recover-server"
                onClick={() => act(d.id, () => recoverFromBin([d.id], 'server'))}>{t('deletedBin.recoverServer')}</Button>
              <Button variant="ghost" size="sm" disabled={busy != null} data-action="recover-local"
                onClick={() => act(d.id, () => recoverFromBin([d.id], 'local'))}>{t('deletedBin.recoverLocal')}</Button>
              <Button variant="ghost" size="sm" disabled={busy != null} data-action="delete-now"
                onClick={() => act(d.id, () => daemonCall('deleted.discard', { ids: [d.id] }), 'deletedBin.discardFailed')}>{t('deletedBin.deleteNow')}</Button>
            </div>
          </td>
        </tr>)}</tbody>
      </table>}
    </SettingsCard>
  </SettingsPageLayout>;
}
