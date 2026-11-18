import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { getLocale } from '../../i18n/index.js';
import { SafetyAlertLegend } from '../SafetyAlertLegend.jsx';
import { DesktopViewEnv } from './DesktopViewEnv';
import { SecurityView } from './views/SecurityView';

const SETTERS = {
  linkSafetyEnabled: 'setLinkSafetyEnabled',
  linkSafetyClickConfirm: 'setLinkSafetyClickConfirm',
  holdExternalContent: 'setHoldExternalContent',
};

/** Desktop's container: the settings store over SecurityView, with the legend's screenshots. */
export function SecuritySettings() {
  // Subscribe to the epoch so a language switch re-resolves the screenshots too
  // — the same reason PremiumGallery reads it.
  useSettingsStore(s => s.localeEpoch);
  const locale = getLocale();
  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);
  const holdExternalContent = useSettingsStore(s => s.holdExternalContent);

  return (
    <DesktopViewEnv>
      <SecurityView values={{ linkSafetyEnabled, linkSafetyClickConfirm, holdExternalContent }}
        onChange={(key, value) => useSettingsStore.getState()[SETTERS[key]](value)}
        legend={<SafetyAlertLegend locale={locale} showShots />} />
    </DesktopViewEnv>
  );
}
