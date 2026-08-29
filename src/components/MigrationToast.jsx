import { Button } from './ui/Button';
import { useState, useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ToastShell } from './ui/ToastShell';
import { CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore.js';
import * as api from '../services/api.js';
import { useT } from '../i18n/index.js';

export function MigrationToast({ showSettings, onOpenSettings }) {
  const t = useT();
  const activeMigration = useSettingsStore(s => s.activeMigration);
  const incompleteMigration = useSettingsStore(s => s.incompleteMigration);
  const [dismissed, setDismissed] = useState(false);
  const [rateLimitCountdown, setRateLimitCountdown] = useState(null);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [removeError, setRemoveError] = useState(null);
  const [removing, setRemoving] = useState(false);

  // Auto-dismiss 10s after completion
  useEffect(() => {
    if (activeMigration?.status === 'completed') {
      const timer = setTimeout(() => setDismissed(true), 10000);
      return () => clearTimeout(timer);
    }
    setDismissed(false);
  }, [activeMigration?.status]);

  // Rate-limit countdown timer
  useEffect(() => {
    if (activeMigration?.rate_limit_remaining && activeMigration.rate_limit_remaining > 0) {
      setRateLimitCountdown(activeMigration.rate_limit_remaining);
    } else {
      setRateLimitCountdown(null);
    }
  }, [activeMigration?.rate_limit_remaining]);

  useEffect(() => {
    if (rateLimitCountdown && rateLimitCountdown > 0) {
      const timer = setTimeout(() => setRateLimitCountdown(rateLimitCountdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [rateLimitCountdown]);

  // Recovery state
  const isRecovery = !activeMigration && incompleteMigration && !showSettings;
  const isActive = activeMigration && !showSettings && !dismissed;
  const showToast = isRecovery || isActive;

  if (!showToast) return null;

  // Recovery toast content
  if (isRecovery) {
    const { migrated_emails, total_emails, folder_mappings, source_email, dest_email, source_transport, dest_transport } = incompleteMigration;
    const currentFolder = folder_mappings?.find(f => f.status !== 'completed')?.source_path || 'INBOX';

    // Resume calls resumeMigration() API directly per UI-SPEC contract
    const handleResume = async (e) => {
      e.stopPropagation();
      try {
        await api.resumeMigration(
          incompleteMigration.source_config || { email: source_email },
          incompleteMigration.dest_config || { email: dest_email },
          source_transport || 'imap',
          dest_transport || 'imap'
        );
        useSettingsStore.getState().clearIncompleteMigration();
      } catch (err) {
        // If resume fails (e.g., missing credentials), fall back to opening Settings
        console.warn('Direct resume failed, opening Settings:', err);
        onOpenSettings();
      }
    };

    const handleDiscard = (e) => {
      e.stopPropagation();
      setShowDiscardDialog(true);
      setRemoveError(null);
    };

    const handleDiscardKeep = async (e) => {
      e.stopPropagation();
      await api.clearMigrationState();
      useSettingsStore.getState().clearIncompleteMigration();
      setShowDiscardDialog(false);
    };

    const handleDiscardRemove = async (e) => {
      e.stopPropagation();
      setRemoving(true);
      setRemoveError(null);
      try {
        await api.removeMigratedEmails(incompleteMigration);
        useSettingsStore.getState().clearIncompleteMigration();
        setShowDiscardDialog(false);
      } catch (err) {
        // Per CONTEXT.md: "If removal fails, keep the emails and show error (no data loss)"
        setRemoveError(err.message || 'Removal failed. Some emails may remain at the destination.');
        useSettingsStore.getState().clearIncompleteMigration();
      } finally {
        setRemoving(false);
      }
    };

    return (
      <AnimatePresence>
        <ToastShell position="bottom-right" className="w-72">
          {showDiscardDialog ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-mail-text">{t('migration.toast.discardIncompleteMigration')}</p>
              <p className="text-xs text-mail-text-muted">{t('migration.toast.chooseWhatDoEmailsAlready')}</p>
              <p className="text-xs text-mail-text-muted italic">{t('migration.toast.removalBestEffortIfConnection')}</p>
              {removeError && (
                <p className="text-xs text-mail-danger">{removeError}</p>
              )}
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="xs" className="text-xs" onClick={handleDiscardKeep}>{t('migration.toast.keepEmails')}</Button>
                <Button variant="danger" size="xs" className="text-xs" onClick={handleDiscardRemove} disabled={removing}>
                  {removing && <Loader2 size={10} className="animate-spin" />}
                  Remove emails
                </Button>
                <button onClick={(e) => { e.stopPropagation(); setShowDiscardDialog(false); }} className="text-xs text-mail-text-muted">{t('migration.toast.goBack')}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <AlertTriangle size={16} className="text-mail-warning flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-mail-text">{t('migration.toast.incompleteMigrationFound')}</p>
                  <p className="text-xs text-mail-text-muted">{currentFolder}: {migrated_emails}/{total_emails} emails migrated</p>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <Button variant="primary" size="xs" className="text-xs" onClick={handleResume}>{t('common.resume')}</Button>
                <Button variant="secondary" size="xs" className="text-xs" onClick={handleDiscard}>{t('common.discard')}</Button>
              </div>
            </>
          )}
        </ToastShell>
      </AnimatePresence>
    );
  }

  // Active migration toast
  const { migrated_emails, total_emails, current_folder, status } = activeMigration;
  const percent = Math.min(100, total_emails > 0 ? Math.round((migrated_emails / total_emails) * 100) : 0);

  return (
    <AnimatePresence>
      <ToastShell position="bottom-right" className="w-72 cursor-pointer" onClick={onOpenSettings}>
        {status === 'completed' ? (
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-mail-success flex-shrink-0" />
            <span className="text-sm font-semibold text-mail-text">{t('migration.toast.migrationComplete')}</span>
          </div>
        ) : status === 'paused' ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-mail-text">{t('migration.toast.paused')}</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1">
              {status === 'rate_limited' ? (
                <AlertTriangle size={14} className="text-mail-warning flex-shrink-0" />
              ) : (
                <Loader2 size={14} className="text-mail-accent-text animate-spin flex-shrink-0" />
              )}
              <span className="text-sm font-semibold text-mail-text truncate">
                {total_emails > 0
                  ? `Migrating ${current_folder || 'INBOX'} ${percent}% (${migrated_emails}/${total_emails})`
                  : `Migrating ${current_folder || 'INBOX'}... (${migrated_emails} emails)`}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-mail-border mt-2 overflow-hidden">
              <div className="h-1.5 rounded-full bg-mail-accent transition-all" style={{ width: `${percent}%` }} />
            </div>
            {rateLimitCountdown > 0 && (
              <p className="text-xs text-mail-warning font-semibold mt-1">Rate limited -- retrying in {rateLimitCountdown}s</p>
            )}
          </>
        )}
      </ToastShell>
    </AnimatePresence>
  );
}
