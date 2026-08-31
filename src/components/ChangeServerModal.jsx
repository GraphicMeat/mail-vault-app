import { useEffect, useId, useRef, useState } from 'react';
import { Server, Loader2, CheckCircle2, AlertTriangle, UploadCloud, Minus } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
import { useSettingsStore } from '../stores/settingsStore.js';
import { useMailStore } from '../stores/mailStore.js';
import { restoreManager } from '../services/restoreManager.js';
import { gatherLocalFolders } from '../services/restoreDetection.js';
import { resolveEmailSettings, dnsMailHealth } from '../services/api.js';
import { detectProvider } from './AccountModal.jsx';
import { deriveSuggestion, classifyVerifyError, nextStepAfterVerify } from './changeServer/helpers.js';
import { decodeImapUtf7 } from '../utils/imapUtf7';
import { t as tr, useT  } from '../i18n/index.js';

const inputClass = 'w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text placeholder-mail-text-muted focus:outline-none focus:border-mail-accent';

export default function ChangeServerModal() {
  const t = useT();
  const accountId = useSettingsStore((s) => s.changeServerAccountId);
  const closeChangeServer = useSettingsStore((s) => s.closeChangeServer);
  const activeRestore = useSettingsStore((s) => s.activeRestore);
  const clearActiveRestore = useSettingsStore((s) => s.clearActiveRestore);
  const accounts = useMailStore((s) => s.accounts);
  const changeServer = useMailStore((s) => s.changeServer);

  const account = accounts.find((a) => a.id === accountId);

  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ imapHost: '', imapPort: 993, imapSecurity: 'ssl', smtpHost: '', smtpPort: 587, password: '' });
  const [suggestionNote, setSuggestionNote] = useState(null); // { type: 'info'|'warning', text }
  const [busyLeg, setBusyLeg] = useState(null); // null | 'imap' | 'smtp'
  const [verifyError, setVerifyError] = useState(null); // { leg, text }
  const [folders, setFolders] = useState([]);
  const [dnsHealth, setDnsHealth] = useState({ loading: false, warnings: null, failed: false });

  const detectRanFor = useRef(null);
  const titleId = useId();

  const handleClose = () => {
    closeChangeServer();
    clearActiveRestore();
  };

  // Minimize to the corner restore tray — keeps activeRestore so the upload
  // continues in the background and the tray bubble can reopen this modal.
  const handleMinimize = () => {
    closeChangeServer();
  };

  // Reset local state whenever the modal is (re)opened for an account.
  // Reopening while this account's restore is in flight (minimized to the
  // corner tray) resumes on step 2 instead of resetting.
  useEffect(() => {
    if (!account) return;
    const restore = useSettingsStore.getState().activeRestore;
    const resuming = restore && restore.account_id === account.id;
    setStep(resuming ? 2 : 1);
    setForm({
      imapHost: account.imapHost || '',
      imapPort: account.imapPort || 993,
      imapSecurity: account.imapSecurity || 'ssl',
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
    if (!resuming) useSettingsStore.getState().clearActiveRestore();
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
        setSuggestionNote({ type: 'info', text: tr('changeServer.detectedDomainSDnsVerify') });
      } else if (unchanged) {
        setSuggestionNote({
          type: 'warning',
          text: tr('changeServer.domainSDnsStillPoints'),
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

  // Escape: steps 1/3 close; step 2 mid-restore minimizes to the corner tray.
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (!account) return;
      // Not while verifying — changeServer may persist after the modal is gone.
      if ((step === 1 && !busyLeg) || step === 3) handleClose();
      else if (step === 2 && useSettingsStore.getState().activeRestore) handleMinimize();
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

  // ssl -> starttls/none moves the default IMAP port from 993 to 143 (and back).
  // Only follow that default if the user hasn't typed a custom port already.
  const SECURITY_DEFAULT_PORTS = { ssl: 993, starttls: 143, none: 143 };
  const handleSecurityChange = (e) => {
    const nextSecurity = e.target.value;
    setForm((f) => {
      const prevDefaultPort = SECURITY_DEFAULT_PORTS[f.imapSecurity] ?? 993;
      const portIsDefault = Number(f.imapPort) === prevDefaultPort;
      return {
        ...f,
        imapSecurity: nextSecurity,
        imapPort: portIsDefault ? SECURITY_DEFAULT_PORTS[nextSecurity] : f.imapPort,
      };
    });
  };

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

  return (
    <Dialog
      open
      onClose={handleClose}
      portal
      // A server change is mid-migration state that outranks the settings
      // dialog it was started from.
      z={Z.alert}
      size="lg"
      panelBg="bg-mail-surface"
      // Steps 2 has work in flight: it can be minimized, never dismissed.
      dismissable={showCloseButton}
      aria-labelledby={titleId}
    >
        <div className="flex items-center justify-between mb-3">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-mail-text">
            <Server size={18} /> Change server — {account.email}
          </h2>
          {step === 2 && activeRestore && (
            <Button variant="ghost" icon size="xs" onClick={handleMinimize} aria-label={t('common.minimize')} title={t('changeServer.minimizeRestoreContinuesBackground')}>
              <Minus size={18} />
            </Button>
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
                <label className="block text-xs text-mail-text-muted mb-1">{t('changeServer.imapHost')}</label>
                <input className={inputClass} value={form.imapHost} onChange={(e) => setForm((f) => ({ ...f, imapHost: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs text-mail-text-muted mb-1">{t('changeServer.imapPort')}</label>
                <input type="number" className={inputClass} value={form.imapPort} onChange={(e) => setForm((f) => ({ ...f, imapPort: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="block text-xs text-mail-text-muted mb-1">{t('changeServer.smtpHost')}</label>
                <input className={inputClass} value={form.smtpHost} onChange={(e) => setForm((f) => ({ ...f, smtpHost: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs text-mail-text-muted mb-1">{t('changeServer.smtpPort')}</label>
                <input type="number" className={inputClass} value={form.smtpPort} onChange={(e) => setForm((f) => ({ ...f, smtpPort: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="block text-xs text-mail-text-muted mb-1">{t('changeServer.security')}</label>
                <select className={inputClass} value={form.imapSecurity} onChange={handleSecurityChange}>
                  <option value="ssl">{t('changeServer.sslTls')}</option>
                  <option value="starttls">{t('changeServer.starttls')}</option>
                  <option value="none">{t('changeServer.none')}</option>
                </select>
              </div>
            </div>

            <div className="mb-3">
              <label className="block text-xs text-mail-text-muted mb-1">{t('changeServer.password')}</label>
              <input
                type="password"
                className={inputClass}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder={t('changeServer.newServerPassword')}
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
              <Button variant="secondary" className="bg-transparent"
                onClick={handleClose}
                disabled={!!busyLeg}
              >
                {t('common.cancel')}
              </Button>
              <button
                className="bg-mail-accent-fill text-white rounded-lg px-4 py-2 text-sm font-semibold hover:bg-mail-accent-hover transition-colors disabled:opacity-50"
                onClick={handleVerifySave}
                disabled={!form.password || !!busyLeg}
              >
                {busyLeg ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={14} />
                    {tr('changeServer.verifyingLeg', { leg: busyLeg === 'imap' ? 'IMAP' : 'SMTP' })}
                  </span>
                ) : tr('changeServer.verifySave')}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="text-sm">
            {!activeRestore && !restoreFinished && (
              <>
                <p className="text-mail-text-muted mb-3">
                  {tr('changeServer.uploadEmailsNewServer', { localTotal })}
                </p>
                <ul className="text-sm text-mail-text mb-4 max-h-40 overflow-auto">
                  {folders.map((f) => (
                    <li key={f.mailbox} className="flex justify-between py-0.5">
                      <span>{decodeImapUtf7(f.mailbox)}</span><span className="text-mail-text-muted">{f.localCount}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" className="bg-transparent"
                    onClick={() => setStep(3)}
                  >
                    {t('changeServer.skip')}
                  </Button>
                  <Button variant="primary"
                    onClick={handleStartRestore}
                  >
                    <UploadCloud size={14} /> Restore {localTotal}
                  </Button>
                </div>
              </>
            )}

            {restoreRunning && (
              <div>
                <div className="flex items-center gap-2 mb-2 text-mail-text">
                  <Loader2 className="animate-spin" size={16} />
                  <span>{tr('restore.uploadingFolder', { suffix: activeRestore.current_folder ? ` — ${decodeImapUtf7(activeRestore.current_folder)}` : '' })}</span>
                </div>
                <div className="text-mail-text-muted">
                  {tr('restore.uploadedSkippedFailed', { uploaded: activeRestore.uploaded_emails, skipped: activeRestore.skipped_emails, failed: activeRestore.failed_emails })}
                  {activeRestore.folder_progress ? ` · ${activeRestore.folder_progress}` : ''}
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <Button variant="secondary" className="bg-transparent"
                    onClick={() => restoreManager.cancel()}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button variant="primary"
                    onClick={handleMinimize}
                  >
                    <Minus size={14} /> {t('common.minimize')}
                  </Button>
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
                    {activeRestore.status === 'completed' && tr('changeServer.restoreCompletePrefix')}
                    {activeRestore.status === 'cancelled' && tr('changeServer.restoreCancelledDash')}
                    {activeRestore.status === 'failed' && tr('changeServer.restoreFailedDash')}
                    {tr('restore.uploadedSkippedFailed', { uploaded: activeRestore.uploaded_emails, skipped: activeRestore.skipped_emails, failed: activeRestore.failed_emails })}
                  </span>
                </div>
                <div className="flex justify-end mt-4">
                  <Button variant="primary"
                    onClick={handleRestoreContinue}
                  >
                    {t('changeServer.continue')}
                  </Button>
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
              <div className="text-mail-text-muted mb-4">{t('changeServer.couldnTCheckDnsRecords')}</div>
            )}
            {!dnsHealth.loading && !dnsHealth.failed && dnsHealth.warnings?.length === 0 && (
              <div className="flex items-center gap-2 text-mail-success mb-4">
                <CheckCircle2 size={16} /> {t('changeServer.dnsLooksGoodMxSpf')}
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
              <Button variant="primary" onClick={handleClose}>
                {t('common.done')}
              </Button>
            </div>
          </div>
        )}
    </Dialog>
  );
}
