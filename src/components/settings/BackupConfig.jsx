import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  AlertCircle,
  Loader,
  HardDrive,
} from 'lucide-react';

const selectClass = 'w-full px-4 py-2 text-sm bg-mail-surface border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent';

export default function BackupConfig() {
  const backupScope = useSettingsStore(s => s.backupScope);
  const setBackupScope = useSettingsStore(s => s.setBackupScope);
  const backupCustomPath = useSettingsStore(s => s.backupCustomPath);
  const setBackupCustomPath = useSettingsStore(s => s.setBackupCustomPath);
  const externalBackupLocation = useSettingsStore(s => s.externalBackupLocation);
  const setExternalBackupLocation = useSettingsStore(s => s.setExternalBackupLocation);

  const [defaultBackupPath, setDefaultBackupPath] = useState(null);
  const [validatingExternal, setValidatingExternal] = useState(false);

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
      const selected = await open({ directory: true, title: 'Choose external backup directory' });
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

  return (
    <div className="space-y-6">
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5 space-y-4">
        <h4 className="font-semibold text-mail-text flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent" />
          Backup Scope & Storage
        </h4>

        {/* Explanation */}
        <div className="bg-mail-bg rounded-lg p-3">
          <p className="text-xs text-mail-text-muted">
            {backupScope === 'archived'
              ? 'Only emails you have explicitly archived (saved locally) will be backed up. To include all server emails, switch to "All emails" below.'
              : 'All emails from selected folders on the mail server will be downloaded and backed up locally. This may use significant disk space.'}
          </p>
          <p className="text-xs text-mail-text-muted mt-1">
            Backups are incremental — only new emails since the last backup are downloaded. Existing backups are never re-downloaded.
          </p>
        </div>

        {/* Scope selector */}
        <div>
          <label className="text-xs text-mail-text-muted mb-1 block">What to back up</label>
          <select
            value={backupScope}
            onChange={(e) => setBackupScope(e.target.value)}
            className={selectClass}
          >
            <option value="archived">Archived emails only (locally saved)</option>
            <option value="all">All emails (download from server)</option>
          </select>
        </div>

        {/* External backup location */}
        <div>
          <label className="text-xs text-mail-text-muted mb-1 block">External backup location</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 text-xs text-mail-text font-mono bg-mail-bg rounded-lg px-3 py-2 truncate border border-mail-border">
              {externalBackupLocation?.displayPath || (defaultBackupPath ? `${defaultBackupPath}/Maildir (app only)` : 'Loading...')}
            </div>
            <button
              onClick={handleChooseBackupDir}
              className="text-xs font-medium px-3 py-2 rounded-lg border border-mail-border text-mail-text hover:bg-mail-surface-hover transition-colors whitespace-nowrap"
            >
              {externalBackupLocation ? 'Change' : 'Choose Folder'}
            </button>
            {externalBackupLocation && (
              <button
                onClick={handleClearExternal}
                className="text-xs text-mail-text-muted hover:text-mail-text px-2 py-2"
                title="Remove external backup location"
              >
                Reset
              </button>
            )}
          </div>

          {/* Status badge */}
          {externalBackupLocation && (
            <div className="mt-2 flex items-center gap-2">
              {validatingExternal ? (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-mail-surface text-mail-text-muted">
                  <Loader size={10} className="animate-spin" />
                  Verifying...
                </span>
              ) : (
                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                  externalBackupLocation.status === 'ready' ? 'bg-emerald-500/10 text-emerald-500'
                  : externalBackupLocation.status === 'needs_reauth' ? 'bg-amber-500/10 text-amber-500'
                  : 'bg-red-500/10 text-red-500'
                }`}>
                  {externalBackupLocation.status === 'ready' ? 'Ready'
                    : externalBackupLocation.status === 'needs_reauth' ? 'Needs reauthorization'
                    : externalBackupLocation.status === 'unavailable' ? 'Unavailable'
                    : externalBackupLocation.status === 'invalid' ? 'Access denied'
                    : externalBackupLocation.status}
                </span>
              )}
              {!validatingExternal && externalBackupLocation.status === 'needs_reauth' && (
                <button
                  onClick={handleChooseBackupDir}
                  className="text-xs text-mail-accent hover:text-mail-accent-hover"
                >
                  Reauthorize
                </button>
              )}
            </div>
          )}

          {/* Error detail */}
          {externalBackupLocation?.lastError && externalBackupLocation.status !== 'ready' && !validatingExternal && (
            <p className="mt-1 text-xs text-mail-danger">{externalBackupLocation.lastError}</p>
          )}

          {externalBackupLocation?.status === 'ready' ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-mail-success">
                Emails are saved as .eml files during each backup, organized by account and folder. Safe from app uninstalls.
              </p>
              <p className="text-xs text-mail-text-muted">
                Structure: <code className="text-mail-text">{externalBackupLocation.displayPath}/email@address/INBOX/cur/1234.eml</code>
              </p>
            </div>
          ) : !externalBackupLocation ? (
            <div className="mt-2 flex items-start gap-2 bg-mail-warning/10 border border-mail-warning/30 rounded-lg p-2">
              <AlertCircle size={14} className="text-mail-warning flex-shrink-0 mt-0.5" />
              <p className="text-xs text-mail-warning">
                Backups are only stored inside the app's data folder. If you uninstall MailVault or clear app data, your backups will be lost. Choose an external folder to keep a safe copy.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
