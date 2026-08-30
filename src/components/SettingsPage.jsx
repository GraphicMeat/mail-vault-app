import React, { useState, useEffect, useId } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import {
  X,
  User,
  Mail,
  FileText,
  HardDrive,
  Palette,
  ScrollText,
  Shield,
  Clock,
  ArrowLeftRight,
  CreditCard,
  Sparkles,
  Server,
  Settings,
  ChevronLeft,
  Gauge,
  EyeOff,
  Languages,
} from 'lucide-react';
import { GeneralSettings } from './settings/GeneralSettings';
import { AccountSettings } from './settings/AccountSettings';
import { TemplateSettings } from './settings/TemplateSettings';
import { StorageSettings } from './settings/StorageSettings';
import DataUsageSettings from './settings/DataUsageSettings';
import { SecuritySettings } from './settings/SecuritySettings';
import { LogsSettings } from './settings/LogsSettings';
import { HelpSettings } from './settings/HelpSettings';
import BackupSettings from './settings/BackupSettings';
import MigrationSettings from './settings/MigrationSettings.jsx';
import { BillingSettings } from './settings/BillingSettings';
import { AISettings } from './settings/AISettings';
import { DaemonSettings } from './settings/DaemonSettings';
import { TimeCapsuleSettings } from './settings/TimeCapsuleSettings';
import { CleanupView } from './settings/CleanupSettings';
import { LanguageSettings } from './settings/LanguageSettings';
import { TrackerBlockingView } from './settings/TrackerBlockingView';
import { TimeCapsuleView } from './TimeCapsule';
import { useT } from '../i18n/index.js';

const featureTabs = [
  { id: 'cleanup', labelKey: 'settings.tab.cleanup', icon: Sparkles },
  { id: 'time-capsule', labelKey: 'settings.tab.timeCapsule', icon: Clock },
  { id: 'tracking', labelKey: 'settings.tab.tracking', icon: EyeOff },
  { id: 'migration', labelKey: 'settings.tab.migration', icon: ArrowLeftRight },
  { id: 'backup', labelKey: 'settings.tab.backup', icon: Clock },
];

const settingsTabs = [
  { id: 'general', labelKey: 'settings.tab.general', icon: Palette },
  { id: 'accounts', labelKey: 'settings.tab.accounts', icon: User },
  { id: 'templates', labelKey: 'settings.tab.templates', icon: FileText },
  { id: 'storage', labelKey: 'settings.tab.storage', icon: HardDrive },
  { id: 'data-usage', labelKey: 'settings.tab.dataUsage', icon: Gauge },
  { id: 'security', labelKey: 'settings.tab.security', icon: Shield },
  { id: 'billing', labelKey: 'settings.tab.billing', icon: CreditCard },
  // Literal, not t(): this array is module-level and evaluated once at import,
  // so a t() call here would freeze English at load and never re-translate.
  // Plan 2 moves these labels to keys resolved at render.
  { id: 'language', labelKey: 'settings.tab.language', icon: Languages },
];

const systemTabs = [
  { id: 'daemon', labelKey: 'settings.tab.daemon', icon: Server },
  { id: 'logs', labelKey: 'settings.tab.logs', icon: ScrollText },
  { id: 'help', labelKey: 'settings.tab.help', icon: Mail },
];

const allTabs = [...featureTabs, ...settingsTabs, ...systemTabs];
const featureTabIds = new Set(featureTabs.map(t => t.id));
// Tabs that show account pills and config sub-views
const accountPillTabIds = new Set(['cleanup', 'time-capsule']);

export function SettingsPage({ onClose, onAddAccount, onReportBug, initialTab, initialAccountId }) {
  const t = useT();
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);

  // Close on Escape — capture phase, and only while this is the top dialog, so
  // a confirmation opened inside Settings peels off first.
  const titleId = useId();

  // Map old 'ai' tab ID to new 'cleanup'
  const resolvedInitialTab = initialTab === 'ai' ? 'cleanup' : initialTab;
  const [activeTab, setActiveTab] = useState(resolvedInitialTab || 'general');
  const [subView, setSubView] = useState(null); // null = feature view, 'config' = settings sub-view
  const [selectedFeatureAccountId, setSelectedFeatureAccountId] = useState(activeAccountId);
  const [featureDetailActive, setFeatureDetailActive] = useState(false);

  // Reset subView when switching tabs
  const handleTabChange = (tabId) => {
    setActiveTab(tabId);
    setSubView(null);
    setFeatureDetailActive(false);
  };

  // Keep feature account in sync if global active changes
  useEffect(() => {
    if (activeAccountId) setSelectedFeatureAccountId(activeAccountId);
  }, [activeAccountId]);

  const isFeatureTab = featureTabIds.has(activeTab);
  const hasAccountPills = accountPillTabIds.has(activeTab);
  const hasConfigSubView = accountPillTabIds.has(activeTab);
  const currentTab = allTabs.find(t => t.id === activeTab);

  return (
    <Dialog
      open
      onClose={onClose}
      size="custom"
      data-testid="settings-page"
      aria-labelledby={titleId}
      className="p-4"
      panelClassName="w-full max-w-7xl h-[92vh] rounded-2xl flex overflow-hidden"
    >
        {/* Sidebar */}
        <div className="w-44 sm:w-56 flex-shrink-0 bg-mail-surface border-r border-mail-border flex flex-col">
          <div className="px-4 py-4 border-b border-mail-border flex items-center h-[57px]">
            <h2 id={titleId} className="text-lg font-semibold text-mail-text">{t('settingsPage.settings')}</h2>
          </div>

          <nav className="flex-1 p-2 overflow-y-auto">
            {[
              { labelKey: 'settings.section.features', tabs: featureTabs },
              { labelKey: 'settings.section.settings', tabs: settingsTabs },
              { labelKey: 'settings.section.system', tabs: systemTabs },
            ].map((section, i) => (
              <React.Fragment key={section.labelKey}>
                {i > 0 && <div className="mx-3 my-2 border-t border-mail-border" />}
                <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-mail-text-muted uppercase tracking-wider">{t(section.labelKey)}</p>
                {section.tabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg
                               text-left transition-colors mb-0.5
                               ${activeTab === tab.id
                                 ? 'bg-mail-accent/10 text-mail-accent-text'
                                 : 'text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'}`}
                  >
                    <tab.icon size={18} />
                    <span className="text-sm font-medium">{t(tab.labelKey)}</span>
                  </button>
                ))}
              </React.Fragment>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-mail-border h-[57px] shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              {hasConfigSubView && subView === 'config' && (
                <Button variant="ghost" icon size="sm"
                  onClick={() => setSubView(null)}
                >
                  <ChevronLeft size={18} className="text-mail-text-muted" />
                </Button>
              )}
              <h3 className="text-lg font-semibold text-mail-text truncate">
                {hasConfigSubView && subView === 'config'
                  ? t('settingsPage.tabSettings', { tab: currentTab ? t(currentTab.labelKey) : '' })
                  : (currentTab ? t(currentTab.labelKey) : '')}
              </h3>
            </div>
            <div className="flex items-center gap-2">
              {hasConfigSubView && subView !== 'config' && (
                <Button variant="ghost" icon size="md"
                  onClick={() => setSubView('config')}
                  title={t('settingsPage.settings')}
                >
                  <Settings size={18} className="text-mail-text-muted" />
                </Button>
              )}
              <Button variant="ghost" icon size="md"
                onClick={onClose}
              >
                <X size={20} className="text-mail-text-muted" />
              </Button>
            </div>
          </div>

          {/* Account pills for feature tabs */}
          {hasAccountPills && subView !== 'config' && !featureDetailActive && accounts.length > 1 && (
            <div className="flex items-center gap-2 px-6 py-2.5 border-b border-mail-border shrink-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
              {accounts.map(acc => (
                <button
                  key={acc.id}
                  onClick={() => setSelectedFeatureAccountId(acc.id)}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-colors whitespace-nowrap shrink-0 ${
                    selectedFeatureAccountId === acc.id
                      ? 'bg-mail-accent-fill text-white border-mail-accent'
                      : 'border-mail-border text-mail-text-muted hover:border-mail-accent hover:text-mail-text'
                  }`}
                >
                  {acc.email}
                </button>
              ))}
            </div>
          )}

          {/* Content Area */}
          <div className={`flex-1 ${hasAccountPills && subView !== 'config' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
            {activeTab === 'cleanup' && (
              subView === 'config'
                ? <AISettings />
                : <CleanupView accountId={selectedFeatureAccountId} onDetailChange={setFeatureDetailActive} onUpgrade={() => handleTabChange('billing')} />
            )}

            {activeTab === 'time-capsule' && (
              subView === 'config'
                ? <TimeCapsuleSettings />
                : <TimeCapsuleView accountId={selectedFeatureAccountId} onDetailChange={setFeatureDetailActive} onUpgrade={() => handleTabChange('billing')} />
            )}

            {activeTab === 'tracking' && (
              <TrackerBlockingView onUpgrade={() => handleTabChange('billing')} />
            )}

            {activeTab === 'general' && (
              <GeneralSettings accounts={accounts} />
            )}

            {activeTab === 'accounts' && (
              <AccountSettings accounts={accounts} onAddAccount={onAddAccount} initialAccountId={initialAccountId} />
            )}

            {activeTab === 'templates' && (
              <TemplateSettings />
            )}

            {activeTab === 'storage' && (
              <StorageSettings accounts={accounts} onUpgrade={() => handleTabChange('billing')} />
            )}

            {activeTab === 'data-usage' && (
              <DataUsageSettings initialAccountId={initialAccountId} />
            )}

            {activeTab === 'backup' && (
              <BackupSettings initialAccountId={initialAccountId} onUpgrade={() => handleTabChange('billing')} />
            )}

            {activeTab === 'migration' && (
              <MigrationSettings onUpgrade={() => handleTabChange('billing')} />
            )}

            {activeTab === 'daemon' && (
              <DaemonSettings />
            )}

            {activeTab === 'billing' && (
              <BillingSettings onNavigate={handleTabChange} />
            )}

            {activeTab === 'language' && (
              <LanguageSettings />
            )}

            {activeTab === 'security' && (
              <SecuritySettings />
            )}

            {activeTab === 'logs' && (
              <LogsSettings />
            )}

            {activeTab === 'help' && (
              <HelpSettings onClose={onClose} onReportBug={onReportBug} />
            )}
          </div>
        </div>
    </Dialog>
  );
}
