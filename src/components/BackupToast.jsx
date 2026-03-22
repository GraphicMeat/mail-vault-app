import { motion, AnimatePresence } from 'framer-motion';
import { HardDrive, Loader2 } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore.js';

export function BackupToast({ showSettings, onOpenBackup }) {
  const activeBackup = useSettingsStore(s => s.activeBackup);

  if (!activeBackup || !activeBackup.active || showSettings) return null;

  const percent = activeBackup.totalFolders > 0
    ? Math.round((activeBackup.completedFolders / activeBackup.totalFolders) * 100)
    : 0;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.2 }}
        className="fixed bottom-6 left-6 z-[60] bg-mail-surface border border-mail-border rounded-xl shadow-lg p-2 w-72 cursor-pointer"
        onClick={onOpenBackup}
      >
        <div className="flex items-center gap-2">
          <HardDrive size={14} className="text-mail-accent flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <Loader2 size={12} className="text-mail-accent animate-spin flex-shrink-0" />
              <span className="text-xs font-semibold text-mail-text truncate">
                Backing up {activeBackup.accountEmail}
              </span>
            </div>
            <span className="text-[10px] text-mail-text-muted">
              {activeBackup.folder} {activeBackup.totalFolders > 0 && `(${activeBackup.completedFolders}/${activeBackup.totalFolders})`}
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
      </motion.div>
    </AnimatePresence>
  );
}
