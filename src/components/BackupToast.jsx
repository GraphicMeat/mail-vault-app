import { AnimatePresence } from 'framer-motion';
import { ToastShell } from './ui/ToastShell';
import { HardDrive, Loader2 } from 'lucide-react';
import { useBackupStore } from '../stores/backupStore.js';
import { decodeImapUtf7 } from '../utils/imapUtf7';

export function BackupToast({ showSettings, onOpenBackup }) {
  const activeBackup = useBackupStore(s => s.activeBackup);

  if (!activeBackup || !activeBackup.active || showSettings) return null;

  const percent = activeBackup.totalFolders > 0
    ? Math.round((activeBackup.completedFolders / activeBackup.totalFolders) * 100)
    : 0;

  return (
    <AnimatePresence>
      <ToastShell position="bottom-left" className="w-72 cursor-pointer" onClick={onOpenBackup}>
        <div className="flex items-center gap-2">
          <HardDrive size={14} className="text-mail-accent-text flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <Loader2 size={12} className="text-mail-accent-text animate-spin flex-shrink-0" />
              <span className="text-xs font-semibold text-mail-text truncate">
                Backing up {activeBackup.accountEmail}
              </span>
            </div>
            <span className="text-[10px] text-mail-text-muted">
              {decodeImapUtf7(activeBackup.folder)} {activeBackup.totalFolders > 0 && `(${activeBackup.completedFolders}/${activeBackup.totalFolders})`}
              {activeBackup.completedEmails > 0 && ` · ${activeBackup.completedEmails} emails`}
              {activeBackup.queueLength > 0 && ` · ${activeBackup.queueLength} more queued`}
            </span>
          </div>
        </div>
        {activeBackup.totalFolders > 0 && (
          <div className="h-1 rounded-full bg-mail-border mt-1.5 overflow-hidden">
            <div className="h-1 rounded-full bg-mail-accent transition-all" style={{ width: `${percent}%` }} />
          </div>
        )}
      </ToastShell>
    </AnimatePresence>
  );
}
