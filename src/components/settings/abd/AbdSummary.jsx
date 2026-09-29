import React from 'react';
import { Loader } from 'lucide-react';
import { Button } from '../../ui/Button';
import { formatBytes } from '../../../utils/formatBytes';
import { formatCount } from '../../../utils/formatCount';
import { GMAIL_LIMIT_DOWN_BYTES } from '../../../utils/transferLimits';
import { MODE_BACKUP } from '../../../utils/abdFrame';
import { folderLabel } from '../../abd/abdText';
import { useT } from '../../../i18n/index.js';

/**
 * What the job will do, the "I understand" tick and Start (part-d design 6.3).
 * `summary` is the daemon's dry run for the current selection; `years` is the
 * per-year list already narrowed to the chosen dates.
 */
export default function AbdSummary({
  summary, mode, folders, years, stale, confirmed, onConfirm, onStart, starting, error, onRetry,
}) {
  const t = useT();
  const total = summary.total || {};
  const count = total.uniqueMessages ?? total.count ?? 0;
  const estimate = summary.estimate;
  const ticked = (summary.folders || []).filter(f => folders.has(f.path) && f.count > 0);
  const backup = mode === MODE_BACKUP;
  const sum = (key) => ticked.reduce((n, f) => n + (f[key] || 0), 0);
  const warnings = new Set(summary.warnings || []);
  const canStart = confirmed && summary.canDelete && count > 0 && !stale && !starting;

  return (
    <section data-testid="abd-summary" data-stale={stale || undefined} className="space-y-3 border-t border-mail-border pt-4">
      <h5 className="text-sm font-semibold text-mail-text">{t('settings.backup.abd.setup.summary')}</h5>

      <p className="text-sm text-mail-text" data-testid="abd-summary-total">
        {t('settings.backup.abd.setup.summaryTotal', { count, size: formatBytes(total.bytes || 0) })}
      </p>

      {ticked.length > 0 && (
        <div>
          <div className="text-xs font-medium text-mail-text-muted mb-1">{t('settings.backup.abd.setup.perFolder')}</div>
          <ul className="space-y-0.5 text-xs text-mail-text" data-testid="abd-summary-folders">
            {ticked.map(f => (
              <li key={f.path} className="flex justify-between gap-3">
                <span className="truncate">{folderLabel(f)}</span>
                <span className="text-mail-text-muted tabular-nums">
                  {t('settings.backup.abd.setup.summaryTotal', { count: f.count, size: formatBytes(f.bytes || 0) })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {years.length > 0 && (
        <div>
          <div className="text-xs font-medium text-mail-text-muted mb-1">{t('settings.backup.abd.setup.perYear')}</div>
          <ul className="space-y-0.5 text-xs text-mail-text" data-testid="abd-summary-years">
            {years.map(y => (
              <li key={y.year} className="flex justify-between gap-3">
                <span>{t('settings.backup.abd.setup.yearCount', { year: y.year, count: y.count })}</span>
                <span className="text-mail-text-muted tabular-nums">{formatBytes(y.bytes || 0)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="space-y-0.5 text-xs text-mail-text-muted">
        <li data-testid="abd-summary-archived">{t('settings.backup.abd.setup.alreadyArchived', { count: formatCount(sum('alreadyArchived')) })}</li>
        {backup && <li data-testid="abd-summary-on-drive">{t('settings.backup.abd.setup.alreadyOnDrive', { count: formatCount(sum('alreadyOnDrive')) })}</li>}
        <li data-testid="abd-summary-download">{t('settings.backup.abd.setup.toDownload', { size: formatBytes(total.toDownloadBytes || 0) })}</li>
        {estimate?.days != null && (
          <li data-testid="abd-summary-estimate">
            {t('settings.backup.abd.setup.estimateDays', {
              count: estimate.days,
              limit: formatBytes(estimate.dailyLimitBytes ?? GMAIL_LIMIT_DOWN_BYTES),
            })}
          </li>
        )}
        {estimate?.gmailCap && <li>{t('settings.backup.abd.setup.estimateGmail')}</li>}
        {estimate && !estimate.gmailCap && estimate.dailyLimitBytes == null && (
          <li data-testid="abd-summary-no-limit">{t('settings.backup.abd.setup.estimateNoLimit')}</li>
        )}
        {warnings.has('multi_label') && <li>{t('settings.backup.abd.setup.multiLabel')}</li>}
        {warnings.has('trash_in_scope') && <li>{t('settings.backup.abd.setup.trashInScope')}</li>}
      </ul>

      {!summary.canDelete && (
        <p role="alert" data-testid="abd-cannot-delete" className="text-xs text-mail-danger">{t('settings.backup.abd.setup.cannotDelete')}</p>
      )}

      <label className="flex items-start gap-2 text-sm text-mail-text cursor-pointer">
        <input type="checkbox" data-testid="abd-confirm" checked={confirmed} onChange={e => onConfirm(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-mail-border accent-[var(--mail-accent)]" />
        <span>{t('settings.backup.abd.setup.confirm')}</span>
      </label>

      {error && (
        <div role="alert" data-testid="abd-start-error" className="text-xs text-mail-danger">
          {error}
          {onRetry && <Button variant="link" size="xs" className="ml-2" onClick={onRetry}>{t('common.retry')}</Button>}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" data-testid="abd-start" disabled={!canStart} onClick={onStart}>
          {starting && <Loader size={14} className="animate-spin" aria-hidden="true" />}
          {t('settings.backup.abd.setup.start')}
        </Button>
      </div>
    </section>
  );
}
