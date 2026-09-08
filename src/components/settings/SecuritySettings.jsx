import React from 'react';
import { Shield } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { ToggleSwitch } from './ToggleSwitch';
import { useT, getLocale } from '../../i18n/index.js';
import { SafetyAlertLegend } from '../SafetyAlertLegend.jsx';

export function SecuritySettings() {
  const t = useT();
  // Subscribe to the epoch so a language switch re-resolves the screenshots too
  // — the same reason PremiumGallery reads it.
  useSettingsStore(s => s.localeEpoch);
  const locale = getLocale();
  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);
  const setLinkSafetyEnabled = useSettingsStore(s => s.setLinkSafetyEnabled);
  const setLinkSafetyClickConfirm = useSettingsStore(s => s.setLinkSafetyClickConfirm);

  return (
    <div className="settings-form space-y-6">
      <section className="settings-section">
        <h4 className="flex items-center gap-2 font-semibold text-mail-text mb-5">
          <Shield size={18} className="text-mail-accent-text" />{t('settings.tab.security')}
        </h4>
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-mail-text">{t('settings.security.linkSafetyScanning')}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              {t('settings.security.detectSuspiciousLinksEmailsDon')}
            </div>
          </div>
          <ToggleSwitch label={t('settings.security.linkSafetyScanning')} active={linkSafetyEnabled} onClick={() => setLinkSafetyEnabled(!linkSafetyEnabled)} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-mail-text">{t('settings.security.clickConfirmation')}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              {t('settings.security.showWarningModalBeforeOpening')}
            </div>
          </div>
          <ToggleSwitch label={t('settings.security.clickConfirmation')} active={linkSafetyClickConfirm} onClick={() => setLinkSafetyClickConfirm(!linkSafetyClickConfirm)} />
        </div>
      </div>

      </section>

      {/* Every mark the app can put on a message, with the screenshot of the
          alert it opens. This used to be two lines covering only the LINK
          levels, and their explanations were hardcoded English — so eight
          locales read a half-translated paragraph, and nothing here mentioned
          sender impersonation, Reply-To mismatch or the tracker glyphs at all. */}
      <div className="pt-4 border-t border-mail-border">
        <h4 className="text-sm font-medium text-mail-text mb-2">{t('settings.security.howWorks')}</h4>
        <SafetyAlertLegend locale={locale} showShots />
        <p className="mt-3 text-xs text-mail-text-muted">
          {t('settings.security.allScanningPerformedLocallyDevice')}
        </p>
      </div>
    </div>
  );
}
