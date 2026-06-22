import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, UploadCloud, Loader2, CheckCircle2 } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore.js';
import { restoreManager } from '../services/restoreManager.js';

export default function RestoreModal() {
  const detected = useSettingsStore((s) => s.restoreDetected);
  const active = useSettingsStore((s) => s.activeRestore);
  const clearDetected = useSettingsStore((s) => s.clearRestoreDetected);
  const clearActive = useSettingsStore((s) => s.clearActiveRestore);

  const open = !!detected || (!!active && active.status === 'running');
  const localTotal = useMemo(
    () => (detected?.folders || []).reduce((n, f) => n + f.localCount, 0),
    [detected]
  );

  if (!open) return null;

  const running = active && active.status === 'running';
  const done = active && active.status === 'completed';

  const onStart = () => {
    if (!detected) return;
    restoreManager.start(detected.account, detected.accountId, detected.folders.map((f) => f.mailbox));
  };
  const onClose = () => { clearActive(); clearDetected(); };

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="bg-mail-surface border border-mail-border w-[480px] max-w-[92vw] rounded-xl p-6 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-mail-text">
            <UploadCloud size={18} /> Restore emails to server
          </h2>
          {!running && (
            <button onClick={onClose} aria-label="Close" className="text-mail-text-muted hover:text-mail-text">
              <X size={18} />
            </button>
          )}
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
                  <span>{f.mailbox}</span><span className="text-mail-text-muted">{f.localCount}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                className="text-sm font-medium text-mail-text border border-mail-border rounded-lg px-4 py-2 hover:bg-mail-surface-hover transition-colors"
                onClick={onClose}
              >
                Not now
              </button>
              <button
                className="bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-accent-hover transition-colors"
                onClick={onStart}
              >
                Restore {localTotal}
              </button>
            </div>
          </>
        )}

        {running && (
          <div className="text-sm">
            <div className="flex items-center gap-2 mb-2 text-mail-text">
              <Loader2 className="animate-spin" size={16} />
              <span>Uploading{active.current_folder ? ` — ${active.current_folder}` : ''}…</span>
            </div>
            <div className="text-mail-text-muted">
              {active.uploaded_emails} uploaded · {active.skipped_emails} skipped · {active.failed_emails} failed
              {active.folder_progress ? ` · ${active.folder_progress}` : ''}
            </div>
            <div className="flex justify-end mt-4">
              <button
                className="text-sm font-medium text-mail-text border border-mail-border rounded-lg px-4 py-2 hover:bg-mail-surface-hover transition-colors"
                onClick={() => restoreManager.cancel()}
              >
                Cancel
              </button>
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
              <button
                className="bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-accent-hover transition-colors"
                onClick={onClose}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
