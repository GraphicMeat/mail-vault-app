import React, { useState } from 'react';
import { AppearanceSettings } from './AppearanceSettings';
import { BehaviorSettings } from './BehaviorSettings';
import { NotificationSettings } from './NotificationSettings';
import { ShortcutsSettings } from './ShortcutsSettings';
import { useT, t  } from '../../i18n/index.js';

export function GeneralSettings({ accounts }) {
  const t = useT();
  const [generalSubTab, setGeneralSubTab] = useState('appearance');
  const generalSubTabs = [
    { id: 'appearance', label: t('settings.appearance.appearance') },
    { id: 'behavior', label: t('generalSettings.behavior') },
    { id: 'notifications', label: t('settings.notifications.notifications') },
    { id: 'shortcuts', label: t('shortcuts.keyboardShortcuts') },
  ];

  return (
    <div>
      {/* Sub-tab navigation */}
      <div className="flex flex-wrap border-b border-mail-border px-6 pt-2">
        {generalSubTabs.map(sub => (
          <button
            key={sub.id}
            onClick={() => setGeneralSubTab(sub.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
                       ${generalSubTab === sub.id
                         ? 'border-mail-accent text-mail-accent-text'
                         : 'border-transparent text-mail-text-muted hover:text-mail-text hover:border-mail-border'}`}
          >
            {sub.label}
          </button>
        ))}
      </div>

      <div className="p-6 space-y-6">
        {generalSubTab === 'appearance' && <AppearanceSettings />}
        {generalSubTab === 'behavior' && <BehaviorSettings />}
        {generalSubTab === 'notifications' && <NotificationSettings accounts={accounts} />}
        {generalSubTab === 'shortcuts' && <ShortcutsSettings />}
      </div>
    </div>
  );
}
