import React, { forwardRef } from 'react';
import { useSettingsStore, getAccountColor, getAccountInitial } from '../../stores/settingsStore';
import { useAccountPolicy } from '../../services/accountPolicy';
import { t, useT  } from '../../i18n/index.js';
import { DesktopViewEnv } from './DesktopViewEnv';
import { DataUsageAccountCardView } from './views/DataUsageView';

// How a limit that is the provider's default is marked (English, as it always was here).
const PROVIDER_DEFAULT = ' (provider default)';

function bytesToMbInput(bytes) {
  return bytes == null ? '' : String(Math.round(bytes / (1024 * 1024)));
}

/** What an empty limit field means, shown as its placeholder: the Gmail figure in MB (it depends on the cap), else "Unlimited". */
function limitPlaceholder(defaultBytes) {
  return defaultBytes != null ? bytesToMbInput(defaultBytes) : t('settings.dataUsage.account.unlimited');
}

const DataUsageAccountCard = forwardRef(function DataUsageAccountCard({ account, stats, loading, unavailable, highlighted }, ref) {
  const t = useT();
  const accountColors = useSettingsStore(s => s.accountColors);
  const transferLimits = useSettingsStore(s => s.transferLimits);
  const setTransferLimit = useSettingsStore(s => s.setTransferLimit);

  const avatarColor = getAccountColor(accountColors, account);
  const avatarInitial = getAccountInitial(account);
  const config = transferLimits[account.id] || {};
  // The limits as the daemon reads and enforces them (`policy.accounts`);
  // nothing is shown for a limit until it answers.
  const shown = useAccountPolicy(account)?.transfer;
  const gmail = shown?.gmail === true;

  const NO_LIMIT = { limitBytes: null, isProviderDefault: false, defaultCapOn: null, defaultCapOff: null };
  const downLimit = shown?.down || NO_LIMIT;
  const upLimit = shown?.up || NO_LIMIT;

  const warnEnabled = config.warnEnabled !== false;
  const capEnabled = config.capEnabled === true;
  // An empty field stands for the provider default under the toggle as it is
  // now, before the change reaches the daemon.
  const placeholderBytes = (limit) => (capEnabled ? limit.defaultCapOn : limit.defaultCapOff);

  // ponytail: commit on blur, not onChange — avoids the input value jumping
  // mid-keystroke when the 30s stats refresh re-renders this card.
  const handleLimitBlur = (field) => (e) => {
    const trimmed = e.target.value.trim();
    const mb = trimmed === '' ? null : Number(trimmed);
    const bytes = mb == null ? null : Math.round(mb * 1024 * 1024);
    setTransferLimit(account.id, { [field]: Number.isFinite(bytes) ? bytes : null });
  };

  return (
    <DesktopViewEnv>
    <DataUsageAccountCardView ref={ref} account={account} avatarColor={avatarColor} avatarInitial={avatarInitial}
      stats={stats} loading={loading} unavailable={unavailable} highlighted={highlighted}
      downLimit={downLimit} upLimit={upLimit} defaultSuffix={PROVIDER_DEFAULT}
      warnEnabled={warnEnabled} capEnabled={capEnabled}
      onWarn={next => setTransferLimit(account.id, { warnEnabled: next })}
      onCap={next => setTransferLimit(account.id, { capEnabled: next })}
      pauseHint={<>
        {t('settings.dataUsage.account.pauseBackgroundDownloadsHint')}
        {gmail && ` ${t('settings.dataUsage.account.pauseBackgroundDownloadsGmailHint')}`}
      </>}
      limits={{
        down: { defaultValue: bytesToMbInput(config.dailyDownLimitBytes), onBlur: handleLimitBlur('dailyDownLimitBytes'), placeholder: limitPlaceholder(placeholderBytes(downLimit)) },
        up: { defaultValue: bytesToMbInput(config.dailyUpLimitBytes), onBlur: handleLimitBlur('dailyUpLimitBytes'), placeholder: limitPlaceholder(placeholderBytes(upLimit)) },
      }} />
    </DesktopViewEnv>
  );
});

export default DataUsageAccountCard;
