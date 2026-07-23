import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Server, Loader2, CheckCircle2, AlertTriangle, UploadCloud } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useMailStore } from '../stores/mailStore.js';
import { restoreManager } from '../services/restoreManager.js';
import { gatherLocalFolders } from '../services/restoreDetection.js';
import { resolveEmailSettings, dnsMailHealth } from '../services/api.js';
import { detectProvider } from './AccountModal.jsx';
import { deriveSuggestion, classifyVerifyError, nextStepAfterVerify } from './changeServer/helpers.js';

const inputClass = 'w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text placeholder-mail-text-muted focus:outline-none focus:border-mail-accent';

export default function ChangeServerModal() {
  const accountId = useSettingsStore((s) => s.changeServerAccountId);
  const closeChangeServer = useSettingsStore((s) => s.closeChangeServer);
  const activeRestore = useSettingsStore((s) => s.activeRestore);
  const clearActiveRestore = useSettingsStore((s) => s.clearActiveRestore);
  const accounts = useMailStore((s) => s.accounts);
  const changeServer = useMailStore((s) => s.changeServer);

  const account = accounts.find((a) => a.id === accountId);

  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 587, password: '' });
  const [suggestionNote, setSuggestionNote] = useState(null); // { type: 'info'|'warning', text }
  const [busyLeg, setBusyLeg] = useState(null); // null | 'imap' | 'smtp'
  const [verifyError, setVerifyError] = useState(null); // { leg, text }
  const [folders, setFolders] = useState([]);
  const [dnsHealth, setDnsHealth] = useState({ loading: false, warnings: null, failed: false });

  const detectRanFor = useRef(null);

  const handleClose = () => {
    closeChangeServer();
    clearActiveRestore();
  };

  // Reset local state whenever the modal is (re)opened for an account.
  useEffect(() => {
    if (!account) return;
    setStep(1);
    setForm({
      imapHost: account.imapHost || '',
      imapPort: account.imapPort || 993,
      smtpHost: account.smtpHost || '',
      smtpPort: account.smtpPort || 587,
      password: '',
    });
    setSuggestionNote(null);
    setBusyLeg(null);
    setVerifyError(null);
    setFolders([]);
    setDnsHealth({ loading: false, warnings: null, failed: false });
    // Stale progress from an earlier restore would make step 2 open on its
    // finished view instead of the upload prompt.
    useSettingsStore.getState().clearActiveRestore();
  }, [account?.id]);

  // Detect cascade on mount (per account) — detectProvider → resolveEmailSettings DNS.
  useEffect(() => {
    if (!account || detectRanFor.current === account.id) return;
    detectRanFor.current = account.id;

    const domain = (account.email || '').split('@')[1]?.toLowerCase();
    if (!domain) return;

    const applySuggestion = (detected) => {
      const current = { imapHost: account.imapHost, smtpHost: account.smtpHost };
      const { apply, unchanged } = deriveSuggestion(current, detected);
      if (apply) {
        setForm((f) => ({
          ...f,
          imapHost: detected.imapHost || f.imapHost,
          imapPort: detected.imapPort || f.imapPort,
          smtpHost: detected.smtpHost || f.smtpHost,
          smtpPort: detected.smtpPort || f.smtpPort,
        }));
        setSuggestionNote({ type: 'info', text: "Detected from your domain's DNS — verify before saving." });
      } else if (unchanged) {
        setSuggestionNote({
          type: 'warning',
          text: "Your domain's DNS still points to this server. If you've already switched providers, enter the new server manually.",
        });
      }
    };

    const detected = detectProvider(account.email || '');
    if (detected) {
      applySuggestion({ imapHost: detected.config.imapHost, imapPort: detected.config.imapPort, smtpHost: detected.config.smtpHost, smtpPort: detected.config.smtpPort });
      return;
    }

    resolveEmailSettings(domain)
      .then((dns) => {
        if (dns && (dns.imapHost || dns.smtpHost)) applySuggestion(dns);
      })
      .catch(() => { /* silent — keep current values */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  // Escape closes the modal only in steps 1 and 3 — never mid-restore (step 2).
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (!account) return;
      // Not while verifying — changeServer may persist after the modal is gone.
      if ((step === 1 && !busyLeg) || step === 3) handleClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, account?.id, busyLeg]);

  // Step 3: DNS health check, once, on entry.
  useEffect(() => {
    if (!account || step !== 3 || dnsHealth.warnings !== null || dnsHealth.loading) return;
    const domain = (account.email || '').split('@')[1]?.toLowerCase();
    if (!domain) { setDnsHealth({ loading: false, warnings: null, failed: true }); return; }
    setDnsHealth({ loading: true, warnings: null, failed: false });
    dnsMailHealth(domain, form.imapHost)
      .then((health) => setDnsHealth({ loading: false, warnings: health?.warnings || [], failed: false }))
      .catch(() => setDnsHealth({ loading: false, warnings: null, failed: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, account?.id]);

  if (!account || account.authType === 'oauth2') return null;

  const handleVerifySave = async () => {
    setVerifyError(null);
    setBusyLeg('imap');
    try {
      await changeServer(account.id, { ...form });
      setBusyLeg('smtp'); // best-effort UI signal; changeServer verifies both legs internally
      const gathered = await gatherLocalFolders(account).catch(() => []);
      setFolders(gathered);
      setStep(nextStepAfterVerify(gathered));
    } catch (err) {
      const message = typeof err === 'string' ? err : err?.message || 'Verification failed';
      setVerifyError(classifyVerifyError(message));
    } finally {
      setBusyLeg(null);
    }
  };

  const localTotal = folders.reduce((n, f) => n + f.localCount, 0);

  const handleStartRestore = () => {
    const updated = useMailStore.getState().accounts.find((a) => a.id === accountId) || account;
    restoreManager.start(updated, accountId, folders.map((f) => f.mailbox));
  };

  const restoreRunning = activeRestore && activeRestore.status === 'running';
  const restoreFinished = activeRestore && ['completed', 'cancelled', 'failed'].includes(activeRestore.status);

  const handleRestoreContinue = () => {
    clearActiveRestore();
    setStep(3);
  };

  const showCloseButton = step === 1 || step === 3;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="bg-mail-surface border border-mail-border w-[480px] max-w-[92vw] rounded-xl p-6 shadow-xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-mail-text">
            <Server size={18} /> Change server — {account.email}
          </h2>
          {showCloseButton && (
            <button onClick={handleClose} aria-label="Close" className="text-mail-text-muted hover:text-mail-text">
              <X size={18} />
            </button>
          )}
        </div>

        {step === 1 && (
          <div className="text-sm">
            {suggestionNote && (
              <div className={`flex items-start gap-2 mb-3 text-xs ${suggestionNote.type === 'warning' ? 'text-mail-warning' : 'text-mail-text-muted'}`}>
                {suggestionNote.type === 'warning' && <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />}
                <span>{suggestionNote.text}</span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs text-mail-text-muted mb-1">IMAP host</label>
                <input className={inputClass} value={form.imapHost} onChange={(e) => setForm((f) => ({ ...f, imapHost: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs text-mail-text-muted mb-1">IMAP port</label>
                <input type="number" className={inputClass} value={form.imapPort} onChange={(e) => setForm((f) => ({ ...f, imapPort: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="block text-xs text-mail-text-muted mb-1">SMTP host</label>
                <input className={inputClass} value={form.smtpHost} onChange={(e) => setForm((f) => ({ ...f, smtpHost: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs text-mail-text-muted mb-1">SMTP port</label>
                <input type="number" className={inputClass} value={form.smtpPort} onChange={(e) => setForm((f) => ({ ...f, smtpPort: Number(e.target.value) }))} />
              </div>
            </div>

            <div className="mb-3">
              <label className="block text-xs text-mail-text-muted mb-1">Password</label>
              <input
                type="password"
                className={inputClass}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="New server password"
              />
            </div>

            {verifyError && (
              <div className="flex items-start gap-2 mb-3 text-xs text-mail-danger">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <span>
                  {verifyError.leg === 'imap' && 'IMAP: '}
                  {verifyError.leg === 'smtp' && 'SMTP: '}
                  {verifyError.text}
                </span>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                className="text-sm font-medium text-mail-text border border-mail-border rounded-lg px-4 py-2 hover:bg-mail-surface-hover transition-colors"
                onClick={handleClose}
                disabled={!!busyLeg}
              >
                Cancel
              </button>
              <button
                className="bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-accent-hover transition-colors disabled:opacity-50"
                onClick={handleVerifySave}
                disabled={!form.password || !!busyLeg}
              >
                {busyLeg ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={14} />
                    Verifying {busyLeg === 'imap' ? 'IMAP' : 'SMTP'}…
                  </span>
                ) : 'Verify & Save'}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="text-sm">
            {!activeRestore && !restoreFinished && (
              <>
                <p className="text-mail-text-muted mb-3">
                  Upload {localTotal} emails to the new server?
                </p>
                <ul className="text-sm text-mail-text mb-4 max-h-40 overflow-auto">
                  {folders.map((f) => (
                    <li key={f.mailbox} className="flex justify-between py-0.5">
                      <span>{f.mailbox}</span><span className="text-mail-text-muted">{f.localCount}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex justify-end gap-2">
                  <button
                    className="text-sm font-medium text-mail-text border border-mail-border rounded-lg px-4 py-2 hover:bg-mail-surface-hover transition-colors"
                    onClick={() => setStep(3)}
                  >
                    Skip
                  </button>
                  <button
                    className="bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-accent-hover transition-colors flex items-center gap-2"
                    onClick={handleStartRestore}
                  >
                    <UploadCloud size={14} /> Restore {localTotal}
                  </button>
                </div>
              </>
            )}

            {restoreRunning && (
              <div>
                <div className="flex items-center gap-2 mb-2 text-mail-text">
                  <Loader2 className="animate-spin" size={16} />
                  <span>Uploading{activeRestore.current_folder ? ` — ${activeRestore.current_folder}` : ''}…</span>
                </div>
                <div className="text-mail-text-muted">
                  {activeRestore.uploaded_emails} uploaded · {activeRestore.skipped_emails} skipped · {activeRestore.failed_emails} failed
                  {activeRestore.folder_progress ? ` · ${activeRestore.folder_progress}` : ''}
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

            {restoreFinished && (
              <div>
                <div className="flex items-center gap-2 mb-2 text-mail-text">
                  {activeRestore.status === 'completed'
                    ? <CheckCircle2 size={16} className="text-mail-success" />
                    : <AlertTriangle size={16} className="text-mail-warning" />}
                  <span>
                    {activeRestore.status === 'completed' && 'Restore complete — '}
                    {activeRestore.status === 'cancelled' && 'Restore cancelled — '}
                    {activeRestore.status === 'failed' && 'Restore failed — '}
                    {activeRestore.uploaded_emails} uploaded · {activeRestore.skipped_emails} skipped · {activeRestore.failed_emails} failed
                  </span>
                </div>
                <div className="flex justify-end mt-4">
                  <button
                    className="bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-accent-hover transition-colors"
                    onClick={handleRestoreContinue}
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="text-sm">
            {dnsHealth.loading && (
              <div className="flex items-center gap-2 text-mail-text-muted mb-4">
                <Loader2 className="animate-spin" size={16} /> Checking DNS records…
              </div>
            )}
            {!dnsHealth.loading && dnsHealth.failed && (
              <div className="text-mail-text-muted mb-4">Couldn't check DNS records.</div>
            )}
            {!dnsHealth.loading && !dnsHealth.failed && dnsHealth.warnings?.length === 0 && (
              <div className="flex items-center gap-2 text-mail-success mb-4">
                <CheckCircle2 size={16} /> DNS looks good — MX, SPF and DKIM found.
              </div>
            )}
            {!dnsHealth.loading && !dnsHealth.failed && dnsHealth.warnings?.length > 0 && (
              <ul className="mb-4 space-y-1.5">
                {dnsHealth.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-2 text-mail-warning text-xs">
                    <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <button
                className="bg-mail-accent text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-accent-hover transition-colors"
                onClick={handleClose}
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
