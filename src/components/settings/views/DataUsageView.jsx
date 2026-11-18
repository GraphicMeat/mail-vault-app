// Settings > Storage > Data usage as views: the page (`DataUsageView`) and one card per account
// (`DataUsageAccountCardView`): what the account downloaded and uploaded today, this week, month
// or year, today against its daily limits, and the limits themselves.
import React, { forwardRef, useState } from 'react';
import { ArrowDown, ArrowUp, Loader } from 'lucide-react';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { Button } from '../../ui/Button';
import { SettingsPageLayout } from '../../ui/SettingsForm';
import { useT, useViewEnv } from './viewContext';

const PERIODS = [
  { id: 'day', labelKey: 'settings.dataUsage.period.day' },
  { id: 'week', labelKey: 'settings.dataUsage.period.week' },
  { id: 'month', labelKey: 'settings.dataUsage.period.month' },
  { id: 'year', labelKey: 'settings.dataUsage.period.year' },
];

const inputClass = 'w-full px-3 py-1.5 text-xs bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent';
const NO_LIMIT = { limitBytes: null, isProviderDefault: false };

/**
 * The page: `error` (`{ detail }`, with `onRetry`) when the counts could not be read, `hover`
 * (`{ active, onToggle }`, desktop's "Show usage on hover"), and `children`: the account cards, or
 * the empty state when there are none (`empty`).
 */
export function DataUsageView({ error = null, onRetry, retrying = false, hover = null, empty = false, children }) {
  const t = useT();
  return (
    <SettingsPageLayout>
      {error && (
        <div role="alert" className="flex items-center justify-between gap-4 text-sm text-mail-warning bg-mail-warning-tint border border-mail-warning/20 rounded-lg p-4">
          <div><p className="font-medium">{t('settings.dataUsage.loadFailed')}</p>{error.detail && <p className="text-xs mt-1 break-words">{error.detail}</p>}</div>
          <Button size="sm" disabled={retrying} onClick={onRetry}>{t('common.retry')}</Button>
        </div>
      )}
      {hover && (
        <div className="settings-section flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-mail-text">{t('settings.dataUsage.showUsageHover')}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              {t('settings.dataUsage.hoveringAccountSidebarShowsIts')}
            </div>
          </div>
          <ToggleSwitch label={t('settings.dataUsage.showUsageHover')} active={hover.active} onClick={hover.onToggle} />
        </div>
      )}

      {!empty ? children : (
        <div className="settings-section text-center">
          <h4 className="font-semibold text-mail-text mb-2">{t('common.noAccountsConfigured')}</h4>
          <p className="text-sm text-mail-text-muted">{t('settings.dataUsage.addEmailAccountFirstSee')}</p>
        </div>
      )}
    </SettingsPageLayout>
  );
}

/**
 * One account: `account` (`{ name, email }`), `avatarColor`, `avatarInitial`; `stats`
 * (`{ today, week, month, year }`, each `{ down, up }`), `loading`, `unavailable` (nothing is
 * counted for it), `highlighted`; `downLimit`/`upLimit` as enforced (`{ limitBytes,
 * isProviderDefault }`) and `defaultSuffix` naming a provider default; `warnEnabled`,
 * `capEnabled`, `onWarn(next)`, `onCap(next)`, `pauseHint`; `limits.down`/`limits.up`: the
 * typed limit fields (`{ defaultValue, placeholder, onBlur, inputProps }`); `notice`: a line under
 * the totals.
 */
export const DataUsageAccountCardView = forwardRef(function DataUsageAccountCardView({
  account, avatarColor, avatarInitial, stats, loading = false, unavailable = false, highlighted = false,
  downLimit = NO_LIMIT, upLimit = NO_LIMIT, defaultSuffix = '', warnEnabled, capEnabled, onWarn, onCap, pauseHint, limits, notice = null,
}, ref) {
  const t = useT();
  const { formatBytes, Private } = useViewEnv();
  const [period, setPeriod] = useState('day');

  const periodKey = period === 'day' ? 'today' : period;
  const periodStats = stats?.[periodKey] || { down: 0, up: 0 };
  const todayStats = stats?.today || { down: 0, up: 0 };

  return (
    <div
      ref={ref}
      className={`bg-mail-surface border rounded-xl p-5 transition-all duration-500 ${
        highlighted ? 'border-mail-accent ring-2 ring-mail-accent/30' : 'border-mail-border'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
            style={{ backgroundColor: avatarColor }}
          >
            {avatarInitial}
          </div>
          <div className="min-w-0">
            {account.name && <div className="text-sm font-medium text-mail-text truncate"><Private kind="name">{account.name}</Private></div>}
            <div className={`truncate ${account.name ? 'text-xs text-mail-text-muted' : 'text-sm font-medium text-mail-text'}`}>
              <Private kind="email">{account.email}</Private>
            </div>
          </div>
        </div>
        {loading && <Loader size={14} className="animate-spin text-mail-text-muted flex-shrink-0" />}
      </div>

      {/* Period switcher */}
      <div className="flex gap-1 bg-mail-bg rounded-lg p-1 mb-3 w-fit">
        {PERIODS.map(p => (
          <button
            key={p.id}
            aria-pressed={period === p.id}
            onClick={() => setPeriod(p.id)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
              period === p.id ? 'bg-mail-accent-fill text-white' : 'text-mail-text-muted hover:text-mail-text'
            }`}
          >
            {t(p.labelKey)}
          </button>
        ))}
      </div>

      {/* Totals for the selected period */}
      {unavailable ? <p className="text-sm text-mail-text-muted py-3" role="status">{t('settings.dataUsage.unavailable')}</p> : <div className="grid grid-cols-2 gap-4 pt-3 border-t border-mail-border" aria-busy={loading}>
        <div>
          <div className="text-xs text-mail-text-muted flex items-center gap-1"><ArrowDown size={12} className="text-mail-accent" /> {t('settings.dataUsage.account.downloaded')}</div>
          <div className="text-sm font-semibold text-mail-text">{loading && !stats ? '-' : formatBytes(periodStats.down)}</div>
        </div>
        <div>
          <div className="text-xs text-mail-text-muted flex items-center gap-1"><ArrowUp size={12} className="text-mail-text-muted" /> {t('settings.dataUsage.account.uploaded')}</div>
          <div className="text-sm font-semibold text-mail-text">{loading && !stats ? '-' : formatBytes(periodStats.up)}</div>
        </div>
      </div>}

      {/* Progress vs today's daily limit — always today, independent of the period switcher above */}
      {!unavailable && !loading && (downLimit.limitBytes != null || upLimit.limitBytes != null) && (
        <div className="space-y-2 pt-3 mt-3 border-t border-mail-border">
          <div className="text-xs text-mail-text-muted">{t('settings.dataUsage.account.todayVsDailyLimit')}</div>
          {downLimit.limitBytes != null && (
            <div>
              <div className="flex items-center justify-between text-[11px] text-mail-text-muted mb-0.5">
                <span>{t('settings.dataUsage.account.download')}</span>
                <span>
                  {formatBytes(todayStats.down)} / {formatBytes(downLimit.limitBytes)}
                  {downLimit.isProviderDefault ? defaultSuffix : ''}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-mail-border overflow-hidden">
                <div
                  className={`h-1.5 rounded-full transition-all ${todayStats.down / downLimit.limitBytes >= 0.8 ? 'bg-mail-warning' : 'bg-mail-accent'}`}
                  style={{ width: `${Math.min(100, Math.round((todayStats.down / downLimit.limitBytes) * 100))}%` }}
                />
              </div>
            </div>
          )}
          {upLimit.limitBytes != null && (
            <div>
              <div className="flex items-center justify-between text-[11px] text-mail-text-muted mb-0.5">
                <span>{t('settings.dataUsage.account.upload')}</span>
                <span>
                  {formatBytes(todayStats.up)} / {formatBytes(upLimit.limitBytes)}
                  {upLimit.isProviderDefault ? defaultSuffix : ''}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-mail-border overflow-hidden">
                <div
                  className={`h-1.5 rounded-full transition-all ${todayStats.up / upLimit.limitBytes >= 0.8 ? 'bg-mail-warning' : 'bg-mail-accent'}`}
                  style={{ width: `${Math.min(100, Math.round((todayStats.up / upLimit.limitBytes) * 100))}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {notice}

      {/* Toggles + limit inputs */}
      <div className="space-y-3 pt-3 mt-3 border-t border-mail-border">
        <div className="flex items-center justify-between">
          <span className="text-xs text-mail-text">{t('settings.dataUsage.account.warnWhenNearingDailyLimit')}</span>
          <ToggleSwitch label={t('settings.dataUsage.account.warnWhenNearingDailyLimit')} active={warnEnabled} onClick={() => onWarn(!warnEnabled)} />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-mail-text">{t('settings.dataUsage.account.pauseBackgroundDownloads')}</span>
            <ToggleSwitch label={t('settings.dataUsage.account.pauseBackgroundDownloads')} active={capEnabled} onClick={() => onCap(!capEnabled)} />
          </div>
          <p className="text-[11px] text-mail-text-muted mt-1" data-testid="pause-background-hint">
            {pauseHint}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div>
            <label className="text-[11px] text-mail-text-muted mb-1 block">{t('settings.dataUsage.account.dailyDownloadLimitMb')}</label>
            <input aria-label={t('settings.dataUsage.account.dailyDownloadLimitMb')}
              type="number"
              min="0"
              {...limits.down.inputProps}
              defaultValue={limits.down.defaultValue}
              onBlur={limits.down.onBlur}
              placeholder={limits.down.placeholder}
              className={inputClass}
            />
          </div>
          <div>
            <label className="text-[11px] text-mail-text-muted mb-1 block">{t('settings.dataUsage.account.dailyUploadLimitMb')}</label>
            <input aria-label={t('settings.dataUsage.account.dailyUploadLimitMb')}
              type="number"
              min="0"
              {...limits.up.inputProps}
              defaultValue={limits.up.defaultValue}
              onBlur={limits.up.onBlur}
              placeholder={limits.up.placeholder}
              className={inputClass}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
