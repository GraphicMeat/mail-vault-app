import { Button } from '../ui/Button';
import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { ExternalLink, Loader } from 'lucide-react';
import * as api from '../../services/api';
import { t as tr, useT } from '../../i18n/index.js';

/**
 * The external backup folder: the path, Choose / Change / Reset, and whether
 * the folder is really usable. Settings > Backup and the onboarding storage
 * step both render this one, so a folder chosen in the tour goes through the
 * same native slot (`external_location.rs` bookmark + write test) as one
 * chosen in Settings; the frontend never stores a raw path as access.
 */
export default function BackupLocationPicker() {
  const t = useT();
  const setBackupCustomPath = useSettingsStore(s => s.setBackupCustomPath);
  const externalBackupLocation = useSettingsStore(s => s.externalBackupLocation);
  const setExternalBackupLocation = useSettingsStore(s => s.setExternalBackupLocation);

  const [defaultBackupPath, setDefaultBackupPath] = useState(null);
  const [pathLoading, setPathLoading] = useState(true);
  const [validatingExternal, setValidatingExternal] = useState(false);
  const [openError, setOpenError] = useState('');
  const [chooseError, setChooseError] = useState('');

  // Load the default backup path and the saved external location on mount.
  useEffect(() => {
    const inv = window.__TAURI__?.core?.invoke;
    if (!inv) { setPathLoading(false); return; }
    // The app's own Maildir follows the vault, which the user can move off the
    // app data dir — reading the data dir here would name a folder that is not
    // where the mail is.
    api.vaultGetStatus().then(s => setDefaultBackupPath(s?.displayPath || null)).catch(() => {}).finally(() => setPathLoading(false));
    api.backupGetExternalLocation().then(loc => {
      if (loc?.status !== 'not_configured') setExternalBackupLocation(loc);
    }).catch(() => {});
  }, []);

  // Re-check a configured location each time the picker mounts (Settings >
  // Backup opened, or the onboarding storage step shown).
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
    setChooseError('');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, title: tr('settings.backup.config.chooseExternalBackupDirectory') });
      if (!selected) return;
      const inv = window.__TAURI__?.core?.invoke;
      if (!inv) return;
      const saved = await inv('backup_save_external_location', { path: selected });
      setExternalBackupLocation(saved);
      setBackupCustomPath(null);
      // Saving only records the choice (and, on macOS, its bookmark). The write
      // test is what proves the folder is usable: a Snap-confined path or a
      // read-only drive saves fine and fails here. Skipped when saving already
      // said needs_reauth: no bookmark was stored, so validating would resolve
      // the previous folder's bookmark instead.
      if (saved?.status === 'ready') {
        setValidatingExternal(true);
        try {
          setExternalBackupLocation(await inv('backup_validate_external_location'));
        } catch (e) {
          // The write test never answered: do not leave save's optimistic
          // "ready" beside an error.
          setExternalBackupLocation({ ...saved, status: 'invalid', lastError: typeof e === 'string' ? e : e?.message || String(e) });
        } finally {
          setValidatingExternal(false);
        }
      }
    } catch (e) {
      console.error('Directory picker failed:', e);
      setChooseError(typeof e === 'string' ? e : e?.message || String(e));
    }
  };

  const handleClearExternal = async () => {
    try {
      const inv = window.__TAURI__?.core?.invoke;
      if (inv) await inv('backup_clear_external_location');
      setExternalBackupLocation(null);
      setBackupCustomPath(null);
      setChooseError('');
    } catch { /* ignore */ }
  };

  // What the path field is showing — the external copy when one is
  // configured, otherwise the app's own Maildir.
  const backupFolder = externalBackupLocation?.displayPath
    || (defaultBackupPath ? `${defaultBackupPath}/Maildir` : null);

  return (
    <div>
      <div className="flex items-center gap-2">
        <div data-testid="backup-path" className="flex-1 text-xs text-mail-text font-mono bg-mail-bg rounded-lg px-3 py-2 truncate border border-mail-border">
          {externalBackupLocation?.displayPath || (defaultBackupPath ? tr('settings.backup.config.maildirAppOnly', { defaultBackupPath }) : tr(pathLoading ? 'chat.bubble.loading' : 'settings.backup.config.unavailable'))}
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
      {chooseError && <p className="mt-1 text-xs text-mail-danger">{chooseError}</p>}

      {/* Error detail */}
      {externalBackupLocation?.lastError && externalBackupLocation.status !== 'ready' && !validatingExternal && (
        <p className="mt-1 text-xs text-mail-danger">{externalBackupLocation.lastError}</p>
      )}
    </div>
  );
}
