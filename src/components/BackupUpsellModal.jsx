import { useId } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useBackupStore } from '../stores/backupStore';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
import { useT } from '../i18n/index.js';

/**
 * Post-backup automation upsell. Shown once, right after a free user's first
 * successful manual backup (gated in backupScheduler._runBackup). Nudges toward
 * the paid automatic-backup trial without ever having surfaced automation as
 * a locked feature beforehand.
 */
export default function BackupUpsellModal({ onUpgrade }) {
  const t = useT();
  const upsell = useBackupStore((s) => s.backupUpsell);
  const clear = useBackupStore((s) => s.clearBackupUpsell);

  const titleId = useId();

  const count = upsell?.emailsBackedUp || 0;
  const startTrial = () => { clear(); onUpgrade?.(); };

  return (
    <Dialog
      open={Boolean(upsell)}
      onClose={clear}
      // Above a dialog: this lands on top of whatever settings surface the
      // backup was started from.
      z={Z.alert}
      portal
      size="md"
      aria-labelledby={titleId}
      panelBg="bg-mail-surface"
      panelClassName="text-center"
    >
        <div className="flex justify-center mb-3">
          <CheckCircle2 size={40} className="text-mail-success" />
        </div>

        <h2 id={titleId} className="text-lg font-semibold text-mail-text mb-1">
          {t('backup.upsell.backupCompleteTheseEmailsVault')}
        </h2>
        {count > 0 && (
          <p className="text-sm text-mail-text mb-1">
            {count.toLocaleString()} emails backed up.
          </p>
        )}
        <p className="text-sm text-mail-text-muted mb-5">
          {t('backup.upsell.wantHappenAutomaticallyEveryDay')}
        </p>

        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" onClick={startTrial} fullWidth>
            {t('backup.upsell.start14DayFreeTrial')}
          </Button>
          <Button variant="ghost" size="sm" onClick={clear} fullWidth data-autofocus>
            {t('backup.upsell.maybeLater')}
          </Button>
        </div>
    </Dialog>
  );
}
