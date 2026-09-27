import React, { useState } from 'react';
import { SegmentedChoice } from '../ui/SegmentedChoice';
import { Button } from '../ui/Button';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { FETCH_MODES } from '../../utils/fetchPolicy';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import { useT } from '../../i18n/index.js';

const MODE_LABEL = {
  onDemand: 'settings.storage.modeOnDemand',
  keepRecent: 'settings.storage.modeKeepRecent',
  indexOnly: 'settings.storage.modeIndexOnly',
  hoarder: 'settings.storage.modeHoarder',
};
const MODE_HINT = {
  onDemand: 'settings.storage.modeHintOnDemand',
  keepRecent: 'settings.storage.modeHintKeepRecent',
  indexOnly: 'settings.storage.modeHintIndexOnly',
  hoarder: 'settings.storage.modeHintHoarder',
};
const WINDOWS = [[1, 'settings.storage.mo1'], [3, 'settings.storage.mo3'], [6, 'settings.storage.mo6'], [12, 'settings.storage.year1']];

/**
 * How much mail stays on this computer (Track H download modes). Settings >
 * Storage and onboarding use it for the default mode and its window; with
 * `accountId` it is that account's override ("Use default" clears it), and the
 * window, which is global, is left to the default's control.
 */
export function DownloadModeControl({ accountId = null, onUpgrade }) {
  const t = useT();
  const premium = useSettingsStore(s => hasPremiumAccess(s.billingProfile));
  const defaultMode = useSettingsStore(s => s.fetchMode) || 'keepRecent';
  const override = useSettingsStore(s => (accountId ? s.fetchModes?.[accountId] : undefined));
  const windowMonths = useSettingsStore(s => s.localCacheDurationMonths);
  const [upsell, setUpsell] = useState(false);

  const value = accountId ? (override || 'default') : defaultMode;
  const mode = value === 'default' ? defaultMode : value;

  const choose = (next) => {
    if (next === value) return;
    // Arrow keys move through the group too, so this only explains; the
    // upgrade itself is a deliberate click.
    if (next === 'hoarder' && !premium) { setUpsell(true); return; }
    setUpsell(false);
    const store = useSettingsStore.getState();
    if (accountId) store.setAccountFetchMode(accountId, next === 'default' ? null : next);
    else store.setFetchMode(next);
  };

  const options = [
    ...(accountId ? [{ value: 'default', label: t('settings.storage.useDefaultMode', { mode: t(MODE_LABEL[defaultMode]) }) }] : []),
    ...FETCH_MODES.map(m => ({
      value: m,
      label: m === 'hoarder' && !premium
        ? <>{t(MODE_LABEL[m])} <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-mail-accent-fill text-white rounded-full">{t('common.premium')}</span></>
        : t(MODE_LABEL[m]),
    })),
  ];

  return (
    <div className="space-y-3" data-testid="download-mode">
      <SegmentedChoice label={t('settings.storage.downloadMode')} options={options} value={value} onChange={choose} />
      <p className="text-sm text-mail-text-muted">{t(MODE_HINT[mode])}</p>

      {!accountId && (mode === 'keepRecent' || mode === 'indexOnly') && (
        <div>
          <div className="text-sm font-medium text-mail-text">{t('settings.storage.keepWindow')}</div>
          <SegmentedChoice label={t('settings.storage.keepWindow')} value={windowMonths}
            onChange={months => useSettingsStore.getState().setLocalCacheDurationMonths(months)}
            options={WINDOWS.map(([months, key]) => ({ value: months, label: t(key) }))} />
        </div>
      )}

      {mode === 'hoarder' && !premium && (
        <p data-testid="download-mode-no-premium" className="text-sm text-mail-text-muted">{t('settings.storage.hoarderWithoutPremium')}</p>
      )}

      {upsell && !premium && (
        <div data-testid="download-mode-upsell" className="border border-mail-accent/30 bg-mail-accent/5 rounded-xl p-4">
          <p className="text-sm text-mail-text">{t('settings.storage.hoarderUpsell')}</p>
          {!IS_APPSTORE_BUILD && onUpgrade && (
            <Button variant="primary" size="sm" className="mt-3" data-testid="download-mode-upgrade" onClick={onUpgrade}>
              {t('common.upgrade')}
            </Button>
          )}
        </div>
      )}

      <p className="text-xs text-mail-text-muted">{t('settings.storage.modeNeverRemoves')}</p>
      {mode !== 'hoarder' && <p className="text-xs text-mail-text-muted">{t('settings.storage.modeServerFetch')}</p>}
    </div>
  );
}
