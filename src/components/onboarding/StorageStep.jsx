import React from 'react';
import { ArrowRight, Download, ShieldCheck } from 'lucide-react';
import { Button } from '../ui/Button';
import MailStorageLocation from '../settings/MailStorageLocation';
import BackupLocationPicker from '../settings/BackupLocationPicker';
import { DownloadModeControl } from '../settings/DownloadModeControl';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
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
 * gets only the backup and download mode rows.
 */
export function StorageStep({ onContinue }) {
  const t = useT();
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
          <MailStorageLocation title={t('onboarding.storageMailTitle')} description={t('onboarding.storageMailHint')} />
        </div>
      )}

      <section data-testid="storage-row-backup" className={card}>
        <h4 className={heading}>
          <ShieldCheck size={18} className="text-mail-accent-text" />
          {t('onboarding.storageBackupTitle')}
        </h4>
        <p className="text-xs text-mail-text-muted">{t('onboarding.storageBackupHint')}</p>
        <BackupLocationPicker />
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
        <Button variant="primary" size="lg" onClick={onContinue} data-testid="onboarding-continue">
          {t('common.continue')}
          <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}
