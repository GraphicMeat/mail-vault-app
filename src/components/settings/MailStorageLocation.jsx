import { Button } from '../ui/Button';
import React, { useState, useEffect } from 'react';
import { AlertCircle, FolderOpen, HardDrive, Loader } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import * as api from '../../services/api';

/**
 * Where the working copy of the mail lives. Default is the app's own storage;
 * the user can move it to any folder on any drive.
 *
 * Distinct from the external backup below: this is the copy the app reads and
 * writes, so exactly one of them is live at a time.
 */
export default function MailStorageLocation() {
  const vaultStatus = useSettingsStore(s => s.vaultStatus);
  const setVaultStatus = useSettingsStore(s => s.setVaultStatus);
  const [busy, setBusy] = useState(null); // 'move' | 'adopt' | 'reset' | null
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    api.vaultGetStatus().then(setVaultStatus).catch(() => {});
    let unlisten;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('vault-move-progress', e => setProgress(e.payload));
      } catch { /* web dev mode */ }
    })();
    return () => { if (unlisten) unlisten(); };
  }, [setVaultStatus]);

  const pickFolder = async (title) => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    return open({ directory: true, title });
  };

  const handleMove = async () => {
    setError(''); setNotice('');
    try {
      const selected = await pickFolder('Choose where to store your mail');
      if (!selected) return;

      const info = await api.vaultInspectFolder(selected);
      if (!info.writable) {
        setError('MailVault cannot write to that folder. Pick another, or check the drive is not read-only.');
        return;
      }
      if (info.kind === 'other_vault' || info.kind === 'unmarked_mail') {
        setError('That folder already contains mail. Use "Use existing folder" to switch to it instead of moving into it.');
        return;
      }

      setBusy('move');
      setProgress({ phase: 'copying', copied: 0, total: 0, currentDir: '' });
      const result = await api.vaultMoveTo(selected);
      setVaultStatus(await api.vaultGetStatus());
      setNotice(
        result.sourceRemoved
          ? `Moved ${result.filesCopied.toLocaleString()} files. The old copy has been removed.`
          : `Copied ${result.filesCopied.toLocaleString()} files. Some of the old files could not be deleted — remove them by hand once you have checked the new folder.`
      );
    } catch (e) {
      setError(typeof e === 'string' ? e : e.message || 'Move failed');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const handleAdopt = async () => {
    setError(''); setNotice('');
    try {
      const selected = await pickFolder('Select the folder that holds your mail');
      if (!selected) return;
      setBusy('adopt');
      setVaultStatus(await api.vaultAdopt(selected));
      setNotice('Now reading mail from that folder.');
    } catch (e) {
      setError(typeof e === 'string' ? e : e.message || 'Could not use that folder');
    } finally {
      setBusy(null);
    }
  };

  // Two ways back to the default location: bring the mail along, or leave it
  // in the custom folder and start reading whatever the app's own storage holds.
  const handleReset = async (moveBack) => {
    setError(''); setNotice(''); setConfirmReset(false);
    setBusy('reset');
    if (moveBack) setProgress({ phase: 'copying', copied: 0, total: 0, currentDir: '' });
    try {
      if (moveBack) {
        const result = await api.vaultMoveToDefault();
        setVaultStatus(await api.vaultGetStatus());
        setNotice(
          result.sourceRemoved
            ? `Moved ${result.filesCopied.toLocaleString()} files back to the default location. The copy in the old folder has been removed.`
            : `Copied ${result.filesCopied.toLocaleString()} files back to the default location. Some of the old files could not be deleted — remove them by hand once you have checked.`
        );
      } else {
        setVaultStatus(await api.vaultReset());
        setNotice('Back to the default storage location. Mail already moved to the other folder stays there.');
      }
    } catch (e) {
      setError(typeof e === 'string' ? e : e.message || 'Reset failed');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const isCustom = !!vaultStatus?.isCustom;
  const missing = vaultStatus?.status === 'missing';
  const pct = progress?.total ? Math.min(100, Math.round((progress.copied / progress.total) * 100)) : 0;

  return (
    <div className="bg-mail-surface border border-mail-border rounded-xl p-5 space-y-4">
      <h4 className="font-semibold text-mail-text flex items-center gap-2">
        <HardDrive size={18} className="text-mail-accent-text" />
        Where your mail is stored
      </h4>

      <p className="text-xs text-mail-text-muted">
        This is the working copy — the mail MailVault reads, searches and syncs. By default it lives in
        the app's own storage. Move it to an external drive or any folder you prefer, and everything
        follows: messages, headers and attachments.
      </p>

      <div className="flex items-center gap-2">
        <div className="flex-1 text-xs text-mail-text font-mono bg-mail-bg rounded-lg px-3 py-2 truncate border border-mail-border">
          {vaultStatus?.displayPath || 'Loading...'}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${
          missing ? 'bg-mail-danger-tint text-mail-danger'
            : isCustom ? 'bg-mail-accent-tint text-mail-accent-text'
            : 'bg-mail-bg text-mail-text-muted'
        }`}>
          {missing ? 'Not found' : isCustom ? 'Custom folder' : 'Default'}
        </span>
      </div>

      {(busy === 'move' || (busy === 'reset' && progress)) && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-mail-text-muted">
            <span>
              {progress?.phase === 'verifying' ? 'Verifying every file arrived…'
                : progress?.phase === 'cleaning' ? 'Removing the old copy…'
                : `Copying ${progress?.currentDir || ''}…`}
            </span>
            <span>{progress?.total ? `${progress.copied.toLocaleString()} / ${progress.total.toLocaleString()}` : ''}</span>
          </div>
          <div className="h-1.5 bg-mail-bg rounded-full overflow-hidden">
            <div className="h-full bg-mail-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-mail-text-muted">
            Nothing is deleted until every file has been copied and checked.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleMove}
          disabled={busy !== null}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-mail-border text-mail-text hover:bg-mail-surface-hover disabled:opacity-50 transition-colors"
        >
          {busy === 'move' ? <Loader size={13} className="animate-spin" /> : <FolderOpen size={13} />}
          Move mail to another folder
        </button>
        <button
          onClick={handleAdopt}
          disabled={busy !== null}
          className="text-xs font-medium px-3 py-2 rounded-lg border border-mail-border text-mail-text hover:bg-mail-surface-hover disabled:opacity-50 transition-colors"
          title="Point MailVault at a folder that already holds your mail"
        >
          Use existing folder
        </button>
        {isCustom && (
          <button
            onClick={() => (missing ? handleReset(false) : setConfirmReset(true))}
            disabled={busy !== null}
            className="text-xs text-mail-text-muted hover:text-mail-text px-2 py-2 disabled:opacity-50"
            title="Go back to storing mail in the app's own storage"
          >
            Reset to default
          </button>
        )}
      </div>

      {confirmReset && (
        <div className="bg-mail-bg border border-mail-border rounded-lg p-3 space-y-2">
          <p className="text-xs text-mail-text">
            Bring your mail back to the default location, or leave it in the current folder?
          </p>
          <p className="text-xs text-mail-text-muted">
            Leaving it there means MailVault reads whatever is in its own storage — usually nothing —
            and re-downloads your mail. The folder you leave behind is not touched.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={() => handleReset(true)}
              className="text-xs font-medium px-3 py-2 rounded-lg bg-mail-accent-fill text-white hover:opacity-90"
            >
              Move mail back
            </button>
            <button
              onClick={() => handleReset(false)}
              className="text-xs font-medium px-3 py-2 rounded-lg border border-mail-border text-mail-text hover:bg-mail-surface-hover"
            >
              Leave it there
            </button>
            <Button variant="ghost" size="xs" className="text-xs py-2"
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {missing && (
        <div className="flex items-start gap-2 bg-mail-warning/10 border border-mail-warning/30 rounded-lg p-2">
          <AlertCircle size={14} className="text-mail-warning flex-shrink-0 mt-0.5" />
          <p className="text-xs text-mail-warning">
            {vaultStatus?.lastError || 'The folder is not available.'} Syncing stays paused until it is
            back or you pick the folder again — MailVault will not start a second copy in the app's storage.
          </p>
        </div>
      )}

      {error && <p className="text-xs text-mail-danger">{error}</p>}
      {notice && <p className="text-xs text-mail-success">{notice}</p>}
    </div>
  );
}
