import React, { useCallback, useState } from 'react';
import { ArrowRight, Download, ShieldCheck } from 'lucide-react';
import { Button } from '../ui/Button';
import MailStorageLocation from '../settings/MailStorageLocation';
import BackupLocationPicker from '../settings/BackupLocationPicker';
import { DownloadModeControl } from '../settings/DownloadModeControl';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import { useBackupsEntitled } from '../../hooks/useBackupsEntitled';
import { useT } from '../../i18n/index.js';

/**
 * Where the mail goes, where its backup goes and how much of it stays on this
 * computer, asked before the first account so nothing is written to the
 * default location first.
 *
 * Each row is the control Settings uses, so a folder picked here gets the same
 * native access (security-scoped bookmark, real write test) and a mode picked
 * here is the same setting. Continue with nothing touched keeps the defaults.
 *
 * The Mac App Store build cannot relocate the vault (see BackupConfig), so it
 * gets only the backup and download mode rows, and without the backups
 * purchase its backup row only says where to unlock it (the shell refuses the
 * folder otherwise), the same gate Settings > Backup applies.
 */
export function StorageStep({ onContinue, onBusyChange }) {
  const t = useT();
  const [entitled] = useBackupsEntitled();
  // Continue waits for a vault move: leaving mid-copy would add the account
  // while the mail is between two folders.
  // The shell holds its Back and Skip tour on the same flag.
  const [moving, setMoving] = useState(false);
  // Stable: MailStorageLocation's effect lists it as a dependency.
  const busy = useCallback((value) => { setMoving(value); onBusyChange?.(value); }, [onBusyChange]);
  const card = 'settings-section space-y-3';
  const heading = 'font-semibold text-mail-text flex items-center gap-2';

  return (
    <div className="max-w-xl w-full space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-mail-text mb-1">{t('onboarding.storageTitle')}</h2>
        <p className="text-xs text-mail-text-muted">{t('onboarding.storageSubtitle')}</p>
      </div>

      {!IS_APPSTORE_BUILD && (
        <div data-testid="storage-row-mail">
          <MailStorageLocation title={t('onboarding.storageMailTitle')} description={t('onboarding.storageMailHint')} onBusyChange={busy} />
        </div>
      )}

      <section data-testid="storage-row-backup" className={card}>
        <h4 className={heading}>
          <ShieldCheck size={18} className="text-mail-accent-text" />
          {t('onboarding.storageBackupTitle')}
        </h4>
        <p className="text-xs text-mail-text-muted">{t('onboarding.storageBackupHint')}</p>
        {entitled ? <BackupLocationPicker /> : (
          <p data-testid="storage-backup-locked" className="text-xs text-mail-text">{t('onboarding.storageBackupLocked')}</p>
        )}
      </section>

      <section data-testid="storage-row-mode" className={card}>
        <h4 className={heading}>
          <Download size={18} className="text-mail-accent-text" />
          {t('settings.storage.downloadMode')}
        </h4>
        <p className="text-xs text-mail-text-muted">{t('onboarding.storageModeHint')}</p>
        {/* No upgrade button mid-tour: the upsell text still explains Hoarder,
            and Premium is two steps ahead. */}
        <DownloadModeControl />
      </section>

      <div className="flex justify-end">
        <Button variant="primary" size="lg" onClick={onContinue} disabled={moving} data-testid="onboarding-continue">
          {t('common.continue')}
          <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}
