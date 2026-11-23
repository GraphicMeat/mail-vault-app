// Settings > Privacy & security > Security as a view: link safety scanning, its click confirmation,
// and asking before external content loads. `values`: `{ linkSafetyEnabled, linkSafetyClickConfirm,
// holdExternalContent }`; `onChange(key, value)` sets one. `legend`: what every warning mark means
// (desktop's SafetyAlertLegend with its screenshots; the phone's SafetyAlertLegendView).
import React from 'react';
import { Shield } from 'lucide-react';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { SettingsPageLayout, SettingsCard } from '../../ui/SettingsForm';
import { useT } from './viewContext';

export function SecurityView({ values, onChange, legend = null }) {
  const t = useT();
  const { linkSafetyEnabled, linkSafetyClickConfirm, holdExternalContent } = values;
  return (
    <SettingsPageLayout>
      <SettingsCard icon={Shield} headingClassName="mb-5" title={t('settings.tab.security')}>
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-mail-text">{t('settings.security.linkSafetyScanning')}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              {t('settings.security.detectSuspiciousLinksEmailsDon')}
            </div>
          </div>
          <ToggleSwitch label={t('settings.security.linkSafetyScanning')} active={linkSafetyEnabled} onClick={() => onChange('linkSafetyEnabled', !linkSafetyEnabled)} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-mail-text">{t('settings.security.clickConfirmation')}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              {t('settings.security.showWarningModalBeforeOpening')}
            </div>
          </div>
          <ToggleSwitch label={t('settings.security.clickConfirmation')} active={linkSafetyClickConfirm} onClick={() => onChange('linkSafetyClickConfirm', !linkSafetyClickConfirm)} />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-mail-text">{t('settings.security.askBeforeExternalContent')}</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              {t('settings.security.askBeforeExternalContentHint')}
            </div>
          </div>
          <ToggleSwitch label={t('settings.security.askBeforeExternalContent')} active={!!holdExternalContent} onClick={() => onChange('holdExternalContent', !holdExternalContent)} testId="ask-before-external-content" />
        </div>
      </div>

      </SettingsCard>

      {/* Every mark the app can put on a message, with the screenshot of the
          alert it opens. This used to be two lines covering only the LINK
          levels, and their explanations were hardcoded English — so eight
          locales read a half-translated paragraph, and nothing here mentioned
          sender impersonation, Reply-To mismatch or the tracker glyphs at all. */}
      <SettingsCard>
        <h4 className="text-sm font-medium text-mail-text mb-2">{t('settings.security.howWorks')}</h4>
        {legend}
        <p className="mt-3 text-xs text-mail-text-muted">
          {t('settings.security.allScanningPerformedLocallyDevice')}
        </p>
      </SettingsCard>
    </SettingsPageLayout>
  );
}
