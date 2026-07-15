import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle2 } from 'lucide-react';
import { useBackupStore } from '../stores/backupStore';

/**
 * Post-backup automation upsell. Shown once, right after a free user's first
 * successful manual backup (gated in backupScheduler._runBackup). Nudges toward
 * the paid automatic-backup trial without ever having surfaced automation as
 * a locked feature beforehand.
 */
export default function BackupUpsellModal({ onUpgrade }) {
  const upsell = useBackupStore((s) => s.backupUpsell);
  const clear = useBackupStore((s) => s.clearBackupUpsell);

  // Escape dismisses (mirrors backdrop click). Only bound while open.
  useEffect(() => {
    if (!upsell) return;
    const onKey = (e) => { if (e.key === 'Escape') clear(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [upsell, clear]);

  if (!upsell) return null;

  const count = upsell.emailsBackedUp || 0;
  const startTrial = () => { clear(); onUpgrade?.(); };

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4"
      onClick={clear}
    >
      <div
        className="relative bg-mail-surface border border-mail-border w-[440px] max-w-[92vw] rounded-xl p-6 shadow-xl text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={clear}
          aria-label="Close"
          className="absolute top-3 right-3 text-mail-text-muted hover:text-mail-text"
        >
          <X size={18} />
        </button>

        <div className="flex justify-center mb-3">
          <CheckCircle2 size={40} className="text-mail-success" />
        </div>

        <h2 className="text-lg font-semibold text-mail-text mb-1">
          Backup complete — your emails are safe on this computer
        </h2>
        {count > 0 && (
          <p className="text-sm text-mail-text mb-1">
            {count.toLocaleString()} emails backed up.
          </p>
        )}
        <p className="text-sm text-mail-text-muted mb-5">
          Want this to happen automatically every day?
        </p>

        <div className="flex flex-col gap-2">
          <button
            onClick={startTrial}
            className="bg-mail-accent text-white rounded-lg px-4 py-2.5 text-sm font-semibold hover:bg-mail-accent-hover transition-colors"
          >
            Start 14-day free trial
          </button>
          <button
            onClick={clear}
            className="text-sm font-medium text-mail-text-muted hover:text-mail-text py-1.5"
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
