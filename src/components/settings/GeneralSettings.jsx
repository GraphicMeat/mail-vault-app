import React, { useState } from 'react';
import { AppearanceSettings } from './AppearanceSettings';
import { BehaviorSettings } from './BehaviorSettings';
import { NotificationSettings } from './NotificationSettings';
import { ShortcutsSettings } from './ShortcutsSettings';

export function GeneralSettings({ accounts }) {
  const [generalSubTab, setGeneralSubTab] = useState('appearance');
  const generalSubTabs = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'behavior', label: 'Behavior' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  ];

  return (
    <div>
      {/* Sub-tab navigation */}
      <div className="flex border-b border-mail-border px-6 pt-2">
        {generalSubTabs.map(sub => (
          <button
            key={sub.id}
            onClick={() => setGeneralSubTab(sub.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
                       ${generalSubTab === sub.id
                         ? 'border-mail-accent text-mail-accent'
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
