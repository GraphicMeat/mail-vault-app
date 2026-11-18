// Settings > Help & Support as a view: one card of rows, each a title, an optional subtitle and its
// action, ruled off from the one before. `rows`: `[{ id, testid, title, subtitle, action }]`, the
// app's own (both start with Report a Bug and desktop's links; desktop adds the Premium gallery
// and onboarding reset, the phone its tour, version and source). `OpenLinkButton` is the rows'
// "Open" button for a page outside the app (`onOpen(url)` opens it the app's way).
import React from 'react';
import { Mail, ExternalLink } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsPageLayout, SettingsCard } from '../../ui/SettingsForm';
import { useT } from './viewContext';

export function OpenLinkButton({ url, onOpen, icon: Icon = ExternalLink }) {
  const t = useT();
  return (
    <Button variant="subtle"
      onClick={() => onOpen(url)}
      data-url={url}
    >
      <Icon size={16} />
      {t('common.open')}
    </Button>
  );
}

export function HelpView({ rows }) {
  const t = useT();
  return (
    <SettingsPageLayout>
      <SettingsCard icon={Mail} headingClassName="mb-4" title={t('settings.tab.help')}>
        <div className="space-y-4">
          {rows.map((row, index) => (
            <React.Fragment key={row.id}>
              {index > 0 && <div className="border-t border-mail-border" />}
              <div className="flex items-center justify-between py-2" data-testid={row.testid}>
                <div>
                  <div className="font-medium text-mail-text">{row.title}</div>
                  {row.subtitle && <div className="text-sm text-mail-text-muted">{row.subtitle}</div>}
                </div>
                {row.action}
              </div>
            </React.Fragment>
          ))}
        </div>
      </SettingsCard>
    </SettingsPageLayout>
  );
}
