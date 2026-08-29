import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader, Check, AlertTriangle, UploadCloud, X } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore.js';
import { decodeImapUtf7 } from '../utils/imapUtf7';
import { useT } from '../i18n/index.js';

// Corner bubble for a minimized change-server restore. Mirrors the OutboxTray
// bubble style: shows live upload progress while the restore runs in the
// background; clicking the bubble reopens the Change Server modal on step 2.
export function RestoreTray() {
  const t = useT();
  const activeRestore = useSettingsStore((s) => s.activeRestore);
  const changeServerAccountId = useSettingsStore((s) => s.changeServerAccountId);
  const openChangeServer = useSettingsStore((s) => s.openChangeServer);
  const clearActiveRestore = useSettingsStore((s) => s.clearActiveRestore);

  // Only visible while minimized (modal closed) with a restore to show.
  if (!activeRestore || changeServerAccountId) return null;

  const running = activeRestore.status === 'running';
  const completed = activeRestore.status === 'completed';
  const failed = activeRestore.status === 'failed' || activeRestore.status === 'cancelled';

  return (
    <div className="fixed bottom-6 left-4 z-[60]">
      <AnimatePresence>
        <motion.div
          key="restore-bubble"
          initial={{ y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 30, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className={`flex items-start gap-3 px-4 py-3 rounded-xl min-w-[280px] max-w-[380px] border cursor-pointer
                     ${failed ? 'bg-mail-danger-tint border-mail-danger/40' : 'bg-mail-surface border-mail-strong'}`}
          onClick={() => openChangeServer(activeRestore.account_id)}
          data-testid={`restore-bubble-${activeRestore.status}`}
        >
          <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0
                          ${failed ? 'bg-mail-danger-tint' : completed ? 'bg-mail-success-tint' : 'bg-mail-accent/20'}`}>
            {running && <Loader size={14} className="text-mail-accent-text animate-spin" />}
            {completed && <Check size={14} className="text-mail-success" />}
            {failed && <AlertTriangle size={14} className="text-mail-danger" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-mail-text truncate flex items-center gap-1.5">
              <UploadCloud size={12} className="flex-shrink-0" /> Restore — {activeRestore.email}
            </p>
            <p className="text-[11px] mt-0.5 text-mail-text-muted truncate">
              {running && (
                <>
                  {activeRestore.uploaded_emails} uploaded
                  {activeRestore.current_folder ? ` · ${decodeImapUtf7(activeRestore.current_folder)}` : ''}
                  {activeRestore.folder_progress ? ` · ${activeRestore.folder_progress}` : ''}
                </>
              )}
              {completed && `Complete — ${activeRestore.uploaded_emails} uploaded · ${activeRestore.skipped_emails} skipped`}
              {activeRestore.status === 'cancelled' && 'Cancelled'}
              {activeRestore.status === 'failed' && `Failed — ${activeRestore.uploaded_emails} uploaded`}
            </p>
          </div>
          {!running && (
            <button
              onClick={(e) => { e.stopPropagation(); clearActiveRestore(); }}
              className="text-mail-text-muted hover:text-mail-text flex-shrink-0"
              aria-label={t('restore.tray.dismiss')}
            >
              <X size={14} />
            </button>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
