import React, { useState, useEffect } from 'react';
import { useMailStore } from '../stores/mailStore';
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

export function SettingsPage({ onClose, onAddAccount, onReportBug, initialTab }) {
  const { accounts } = useMailStore();

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const [activeTab, setActiveTab] = useState(initialTab || 'general');

  const tabs = [
    { id: 'general', label: 'General', icon: Palette },
    { id: 'accounts', label: 'Accounts', icon: User },
    { id: 'templates', label: 'Templates', icon: FileText },
    { id: 'storage', label: 'Storage', icon: HardDrive },
    { id: 'backup', label: 'Backup', icon: Clock },
    { id: 'migration', label: 'Migration', icon: ArrowLeftRight },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'logs', label: 'Logs', icon: ScrollText },
    { id: 'help', label: 'Help & Support', icon: Mail },
  ];

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

          <nav className="flex-1 p-2">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg
                           text-left transition-colors mb-1
                           ${activeTab === tab.id
                             ? 'bg-mail-accent/10 text-mail-accent'
                             : 'text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'}`}
              >
                <tab.icon size={18} />
                <span className="text-sm font-medium">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-mail-border h-[57px]">
            <h3 className="text-lg font-semibold text-mail-text">
              {tabs.find(t => t.id === activeTab)?.label}
            </h3>
            <button
              onClick={onClose}
              className="p-2 hover:bg-mail-surface-hover rounded-lg transition-colors"
            >
              <X size={20} className="text-mail-text-muted" />
            </button>
          </div>

          {/* Content Area */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'general' && (
              <GeneralSettings accounts={accounts} />
            )}

            {activeTab === 'accounts' && (
              <AccountSettings accounts={accounts} onAddAccount={onAddAccount} />
            )}

            {activeTab === 'templates' && (
              <TemplateSettings />
            )}

            {activeTab === 'storage' && (
              <StorageSettings accounts={accounts} />
            )}

            {activeTab === 'backup' && (
              <BackupSettings />
            )}

            {activeTab === 'migration' && (
              <MigrationSettings />
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
