// Settings > Storage > Deleted emails as a view: the deleted-mail bin, newest first, and how long
// it keeps them. Both apps hand it their bin's rows and act on a row themselves.
//
// - `rows`: desktop's `deleted.list` rows (`{id, accountId, row: {subject, from, date},
//   deletedAt}`), `null` while loading; `accountLabel(id)` names a row's account.
// - `days` / `onDays(n)`: the retention, one of `RETENTION_DAYS`.
// - `error`: catalog copy shown above the list; `busy`: an action is running (every button waits).
// - `onRecover(id)` (to the server), `onRecoverLocal(id)` (into the vault; desktop only, the button
//   shows only with it), `onDiscard(id)` (gone for good).
// - `intro`: the line under the title (desktop's `deletedBin.intro` unless given).
// - `onMore`: more rows to read (the phone reads its bin a page at a time).
import React from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsPageLayout, SettingsCard } from '../../ui/SettingsForm';
import { useT, useViewEnv } from './viewContext';

/** How long the bin keeps a deleted email; both apps clamp to 1..30. */
export const RETENTION_DAYS = [1, 3, 7, 14, 30];
const CELL = 'py-1.5 px-2 text-left align-middle';

const senderOf = (row) => (typeof row?.from === 'string' ? row.from : row?.from?.name || row?.from?.address || '');

export function DeletedEmailsView({ rows, days, onDays, error, busy, intro, accountLabel, onRecover, onRecoverLocal, onDiscard, onMore }) {
  const t = useT();
  const { formatDateTime, Private } = useViewEnv();
  return <SettingsPageLayout data-testid="deleted-emails-settings">
    <SettingsCard title={t('deletedBin.title')} icon={Trash2}>
      <p className="text-sm text-mail-text-muted mt-2 mb-4">{intro ?? t('deletedBin.intro')}</p>
      <label className="flex items-center gap-3 text-sm text-mail-text mb-4">
        {t('deletedBin.retention')}
        <select data-testid="deleted-retention" aria-label={t('deletedBin.retention')} value={days} onChange={e => onDays(Number(e.target.value))}
          className="px-3 py-1.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:border-mail-accent cursor-pointer">
          {RETENTION_DAYS.map(n => <option key={n} value={n}>{t('deletedBin.days', { count: n })}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="text-sm text-mail-danger mb-3">{error}</p>}
      {rows === null && <p className="text-sm text-mail-text-muted" aria-busy="true">{t('deletedBin.loading')}</p>}
      {rows?.length === 0 && !error && <p className="text-sm text-mail-text-muted" data-testid="deleted-empty">{t('deletedBin.empty')}</p>}
      {rows?.length > 0 && <table className="deleted-table w-full text-sm" data-testid="deleted-list">
        <thead><tr className="border-b border-mail-border text-mail-text-muted text-xs">
          <th className={`${CELL} font-medium`}>{t('deletedBin.colMessage')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colAccount')}</th>
          <th className={`${CELL} font-medium`}>{t('unsubscribe.colDate')}</th>
          <th className={`${CELL} font-medium`}>{t('deletedBin.colDeleted')}</th>
          <th className={CELL}><span className="sr-only">{t('deletedBin.actions')}</span></th>
        </tr></thead>
        <tbody>{rows.map(d => <tr key={d.id} data-deleted-id={d.id} className="border-b border-mail-border last:border-0">
          <td className={`${CELL} max-w-0 w-2/5`}>
            <div className="font-medium text-mail-text truncate">{d.row?.subject ? <Private kind="text">{d.row.subject}</Private> : t('common.noSubject')}</div>
            <div className="text-xs text-mail-text-muted truncate"><Private kind="name">{senderOf(d.row)}</Private></div>
          </td>
          <td className={`${CELL} text-xs text-mail-text-muted truncate max-w-0`}><Private kind="name">{accountLabel(d.accountId)}</Private></td>
          <td className={`${CELL} text-xs text-mail-text-muted whitespace-nowrap`}>{d.row?.date ? formatDateTime(d.row.date) : ''}</td>
          <td className={`${CELL} text-xs text-mail-text-muted whitespace-nowrap`}>{formatDateTime(d.deletedAt)}</td>
          <td className={`${CELL} text-right`}>
            <div className="flex flex-wrap justify-end gap-1">
              <Button variant="secondary" size="sm" disabled={busy} data-action="recover-server"
                onClick={() => onRecover(d.id)}>{t('deletedBin.recoverServer')}</Button>
              {onRecoverLocal && <Button variant="ghost" size="sm" disabled={busy} data-action="recover-local"
                onClick={() => onRecoverLocal(d.id)}>{t('deletedBin.recoverLocal')}</Button>}
              <Button variant="ghost" size="sm" disabled={busy} data-action="delete-now"
                onClick={() => onDiscard(d.id)}>{t('deletedBin.deleteNow')}</Button>
            </div>
          </td>
        </tr>)}</tbody>
      </table>}
      {onMore && <div className="mt-3"><Button variant="secondary" size="sm" disabled={busy} data-action="load-more" onClick={onMore}>{t('explorer.loadMore')}</Button></div>}
    </SettingsCard>
  </SettingsPageLayout>;
}
