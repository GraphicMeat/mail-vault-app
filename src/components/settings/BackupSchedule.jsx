import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { useBackupStore } from '../../stores/backupStore';
import { useAccountStore } from '../../stores/accountStore';
import { backupScheduler } from '../../services/backupScheduler';
import { ToggleSwitch } from './ToggleSwitch';
import BackupAccountCard from './BackupAccountCard';
import {
  Clock,
  Loader,
  HardDrive,
} from 'lucide-react';

const selectClass = 'w-full px-4 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent';

export default function BackupSchedule({ initialAccountId, onUpgrade }) {
  const cardRefs = useRef({});
  const [highlightedId, setHighlightedId] = useState(null);

  const accounts = useAccountStore(s => s.accounts);
  const hiddenAccounts = useSettingsStore(s => s.hiddenAccounts);
  const getOrderedAccounts = useSettingsStore(s => s.getOrderedAccounts);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const isPaidUser = hasPremiumAccess(billingProfile);

  const backupGlobalEnabled = useSettingsStore(s => s.backupGlobalEnabled);
  const backupGlobalConfig = useSettingsStore(s => s.backupGlobalConfig);
  const setBackupGlobalEnabled = useSettingsStore(s => s.setBackupGlobalEnabled);
  const setBackupGlobalConfig = useSettingsStore(s => s.setBackupGlobalConfig);

  const activeBackup = useBackupStore(s => s.activeBackup);

  const visibleAccounts = getOrderedAccounts(accounts || []).filter(a => !hiddenAccounts?.[a.id]);

  // Scroll to and highlight the target account card
  useEffect(() => {
    if (!initialAccountId) return;
    const timer = setTimeout(() => {
      const el = cardRefs.current[initialAccountId];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedId(initialAccountId);
        setTimeout(() => setHighlightedId(null), 2000);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [initialAccountId]);

  return (
    <div className="space-y-6">
      {/* Automatic Backup */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="font-semibold text-mail-text flex items-center gap-2">
              <Clock size={18} className="text-mail-accent" />
              Automatic Backup
            </h4>
            <p className="text-xs text-mail-text-muted mt-0.5">
              Backups run automatically when the app is idle
            </p>
          </div>
          <ToggleSwitch active={backupGlobalEnabled} onClick={() => setBackupGlobalEnabled(!backupGlobalEnabled)} />
        </div>

        {backupGlobalEnabled && (
          <div className="space-y-3 pt-3 border-t border-mail-border">
            <div className="bg-mail-bg rounded-lg p-3">
              <p className="text-xs text-mail-text-muted">
                When you stop using the app for a few minutes, MailVault checks if any accounts need a backup and runs them one at a time in the background. No interruptions, no schedules to configure.
              </p>
            </div>
            <div>
              <label className="text-xs text-mail-text-muted mb-1 block">Backup frequency</label>
              <select
                value={backupGlobalConfig.interval}
                onChange={(e) => setBackupGlobalConfig({ interval: e.target.value })}
                className={selectClass}
              >
                <option value="hourly">Every hour (when idle)</option>
                <option value="daily">Once a day (when idle)</option>
                <option value="weekly">Once a week (when idle)</option>
              </select>
            </div>
          </div>
        )}

        {/* Back up all now button + live progress */}
        <div className={`${backupGlobalEnabled ? 'pt-3 border-t border-mail-border mt-3' : 'pt-3'} space-y-2`}>
          {activeBackup && activeBackup.active && (
            <div className="bg-mail-bg rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Loader size={14} className="text-mail-accent animate-spin flex-shrink-0" />
                <span className="text-xs font-semibold text-mail-text truncate">
                  Backing up {activeBackup.accountEmail}
                </span>
                {activeBackup.queueLength > 0 && (
                  <span className="text-xs text-mail-text-muted">+{activeBackup.queueLength} queued</span>
                )}
              </div>
              <div className="flex items-center justify-between text-xs text-mail-text-muted">
                <span>{activeBackup.folder || 'Starting...'} {activeBackup.totalFolders > 0 && `(${activeBackup.completedFolders}/${activeBackup.totalFolders})`}</span>
                <span>{activeBackup.completedEmails > 0 && `${activeBackup.completedEmails} emails`}</span>
              </div>
              {activeBackup.totalFolders > 0 && (
                <div className="h-1.5 rounded-full bg-mail-border overflow-hidden">
                  <div className="h-1.5 rounded-full bg-mail-accent transition-all" style={{ width: `${Math.round((activeBackup.completedFolders / activeBackup.totalFolders) * 100)}%` }} />
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => {
              console.log('[backup] Back up all clicked, queuing', visibleAccounts.length, 'accounts');
              for (const account of visibleAccounts) {
                backupScheduler.triggerManualBackup(account.id);
              }
            }}
            disabled={activeBackup?.active}
            className="w-full bg-mail-accent/10 text-mail-accent rounded-lg px-4 py-2.5 text-sm font-semibold hover:bg-mail-accent/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {activeBackup?.active ? (
              <>
                <Loader size={16} className="animate-spin" />
                Backup in progress...
              </>
            ) : (
              <>
                <HardDrive size={16} />
                Back up all accounts now
              </>
            )}
          </button>
        </div>
      </div>

      {/* Per-Account Cards */}
      {visibleAccounts.length > 0 ? (
        visibleAccounts.map(account => (
          <BackupAccountCard
            key={account.id}
            ref={el => { cardRefs.current[account.id] = el; }}
            account={account}
            isPaidUser={isPaidUser}
            globalEnabled={backupGlobalEnabled}
            highlighted={highlightedId === account.id}
            onUpgrade={onUpgrade}
          />
        ))
      ) : (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5 text-center">
          <h4 className="font-semibold text-mail-text mb-2">No accounts configured</h4>
          <p className="text-sm text-mail-text-muted">
            Add an email account first, then configure backup schedules.
          </p>
        </div>
      )}
    </div>
  );
}
