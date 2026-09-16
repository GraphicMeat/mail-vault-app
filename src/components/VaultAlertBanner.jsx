import React, { useState, useEffect } from 'react';
import { AlertTriangle, FolderSearch, Loader } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import * as api from '../services/api';
import { t, useT  } from '../i18n/index.js';

/**
 * Shown across the top of the main view when the mail storage folder cannot be
 * reached — an external drive was unplugged, or it came back mounted at a
 * different path. Syncing stops until a folder is picked, because writing into
 * the app data dir instead would silently start a second, divergent archive.
 *
 * It carries a second, independent warning: the custody store would not open.
 * Nothing in the app deletes or rebuilds that file, so this is the only place
 * the user learns of it, and it offers no button because the repair is theirs.
 */
export function VaultAlertBanner() {
  const t = useT();
  const vaultStatus = useSettingsStore(s => s.vaultStatus);
  const setVaultStatus = useSettingsStore(s => s.setVaultStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [custody, setCustody] = useState(null);

  // The app resolves storage at startup and re-emits it after every switch.
  // The custody store's startup emit lands before this webview exists, so the
  // command is the only way to learn the current state; the event covers the
  // later re-opens after a vault switch.
  //
  // Since Task 2.9b the store opens in the DAEMON, which emits `custody-status`
  // as it starts — before the app's event channel has reconnected to it, and
  // the bus drops an event nobody is subscribed to. A vault switch restarts the
  // daemon, so that first emit is exactly the one that would report a store
  // that will not open on the new root. `daemon-reconnected` is the signal that
  // the channel is back; re-ask then (spec deviation 9).
  useEffect(() => {
    let unlisten;
    let unlistenCustody;
    let unlistenReconnect;
    const askCustody = () => api.custodyStatus().then(setCustody).catch(() => {});
    api.vaultGetStatus().then(setVaultStatus).catch(() => {});
    askCustody();
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('vault-status', e => setVaultStatus(e.payload));
        unlistenCustody = await listen('custody-status', e => setCustody(e.payload));
        unlistenReconnect = await listen('daemon-reconnected', askCustody);
      } catch { /* web dev mode — no Tauri events */ }
    })();
    return () => {
      if (unlisten) unlisten();
      if (unlistenCustody) unlistenCustody();
      if (unlistenReconnect) unlistenReconnect();
    };
  }, [setVaultStatus]);

  const missing = !!vaultStatus && vaultStatus.status === 'missing';
  // An open failure, not merely closed: `close()` during a vault switch leaves
  // available:false with no error and emits nothing, and there is nothing to
  // tell the user about a store that is between roots.
  const custodyDown = !!custody && custody.available === false && !!custody.error;
  if (!missing && !custodyDown) return null;

  const handleChoose = async () => {
    setBusy(true);
    setError('');
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, title: t('vaultAlert.findMailvaultMailFolder') });
      if (!selected) return;

      const info = await api.vaultInspectFolder(selected);
      if (info.kind === 'empty' || info.kind === 'occupied') {
        setError(t('vaultAlert.noMailFoundFolderPick'));
        return;
      }
      if (info.kind === 'other_vault') {
        setError(t('vaultAlert.folderHoldsDifferentMailvaultStore'));
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
    <>
      {missing && (
        <div className="flex items-start gap-3 px-4 py-3 bg-mail-warning/10 border-b border-mail-warning/30">
          <AlertTriangle size={16} className="text-mail-warning flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-mail-warning font-medium">
              {t('vaultAlert.mailStorageFolderNotFound')}
            </p>
            <p className="text-xs text-mail-text-muted mt-0.5 truncate">
              {vaultStatus.displayPath
                ? t('vaultAlert.mailvaultStoresMailWhichAvailable', { vaultStatus: vaultStatus.displayPath })
                : t('vaultAlert.folderHoldingMailAvailableRight')}
              {' '}{t('vaultAlert.reconnectDriveOrPointAtFolder')}
            </p>
            {error && <p className="text-xs text-mail-danger mt-1">{error}</p>}
          </div>
          <button
            onClick={handleChoose}
            disabled={busy}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-mail-warning/20 text-mail-warning hover:bg-mail-warning/30 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {busy ? <Loader size={13} className="animate-spin" /> : <FolderSearch size={13} />}
            {t('vaultAlert.chooseFolder')}
          </button>
        </div>
      )}
      {custodyDown && (
        <div className="flex items-start gap-3 px-4 py-3 bg-mail-danger/10 border-b border-mail-danger/30">
          <AlertTriangle size={16} className="text-mail-danger flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-mail-danger font-medium">{t('vaultAlert.custodyUnreadable')}</p>
            {/* The sentence names the file, so it is dropped whole when there
                is no file to name (no vault root), leaving the reason alone. */}
            <p className="text-xs text-mail-text-muted mt-0.5">
              {custody.path
                ? `${t('vaultAlert.custodyUnreadableDetail', { path: custody.path })} (${custody.error})`
                : custody.error}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
