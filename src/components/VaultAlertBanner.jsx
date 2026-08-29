import React, { useState, useEffect } from 'react';
import { AlertTriangle, FolderSearch, Loader } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import * as api from '../services/api';
import { useT } from '../i18n/index.js';

/**
 * Shown across the top of the main view when the mail storage folder cannot be
 * reached — an external drive was unplugged, or it came back mounted at a
 * different path. Syncing stops until a folder is picked, because writing into
 * the app data dir instead would silently start a second, divergent archive.
 */
export function VaultAlertBanner() {
  const t = useT();
  const vaultStatus = useSettingsStore(s => s.vaultStatus);
  const setVaultStatus = useSettingsStore(s => s.setVaultStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The app resolves storage at startup and re-emits it after every switch.
  useEffect(() => {
    let unlisten;
    api.vaultGetStatus().then(setVaultStatus).catch(() => {});
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('vault-status', e => setVaultStatus(e.payload));
      } catch { /* web dev mode — no Tauri events */ }
    })();
    return () => { if (unlisten) unlisten(); };
  }, [setVaultStatus]);

  if (!vaultStatus || vaultStatus.status !== 'missing') return null;

  const handleChoose = async () => {
    setBusy(true);
    setError('');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, title: 'Find your MailVault mail folder' });
      if (!selected) return;

      const info = await api.vaultInspectFolder(selected);
      if (info.kind === 'empty' || info.kind === 'occupied') {
        setError('No mail found in that folder. Pick the folder your mail was moved to — the one containing the "Maildir" folder.');
        return;
      }
      if (info.kind === 'other_vault') {
        setError('That folder holds a different MailVault store. Pick the folder belonging to this installation, or reset the storage location in Settings.');
        return;
      }
      setVaultStatus(await api.vaultAdopt(selected));
    } catch (e) {
      setError(typeof e === 'string' ? e : e.message || 'Could not open that folder');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-mail-warning/10 border-b border-mail-warning/30">
      <AlertTriangle size={16} className="text-mail-warning flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-mail-warning font-medium">
          {t('vaultAlert.mailStorageFolderNotFound')}
        </p>
        <p className="text-xs text-mail-text-muted mt-0.5 truncate">
          {vaultStatus.displayPath
            ? `MailVault stores your mail in ${vaultStatus.displayPath}, which is not available right now.`
            : 'The folder holding your mail is not available right now.'}
          {' '}Reconnect the drive, or point MailVault at the folder if it moved.
        </p>
        {error && <p className="text-xs text-mail-danger mt-1">{error}</p>}
      </div>
      <button
        onClick={handleChoose}
        disabled={busy}
        className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-mail-warning/20 text-mail-warning hover:bg-mail-warning/30 disabled:opacity-50 transition-colors whitespace-nowrap"
      >
        {busy ? <Loader size={13} className="animate-spin" /> : <FolderSearch size={13} />}
        Choose folder
      </button>
    </div>
  );
}
