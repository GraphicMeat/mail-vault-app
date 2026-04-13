import React, { useState, useEffect } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { motion } from 'framer-motion';
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
} from 'lucide-react';
import { GeneralSettings } from './settings/GeneralSettings';
import { AccountSettings } from './settings/AccountSettings';
import { TemplateSettings } from './settings/TemplateSettings';
import { StorageSettings } from './settings/StorageSettings';
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
import { TimeCapsuleView } from './TimeCapsule';

const featureTabs = [
  { id: 'cleanup', label: 'Email Cleanup', icon: Sparkles },
  { id: 'time-capsule', label: 'Time Capsule', icon: Clock },
  { id: 'migration', label: 'Migration', icon: ArrowLeftRight },
  { id: 'backup', label: 'Backup & Restore', icon: Clock },
];

const settingsTabs = [
  { id: 'general', label: 'General', icon: Palette },
  { id: 'accounts', label: 'Accounts', icon: User },
  { id: 'templates', label: 'Templates', icon: FileText },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'billing', label: 'Billing', icon: CreditCard },
];

const systemTabs = [
  { id: 'daemon', label: 'Background Daemon', icon: Server },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'help', label: 'Help & Support', icon: Mail },
];

const allTabs = [...featureTabs, ...settingsTabs, ...systemTabs];
const featureTabIds = new Set(featureTabs.map(t => t.id));
// Tabs that show account pills and config sub-views
const accountPillTabIds = new Set(['cleanup', 'time-capsule']);

export function SettingsPage({ onClose, onAddAccount, onReportBug, initialTab, initialAccountId }) {
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

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
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-testid="settings-page"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-mail-bg border border-mail-border rounded-xl shadow-2xl
                   w-full max-w-7xl h-[92vh] flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar */}
        <div className="w-56 bg-mail-surface border-r border-mail-border flex flex-col">
          <div className="px-4 py-4 border-b border-mail-border flex items-center h-[57px]">
            <h2 className="text-lg font-semibold text-mail-text">Settings</h2>
          </div>

          <nav className="flex-1 p-2 overflow-y-auto">
            {[
              { label: 'Features', tabs: featureTabs },
              { label: 'Settings', tabs: settingsTabs },
              { label: 'System', tabs: systemTabs },
            ].map((section, i) => (
              <React.Fragment key={section.label}>
                {i > 0 && <div className="mx-3 my-2 border-t border-mail-border" />}
                <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-mail-text-muted uppercase tracking-wider">{section.label}</p>
                {section.tabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => handleTabChange(tab.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg
                               text-left transition-colors mb-0.5
                               ${activeTab === tab.id
                                 ? 'bg-mail-accent/10 text-mail-accent'
                                 : 'text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'}`}
                  >
                    <tab.icon size={18} />
                    <span className="text-sm font-medium">{tab.label}</span>
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
                <button
                  onClick={() => setSubView(null)}
                  className="p-1.5 hover:bg-mail-surface-hover rounded-lg transition-colors"
                >
                  <ChevronLeft size={18} className="text-mail-text-muted" />
                </button>
              )}
              <h3 className="text-lg font-semibold text-mail-text truncate">
                {hasConfigSubView && subView === 'config'
                  ? `${currentTab?.label} Settings`
                  : currentTab?.label}
              </h3>
            </div>
            <div className="flex items-center gap-2">
              {hasConfigSubView && subView !== 'config' && (
                <button
                  onClick={() => setSubView('config')}
                  className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
                  title="Settings"
                >
                  <Settings size={18} className="text-mail-text-muted" />
                </button>
              )}
              <button
                onClick={onClose}
                className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
              >
                <X size={20} className="text-mail-text-muted" />
              </button>
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
                      ? 'bg-mail-accent text-white border-mail-accent'
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
                : <CleanupView accountId={selectedFeatureAccountId} onDetailChange={setFeatureDetailActive} />
            )}

            {activeTab === 'time-capsule' && (
              subView === 'config'
                ? <TimeCapsuleSettings />
                : <TimeCapsuleView accountId={selectedFeatureAccountId} onDetailChange={setFeatureDetailActive} />
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
              <BillingSettings />
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
      </motion.div>
    </motion.div>
  );
}
