import { Button } from '../ui/Button';
import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  AlertCircle,
  ExternalLink,
  Loader,
  HardDrive,
  Lock,
  RefreshCcw,
} from 'lucide-react';
import { IS_APPSTORE_BUILD, IAP_PRODUCT_BACKUPS } from '../../utils/buildFlags';
import MailStorageLocation from './MailStorageLocation';
import * as api from '../../services/api';
import { t as tr, useT  } from '../../i18n/index.js';
import { T } from '../../i18n/T.jsx';

const selectClass = 'w-full px-4 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent';

export default function BackupConfig() {
  const t = useT();
  const backupScope = useSettingsStore(s => s.backupScope);
  const setBackupScope = useSettingsStore(s => s.setBackupScope);
  const backupCustomPath = useSettingsStore(s => s.backupCustomPath);
  const setBackupCustomPath = useSettingsStore(s => s.setBackupCustomPath);
  const externalBackupLocation = useSettingsStore(s => s.externalBackupLocation);
  const setExternalBackupLocation = useSettingsStore(s => s.setExternalBackupLocation);

  const [defaultBackupPath, setDefaultBackupPath] = useState(null);
  const [validatingExternal, setValidatingExternal] = useState(false);
  const [entitled, setEntitled] = useState(!IS_APPSTORE_BUILD);
  const [iapBusy, setIapBusy] = useState(null); // 'purchase' | 'restore' | null
  const [iapError, setIapError] = useState('');
  const [openError, setOpenError] = useState('');

  // Load default backup path, external location, and migrate legacy on mount
  useEffect(() => {
    const inv = window.__TAURI__?.core?.invoke;
    if (!inv) return;
    inv('get_app_data_dir').then(p => setDefaultBackupPath(p)).catch(() => {});
    inv('backup_get_external_location').then(loc => {
      if (loc?.status !== 'not_configured') setExternalBackupLocation(loc);
    }).catch(() => {});
    const legacy = useSettingsStore.getState().backupCustomPath;
    if (legacy) {
      inv('backup_migrate_legacy_path', { legacyPath: legacy }).then(loc => {
        setExternalBackupLocation(loc);
        if (loc.status === 'ready') setBackupCustomPath(null);
      }).catch(() => {});
    }
    // IAP entitlement check — MAS only. Non-MAS builds are always entitled.
    if (IS_APPSTORE_BUILD) {
      inv('iap_is_entitled', { productId: IAP_PRODUCT_BACKUPS })
        .then(v => setEntitled(!!v))
        .catch(() => setEntitled(false));
    }
  }, []);

  // Auto-verify external location on mount (every time user navigates to this tab)
  useEffect(() => {
    const inv = window.__TAURI__?.core?.invoke;
    if (!inv) return;
    // Only validate if a location is configured
    const loc = useSettingsStore.getState().externalBackupLocation;
    if (!loc) return;
    setValidatingExternal(true);
    inv('backup_validate_external_location').then(result => {
      setExternalBackupLocation(result);
    }).catch(() => {}).finally(() => {
      setValidatingExternal(false);
    });
  }, []);

  const handleChooseBackupDir = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, title: tr('settings.backup.config.chooseExternalBackupDirectory') });
      if (!selected) return;
      const inv = window.__TAURI__?.core?.invoke;
      if (inv) {
        const loc = await inv('backup_save_external_location', { path: selected });
        setExternalBackupLocation(loc);
        setBackupCustomPath(null);
      }
    } catch (e) {
      console.error('Directory picker failed:', e);
    }
  };

  const handleClearExternal = async () => {
    try {
      const inv = window.__TAURI__?.core?.invoke;
      if (inv) await inv('backup_clear_external_location');
      setExternalBackupLocation(null);
      setBackupCustomPath(null);
    } catch { /* ignore */ }
  };

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

  // What the path field above is showing — the external copy when one is
  // configured, otherwise the app's own Maildir.
  const backupFolder = externalBackupLocation?.displayPath
    || (defaultBackupPath ? `${defaultBackupPath}/Maildir` : null);

  return (
    <div className="space-y-6">
      {/* Moving the store off the app container needs the sidecar daemon to hold
          its own security-scoped access — unverified under the App Store sandbox,
          so relocation is Developer ID / Linux only. Showing and opening the
          folder is safe everywhere, so MAS gets the read-only card. */}
      <MailStorageLocation readOnly={IS_APPSTORE_BUILD} />

      <div className="bg-mail-surface border border-mail-border rounded-xl p-5 space-y-4">
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
          <select
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
          <div className="flex items-center gap-2">
            <div className="flex-1 text-xs text-mail-text font-mono bg-mail-bg rounded-lg px-3 py-2 truncate border border-mail-border">
              {externalBackupLocation?.displayPath || (defaultBackupPath ? tr('settings.backup.config.maildirAppOnly', { defaultBackupPath }) : tr('chat.bubble.loading'))}
            </div>
            {backupFolder && (
              <button
                onClick={() => { setOpenError(''); api.openPath(backupFolder).catch(e => setOpenError(String(e?.message || e))); }}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-mail-border text-mail-text hover:bg-mail-surface-hover transition-colors whitespace-nowrap"
                title={backupFolder}
              >
                <ExternalLink size={13} />
                {t('common.openFolder')}
              </button>
            )}
            <button
              onClick={handleChooseBackupDir}
              className="text-xs font-medium px-3 py-2 rounded-lg border border-mail-border text-mail-text hover:bg-mail-surface-hover transition-colors whitespace-nowrap"
            >
              {externalBackupLocation ? tr('settings.backup.config.change') : tr('settings.backup.config.chooseFolder')}
            </button>
            {externalBackupLocation && (
              <Button variant="ghost" size="xs" className="text-xs py-2"
                onClick={handleClearExternal}
                title={t('settings.backup.config.removeExternalBackupLocation')}
              >
                {t('common.reset')}
              </Button>
            )}
          </div>

          {/* Status badge */}
          {externalBackupLocation && (
            <div className="mt-2 flex items-center gap-2">
              {validatingExternal ? (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-mail-surface text-mail-text-muted">
                  <Loader size={10} className="animate-spin" />
                  {t('settings.backup.config.verifying')}
                </span>
              ) : (
                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                  externalBackupLocation.status === 'ready' ? 'bg-mail-success-tint text-mail-success'
                  : externalBackupLocation.status === 'needs_reauth' ? 'bg-mail-warning-tint text-mail-warning'
                  : 'bg-mail-danger-tint text-mail-danger'
                }`}>
                  {externalBackupLocation.status === 'ready' ? tr('settings.backup.config.ready')
                    : externalBackupLocation.status === 'needs_reauth' ? tr('settings.backup.config.needsReauthorization')
                    : externalBackupLocation.status === 'unavailable' ? tr('settings.backup.config.unavailable')
                    : externalBackupLocation.status === 'invalid' ? tr('settings.backup.config.accessDenied')
                    : externalBackupLocation.status}
                </span>
              )}
              {!validatingExternal && externalBackupLocation.status === 'needs_reauth' && (
                <Button variant="link" size="xs" className="p-0 text-xs"
                  onClick={handleChooseBackupDir}
                >
                  {t('settings.backup.config.reauthorize')}
                </Button>
              )}
            </div>
          )}

          {openError && <p className="mt-1 text-xs text-mail-danger">{openError}</p>}

          {/* Error detail */}
          {externalBackupLocation?.lastError && externalBackupLocation.status !== 'ready' && !validatingExternal && (
            <p className="mt-1 text-xs text-mail-danger">{externalBackupLocation.lastError}</p>
          )}

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
