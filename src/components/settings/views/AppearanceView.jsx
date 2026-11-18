// Settings > Appearance as a view: its section tabs and the intro, around the section the app
// renders (`children`). Desktop: AppearanceSettings.jsx; phone: src/mobile/settings/Appearance.jsx.
import React from 'react';
import { SettingsTabs } from '../../ui/SettingsTabs';
import { useViewT } from './viewContext';
import '../../../styles/settings-usability.css';

export const APPEARANCE_SECTIONS = [
  { id: 'colors', key: 'colors' },
  { id: 'text', key: 'text' },
  { id: 'layout', key: 'layout' },
  { id: 'reading', key: 'reading' },
  { id: 'date-time', key: 'dateTime' },
  { id: 'quick-actions', key: 'quickActions' },
  { id: 'language', key: 'language' },
];
export const validAppearanceSection = value => APPEARANCE_SECTIONS.some(section => section.id === value) ? value : 'colors';

export function AppearanceView({ section, onSectionChange, children }) {
  const t = useViewT();
  return (
    <SettingsTabs tabs={APPEARANCE_SECTIONS.map(({ id, key }) => ({ id, label: key === 'quickActions' ? t('quickActions.title') : key === 'language' ? t('settings.tab.language') : t(`settings.appearance.section.${key}`) }))}
      value={section} onChange={onSectionChange} label={t('settings.appearance.appearance')}>
      <div className="appearance-settings">
        {/* Quick actions draws the person's own mail, not samples. */}
        {!['language', 'quick-actions'].includes(section) && <p className="appearance-preview-intro">{t('settings.preview.intro')}</p>}
        {children}
      </div>
    </SettingsTabs>
  );
}
