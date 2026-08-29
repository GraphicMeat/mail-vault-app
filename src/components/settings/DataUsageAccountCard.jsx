import React, { forwardRef, useState } from 'react';
import { useSettingsStore, getAccountColor, getAccountInitial } from '../../stores/settingsStore';
import { ToggleSwitch } from './ToggleSwitch';
import { formatBytes } from '../../utils/formatBytes';
import { isGmailAccount, resolveDailyLimitBytes } from '../../utils/transferLimits';
import { ArrowDown, ArrowUp, Loader } from 'lucide-react';
import { useT } from '../../i18n/index.js';

const PERIODS = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

const inputClass = 'w-full px-3 py-1.5 text-xs bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent';

function bytesToMbInput(bytes) {
  return bytes == null ? '' : String(Math.round(bytes / (1024 * 1024)));
}

const DataUsageAccountCard = forwardRef(function DataUsageAccountCard({ account, stats, loading, highlighted }, ref) {
  const t = useT();
  const [period, setPeriod] = useState('day');
  const accountColors = useSettingsStore(s => s.accountColors);
  const transferLimits = useSettingsStore(s => s.transferLimits);
  const setTransferLimit = useSettingsStore(s => s.setTransferLimit);

  const avatarColor = getAccountColor(accountColors, account);
  const avatarInitial = getAccountInitial(account);
  const config = transferLimits[account.id] || {};
  const gmail = isGmailAccount(account);

  const periodKey = period === 'day' ? 'today' : period;
  const periodStats = stats?.[periodKey] || { down: 0, up: 0 };
  const todayStats = stats?.today || { down: 0, up: 0 };

  const downLimit = resolveDailyLimitBytes(config, gmail, 'down');
  const upLimit = resolveDailyLimitBytes(config, gmail, 'up');

  const warnEnabled = config.warnEnabled !== false;
  const capEnabled = config.capEnabled === true;

  // ponytail: commit on blur, not onChange — avoids the input value jumping
  // mid-keystroke when the 30s stats refresh re-renders this card.
  const handleLimitBlur = (field) => (e) => {
    const trimmed = e.target.value.trim();
    const mb = trimmed === '' ? null : Number(trimmed);
    const bytes = mb == null ? null : Math.round(mb * 1024 * 1024);
    setTransferLimit(account.id, { [field]: Number.isFinite(bytes) ? bytes : null });
  };

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
            {account.name && <div className="text-sm font-medium text-mail-text truncate">{account.name}</div>}
            <div className={`truncate ${account.name ? 'text-xs text-mail-text-muted' : 'text-sm font-medium text-mail-text'}`}>
              {account.email}
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
            onClick={() => setPeriod(p.id)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
              period === p.id ? 'bg-mail-accent-fill text-white' : 'text-mail-text-muted hover:text-mail-text'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Totals for the selected period */}
      <div className="grid grid-cols-2 gap-4 pt-3 border-t border-mail-border">
        <div>
          <div className="text-xs text-mail-text-muted flex items-center gap-1"><ArrowDown size={12} className="text-mail-accent" /> {t('settings.dataUsage.account.downloaded')}</div>
          <div className="text-sm font-semibold text-mail-text">{formatBytes(periodStats.down)}</div>
        </div>
        <div>
          <div className="text-xs text-mail-text-muted flex items-center gap-1"><ArrowUp size={12} className="text-mail-text-muted" /> {t('settings.dataUsage.account.uploaded')}</div>
          <div className="text-sm font-semibold text-mail-text">{formatBytes(periodStats.up)}</div>
        </div>
      </div>

      {/* Progress vs today's daily limit — always today, independent of the period switcher above */}
      {(downLimit.limitBytes != null || upLimit.limitBytes != null) && (
        <div className="space-y-2 pt-3 mt-3 border-t border-mail-border">
          <div className="text-xs text-mail-text-muted">{t('settings.dataUsage.account.todayVsDailyLimit')}</div>
          {downLimit.limitBytes != null && (
            <div>
              <div className="flex items-center justify-between text-[11px] text-mail-text-muted mb-0.5">
                <span>{t('settings.dataUsage.account.download')}</span>
                <span>
                  {formatBytes(todayStats.down)} / {formatBytes(downLimit.limitBytes)}
                  {downLimit.isProviderDefault ? ' (provider default)' : ''}
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
                  {upLimit.isProviderDefault ? ' (provider default)' : ''}
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

      {/* Toggles + limit inputs */}
      <div className="space-y-3 pt-3 mt-3 border-t border-mail-border">
        <div className="flex items-center justify-between">
          <span className="text-xs text-mail-text">{t('settings.dataUsage.account.warnWhenNearingDailyLimit')}</span>
          <ToggleSwitch active={warnEnabled} onClick={() => setTransferLimit(account.id, { warnEnabled: !warnEnabled })} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-mail-text">{t('settings.dataUsage.account.pauseSyncDailyLimit')}</span>
          <ToggleSwitch active={capEnabled} onClick={() => setTransferLimit(account.id, { capEnabled: !capEnabled })} />
        </div>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div>
            <label className="text-[11px] text-mail-text-muted mb-1 block">Daily download limit (MB)</label>
            <input
              type="number"
              min="0"
              defaultValue={bytesToMbInput(config.dailyDownLimitBytes)}
              onBlur={handleLimitBlur('dailyDownLimitBytes')}
              placeholder={gmail ? 'Provider default' : 'Unlimited'}
              className={inputClass}
            />
          </div>
          <div>
            <label className="text-[11px] text-mail-text-muted mb-1 block">Daily upload limit (MB)</label>
            <input
              type="number"
              min="0"
              defaultValue={bytesToMbInput(config.dailyUpLimitBytes)}
              onBlur={handleLimitBlur('dailyUpLimitBytes')}
              placeholder={gmail ? 'Provider default' : 'Unlimited'}
              className={inputClass}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

export default DataUsageAccountCard;
