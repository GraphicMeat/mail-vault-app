import React, { useState, useEffect } from 'react';
import BackupRestore from './BackupRestore';
import BackupConfig from './BackupConfig';
import BackupSchedule from './BackupSchedule';
import { SettingsTabs } from './SettingsTabs';
import { t, useT } from '../../i18n/index.js';

const backupSubTabs = () => ([
  { id: 'restore', label: t('settings.tab.backup') },
  { id: 'config', label: t('settings.backup.backupSettings') },
  { id: 'schedule', label: t('settings.backup.backupSchedule') },
]);

export default function BackupSettings({ initialAccountId = null, initialSubTab = null, onSubTabChange, onUpgrade }) {
  const t = useT();
  const [activeSubTab, setActiveSubTab] = useState(initialSubTab || (initialAccountId ? 'schedule' : 'restore'));

  // A settings search result names its sub-tab; otherwise an initialAccountId
  // that arrives later opens that account's schedule.
  useEffect(() => {
    if (initialSubTab) setActiveSubTab(initialSubTab);
    else if (initialAccountId) setActiveSubTab('schedule');
  }, [initialSubTab, initialAccountId]);

  return (
    <SettingsTabs tabs={backupSubTabs()} value={activeSubTab} onChange={value => { setActiveSubTab(value); onSubTabChange?.(value); }}
      label={t('settings.tab.backup')}>
        {activeSubTab === 'restore' && <BackupRestore />}
        {activeSubTab === 'config' && <BackupConfig />}
        {activeSubTab === 'schedule' && (
          <BackupSchedule initialAccountId={initialAccountId} onUpgrade={onUpgrade} />
        )}
    </SettingsTabs>
  );
}
