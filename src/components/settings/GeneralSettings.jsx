import React, { useEffect, useState } from 'react';
import { BehaviorSettings } from './BehaviorSettings';
import { NotificationSettings } from './NotificationSettings';
import { ShortcutsSettings } from './ShortcutsSettings';
import { SettingsTabs } from './SettingsTabs';
import { useT } from '../../i18n/index.js';

const validSubTab = value => ['behavior', 'notifications', 'shortcuts'].includes(value) ? value : 'behavior';

export function GeneralSettings({ accounts, initialSubTab = 'behavior', onSubTabChange, active = true }) {
  const t = useT();
  const [generalSubTab, setGeneralSubTab] = useState(() => validSubTab(initialSubTab));
  useEffect(() => setGeneralSubTab(validSubTab(initialSubTab)), [initialSubTab]);
  const generalSubTabs = [
    { id: 'behavior', label: t('generalSettings.behavior') },
    { id: 'notifications', label: t('settings.notifications.notifications') },
    { id: 'shortcuts', label: t('shortcuts.keyboardShortcuts') },
  ];

  return (
    <SettingsTabs tabs={generalSubTabs} value={generalSubTab}
      onChange={value => { setGeneralSubTab(value); onSubTabChange?.(value); }} label={t('settings.navigation.mailPreferences')}>
        {generalSubTab === 'behavior' && <BehaviorSettings />}
        {generalSubTab === 'notifications' && <NotificationSettings accounts={accounts} />}
        {generalSubTab === 'shortcuts' && <ShortcutsSettings active={active} />}
    </SettingsTabs>
  );
}
