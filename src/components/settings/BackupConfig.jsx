import { Button } from '../ui/Button';
import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  AlertCircle,
  Loader,
  HardDrive,
  Lock,
  RefreshCcw,
} from 'lucide-react';
import { IS_APPSTORE_BUILD, IAP_PRODUCT_BACKUPS } from '../../utils/buildFlags';
import MailStorageLocation from './MailStorageLocation';
import BackupLocationPicker from './BackupLocationPicker';
import { useBackupsEntitled } from '../../hooks/useBackupsEntitled';
import { t as tr, useT  } from '../../i18n/index.js';
import { T } from '../../i18n/T.jsx';

const selectClass = 'w-full px-4 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent';

export default function BackupConfig() {
  const t = useT();
  const backupScope = useSettingsStore(s => s.backupScope);
  const setBackupScope = useSettingsStore(s => s.setBackupScope);
  const setBackupCustomPath = useSettingsStore(s => s.setBackupCustomPath);
  const externalBackupLocation = useSettingsStore(s => s.externalBackupLocation);
  const setExternalBackupLocation = useSettingsStore(s => s.setExternalBackupLocation);

  const [entitled, setEntitled] = useBackupsEntitled();
  const [iapBusy, setIapBusy] = useState(null); // 'purchase' | 'restore' | null
  const [iapError, setIapError] = useState('');

  // Migrate a legacy raw backup path on mount. The default path, the saved
  // external location and its write check live in BackupLocationPicker.
  useEffect(() => {
    const inv = window.__TAURI__?.core?.invoke;
    if (!inv) return;
    const legacy = useSettingsStore.getState().backupCustomPath;
    if (legacy) {
      inv('backup_migrate_legacy_path', { legacyPath: legacy }).then(loc => {
        setExternalBackupLocation(loc);
        if (loc.status === 'ready') setBackupCustomPath(null);
      }).catch(() => {});
    }
  }, []);

  const handlePurchase = async () => {
    setIapBusy('purchase');
    setIapError('');
    try {
      const inv = window.__TAURI__?.core?.invoke;
      await inv('iap_purchase', { productId: IAP_PRODUCT_BACKUPS });
      setEntitled(true);
    } catch (e) {
      setIapError(typeof e === 'string' ? e : e?.message || 'Purchase failed');
    } finally {
      setIapBusy(null);
    }
  };

  const handleRestore = async () => {
    setIapBusy('restore');
    setIapError('');
    try {
      const inv = window.__TAURI__?.core?.invoke;
      await inv('iap_restore');
      const v = await inv('iap_is_entitled', { productId: IAP_PRODUCT_BACKUPS });
      setEntitled(!!v);
      if (!v) setIapError('No prior purchases found for this Apple ID.');
    } catch (e) {
      setIapError(typeof e === 'string' ? e : e?.message || 'Restore failed');
    } finally {
      setIapBusy(null);
    }
  };

  if (IS_APPSTORE_BUILD && !entitled) {
    return (
      <div className="space-y-6">
        <div className="bg-mail-surface border border-mail-border rounded-xl p-6 space-y-5">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-mail-accent/10 p-2.5">
              <Lock size={20} className="text-mail-accent-text" />
            </div>
            <div className="flex-1">
              <h4 className="font-semibold text-mail-text">{t('settings.backup.config.cloudBackupsOneTimePurchase')}</h4>
              <p className="text-sm text-mail-text-muted mt-1">
                {t('settings.backup.config.unlockExternalBackupFoldersKeep')}
              </p>
            </div>
          </div>

          <ul className="space-y-2 text-sm text-mail-text-muted pl-1">
            <li>• Save .eml files to any folder you choose</li>
            <li>• Incremental backups — new mail only</li>
            <li>• Works offline; no MailVault account required</li>
            <li>• One-time payment, no subscription</li>
          </ul>

          {iapError && (
            <div className="flex items-start gap-2 bg-mail-danger-tint border border-mail-danger/20 rounded-lg p-2.5">
              <AlertCircle size={14} className="text-mail-danger flex-shrink-0 mt-0.5" />
              <p className="text-xs text-mail-danger">{iapError}</p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handlePurchase}
              disabled={iapBusy !== null}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-mail-accent-fill hover:bg-mail-accent-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {iapBusy === 'purchase' ? <Loader size={16} className="animate-spin" /> : <Lock size={16} />}
              {iapBusy === 'purchase' ? tr('settings.backup.config.contactingAppStore') : tr('settings.backup.config.unlockCloudBackups')}
            </button>
            <button
              onClick={handleRestore}
              disabled={iapBusy !== null}
              className="flex items-center gap-1.5 px-3 py-2.5 text-sm text-mail-text-muted hover:text-mail-text bg-mail-bg border border-mail-border hover:bg-mail-surface-hover disabled:opacity-50 rounded-lg transition-colors"
              title={t('settings.backup.config.restorePriorPurchaseAppleId')}
            >
              {iapBusy === 'restore' ? <Loader size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
              {t('settings.backup.config.restore')}
            </button>
          </div>

          <p className="text-xs text-mail-text-muted">
            {t('settings.backup.config.alreadyPurchasedAnotherMacSigned')} <strong>{t('settings.backup.config.restore')}</strong>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Moving the store off the app container needs the sidecar daemon to hold
          its own security-scoped access — unverified under the App Store sandbox,
          so relocation is Developer ID / Linux only. Showing and opening the
          folder is safe everywhere, so MAS gets the read-only card. */}
      <MailStorageLocation readOnly={IS_APPSTORE_BUILD} />

      <div className="settings-section space-y-4">
        <h4 className="font-semibold text-mail-text flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          Backup Scope & Storage
        </h4>

        {/* Explanation */}
        <div className="bg-mail-bg rounded-lg p-3">
          <p className="text-xs text-mail-text-muted">
            {backupScope === 'archived'
              ? tr('settings.backup.config.onlyWhatAlreadyVaultGets')
              : tr('settings.backup.config.allEmailsSelectedFoldersMail')}
          </p>
          <p className="text-xs text-mail-text-muted mt-1">
            {t('settings.backup.config.backupsIncrementalOnlyNewEmails')}
          </p>
        </div>

        {/* Scope selector */}
        <div>
          <label className="text-xs text-mail-text-muted mb-1 block">{t('settings.backup.config.whatBackUp')}</label>
          <select aria-label={t('settings.backup.config.whatBackUp')}
            value={backupScope}
            onChange={(e) => setBackupScope(e.target.value)}
            className={selectClass}
          >
            <option value="archived">{t('settings.backup.config.archivedEmailsOnlyLocallySaved')}</option>
            <option value="all">{t('settings.backup.config.allEmailsDownloadFromServer')}</option>
          </select>
        </div>

        {/* External backup location */}
        <div>
          <label className="text-xs text-mail-text-muted mb-1 block">{t('settings.backup.config.secondCopyExternalColdStorage')}</label>
          <p className="text-xs text-mail-text-muted mb-2">
            <T k="settings.backup.config.workingCopyPlusExternalCopy"
               parts={[(s) => <strong>{s}</strong>]} />
          </p>
          <BackupLocationPicker />

          {externalBackupLocation?.status === 'ready' ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-mail-success">
                {t('settings.backup.config.secondCopyActivePlainEml')}
              </p>
              <p className="text-xs text-mail-text-muted">
                {t('settings.backup.config.structure')} <code className="text-mail-text">{externalBackupLocation.displayPath}/email@address/INBOX/cur/1234:2,S.eml</code>
              </p>
              <p className="text-xs text-mail-text-muted">
                {t('settings.backup.config.driveDisconnectedCatchesUp')}
              </p>
            </div>
          ) : !externalBackupLocation ? (
            <div className="mt-2 flex items-start gap-2 bg-mail-warning/10 border border-mail-warning/30 rounded-lg p-2">
              <AlertCircle size={14} className="text-mail-warning flex-shrink-0 mt-0.5" />
              <p className="text-xs text-mail-warning">
                {t('settings.backup.config.oneCopyOnlyChooseExternal')}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
