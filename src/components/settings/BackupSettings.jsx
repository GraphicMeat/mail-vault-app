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

export default function BackupSettings({ initialAccountId = null, onUpgrade }) {
  const t = useT();
  const [activeSubTab, setActiveSubTab] = useState(initialAccountId ? 'schedule' : 'restore');

  // If initialAccountId arrives later, switch to schedule tab
  useEffect(() => {
    if (initialAccountId) setActiveSubTab('schedule');
  }, [initialAccountId]);

  return (
    <SettingsTabs tabs={backupSubTabs()} value={activeSubTab} onChange={setActiveSubTab}
      label={t('settings.tab.backup')}>
        {activeSubTab === 'restore' && <BackupRestore />}
        {activeSubTab === 'config' && <BackupConfig />}
        {activeSubTab === 'schedule' && (
          <BackupSchedule initialAccountId={initialAccountId} onUpgrade={onUpgrade} />
        )}
    </SettingsTabs>
  );
}
