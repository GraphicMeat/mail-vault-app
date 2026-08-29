import React from 'react';
import { Shield } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { ToggleSwitch } from './ToggleSwitch';
import { useT } from '../../i18n/index.js';

export function SecuritySettings() {
  const t = useT();
  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);
  const setLinkSafetyEnabled = useSettingsStore(s => s.setLinkSafetyEnabled);
  const setLinkSafetyClickConfirm = useSettingsStore(s => s.setLinkSafetyClickConfirm);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-2 mb-2">
        <Shield size={18} className="text-mail-accent-text" />
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-mail-text">{t('settings.security.linkSafetyScanning')}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              {t('settings.security.detectSuspiciousLinksEmailsDon')}
            </div>
          </div>
          <ToggleSwitch active={linkSafetyEnabled} onClick={() => setLinkSafetyEnabled(!linkSafetyEnabled)} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-mail-text">{t('settings.security.clickConfirmation')}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              {t('settings.security.showWarningModalBeforeOpening')}
            </div>
          </div>
          <ToggleSwitch active={linkSafetyClickConfirm} onClick={() => setLinkSafetyClickConfirm(!linkSafetyClickConfirm)} />
        </div>
      </div>

      <div className="pt-4 border-t border-mail-border">
        <h4 className="text-sm font-medium text-mail-text mb-2">{t('settings.security.howWorks')}</h4>
        <div className="text-xs text-mail-text-muted space-y-1">
          <p><span className="text-mail-danger font-medium">{t('settings.security.redAlerts')}</span> — Link text shows one URL but actually goes to a different domain (phishing indicator)</p>
          <p><span className="text-mail-warning font-medium">{t('settings.security.yellowAlerts')}</span> — Link passes through a tracking redirect to a different domain</p>
          <p className="mt-2 text-mail-text-muted/70">{t('settings.security.allScanningPerformedLocallyDevice')}</p>
        </div>
      </div>
    </div>
  );
}
