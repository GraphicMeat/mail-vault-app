import { useCallback, useId, useMemo } from 'react';
import { UploadCloud, Loader2, CheckCircle2 } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
import { useSettingsStore } from '../stores/settingsStore.js';
import { restoreManager } from '../services/restoreManager.js';
import { decodeImapUtf7 } from '../utils/imapUtf7';

export default function RestoreModal() {
  const detected = useSettingsStore((s) => s.restoreDetected);
  const active = useSettingsStore((s) => s.activeRestore);
  const clearDetected = useSettingsStore((s) => s.clearRestoreDetected);
  const clearActive = useSettingsStore((s) => s.clearActiveRestore);
  const dismissRestore = useSettingsStore((s) => s.dismissRestore);
  const changeServerAccountId = useSettingsStore((s) => s.changeServerAccountId);

  // ChangeServerModal drives its own restore step — stay closed while it's open,
  // even if detection/activeRestore state would otherwise open this modal.
  const open = !changeServerAccountId && (!!detected || (!!active && active.status === 'running'));
  const localTotal = useMemo(
    () => (detected?.folders || []).reduce((n, f) => n + f.localCount, 0),
    [detected]
  );

  const titleId = useId();
  const close = useCallback(() => { clearActive(); clearDetected(); }, [clearActive, clearDetected]);
  // A restore in flight has no cancel — Escape and the X are both withheld.

  if (!open) return null;

  const running = active && active.status === 'running';
  const done = active && active.status === 'completed';

  const onStart = () => {
    if (!detected) return;
    restoreManager.start(detected.account, detected.accountId, detected.folders.map((f) => f.mailbox));
  };
  const onClose = close;

  return (
    <Dialog
      open
      onClose={onClose}
      portal
      // Restoring to a server is the reason the app is in front of you: it
      // outranks whatever dialog started it.
      z={Z.alert}
      size="lg"
      panelBg="bg-mail-surface"
      // A restore in flight has no cancel — Escape, the backdrop and the X
      // are all withheld.
      dismissable={!running}
      aria-labelledby={titleId}
    >
        <div className="flex items-center justify-between mb-3">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-mail-text">
            <UploadCloud size={18} /> Restore emails to server
          </h2>
        </div>

        {!active && detected && (
          <>
            <p className="text-mail-text-muted text-sm mb-3">
              This account moved to a new server that looks empty, but {localTotal} emails
              are stored locally. Upload them to the new server?
            </p>
            <ul className="text-sm text-mail-text mb-4 max-h-40 overflow-auto">
              {detected.folders.map((f) => (
                <li key={f.mailbox} className="flex justify-between py-0.5">
                  <span>{decodeImapUtf7(f.mailbox)}</span><span className="text-mail-text-muted">{f.localCount}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => dismissRestore(detected.accountId)}>
                Not now
              </Button>
              <Button variant="primary" onClick={onStart}>
                Restore {localTotal}
              </Button>
            </div>
          </>
        )}

        {running && (
          <div className="text-sm">
            <div className="flex items-center gap-2 mb-2 text-mail-text">
              <Loader2 className="animate-spin" size={16} />
              <span>Uploading{active.current_folder ? ` — ${decodeImapUtf7(active.current_folder)}` : ''}…</span>
            </div>
            <div className="text-mail-text-muted">
              {active.uploaded_emails} uploaded · {active.skipped_emails} skipped · {active.failed_emails} failed
              {active.folder_progress ? ` · ${active.folder_progress}` : ''}
            </div>
            <div className="flex justify-end mt-4">
              <Button variant="secondary" onClick={() => restoreManager.cancel()}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {done && (
          <div className="text-sm">
            <div className="flex items-center gap-2 mb-2 text-mail-success">
              <CheckCircle2 size={16} /> Restore complete
            </div>
            <div className="text-mail-text-muted">
              {active.uploaded_emails} uploaded · {active.skipped_emails} skipped · {active.failed_emails} failed
            </div>
            <div className="flex justify-end mt-4">
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        )}
    </Dialog>
  );
}
