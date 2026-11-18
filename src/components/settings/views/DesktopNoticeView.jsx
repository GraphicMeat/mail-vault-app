// A settings page whose feature is in MailVault on desktop only (the manifest's `desktopNotice`
// pages: Cleanup, Backup, Time Capsule, Migration): the page's own icon and name over one line,
// "<Feature> is available in MailVault on desktop". The phone opens it in desktop's place.
import React from 'react';
import { Monitor } from 'lucide-react';
import { SettingsPageLayout, SettingsCard } from '../../ui/SettingsForm';
import { useT } from './viewContext';

export function DesktopNoticeView({ feature, icon = Monitor }) {
  const t = useT();
  return (
    <SettingsPageLayout>
      <SettingsCard icon={icon} title={feature} headingClassName="mb-2" data-desktop-notice>
        <p className="text-sm text-mail-text-muted">{t('settings.desktopNotice', { feature })}</p>
      </SettingsCard>
    </SettingsPageLayout>
  );
}
