import React, { useState, useEffect } from 'react';
import BackupRestore from './BackupRestore';
import BackupConfig from './BackupConfig';
import BackupSchedule from './BackupSchedule';
import { t } from '../../i18n/index.js';

const backupSubTabs = () => ([
  { id: 'restore', label: t('settings.tab.backup') },
  { id: 'config', label: t('settings.backup.backupSettings') },
  { id: 'schedule', label: t('settings.backup.backupSchedule') },
]);

export default function BackupSettings({ initialAccountId = null, onUpgrade }) {
  const [activeSubTab, setActiveSubTab] = useState(initialAccountId ? 'schedule' : 'restore');

  // If initialAccountId arrives later, switch to schedule tab
  useEffect(() => {
    if (initialAccountId) setActiveSubTab('schedule');
  }, [initialAccountId]);

  return (
    <div>
      {/* Sub-tab navigation */}
      <div className="flex flex-wrap border-b border-mail-border px-6 pt-2">
        {backupSubTabs().map(sub => (
          <button
            key={sub.id}
            onClick={() => setActiveSubTab(sub.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
                       ${activeSubTab === sub.id
                         ? 'border-mail-accent text-mail-accent-text'
                         : 'border-transparent text-mail-text-muted hover:text-mail-text hover:border-mail-border'}`}
          >
            {sub.label}
          </button>
        ))}
      </div>

      <div className="p-6">
        {activeSubTab === 'restore' && <BackupRestore />}
        {activeSubTab === 'config' && <BackupConfig />}
        {activeSubTab === 'schedule' && (
          <BackupSchedule initialAccountId={initialAccountId} onUpgrade={onUpgrade} />
        )}
      </div>
    </div>
  );
}
