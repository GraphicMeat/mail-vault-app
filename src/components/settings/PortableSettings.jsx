import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, FolderOpen, HardDrive, Lock, LogOut } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { usePortableStore } from '../../stores/portableStore';
import { daemonCall } from '../../services/daemonClient';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import { usePremiumPriceBlurb } from '../../hooks/usePremiumPricing.js';
import { formatBytes } from '../../utils/formatBytes';
import { TRANSFER_INPUT } from '../transfer/transferStyles';
import { useT } from '../../i18n/index.js';

/** Same floor the daemon enforces (handlers/portable.rs MIN_PASSPHRASE). */
const MIN_PASSWORD = 12;

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '');

/** Quitting stops the daemon too: a portable copy never leaves it running. */
const quit = () => import('@tauri-apps/plugin-process').then(m => m.exit(0)).catch(() => {});

/**
 * Settings > Portable (Premium): copy MailVault and its data to a drive, or,
 * in a copy running from one, the drive's own controls. Not in the App Store
 * build: a sandboxed store app cannot run from a folder it was not granted.
 */
export function PortableSettings({ onUpgrade }) {
  const t = useT();
  if (IS_APPSTORE_BUILD) {
    return (
      <div className="settings-section" data-testid="portable-appstore">
        <p className="text-sm text-mail-text-muted">{t('portable.appStore')}</p>
      </div>
    );
  }
  return <PortablePage onUpgrade={onUpgrade} />;
}

function PortablePage({ onUpgrade }) {
  const status = usePortableStore(s => s.status);
  const isPremium = hasPremiumAccess(useSettingsStore(s => s.billingProfile));
  useEffect(() => { usePortableStore.getState().refresh(); }, []);

  if (status.portable) return <RunningPortable status={status} />;
  return isPremium ? <PortableWizard /> : <PortableUpsell onUpgrade={onUpgrade} />;
}

function PortableUpsell({ onUpgrade }) {
  const t = useT();
  const priceBlurb = usePremiumPriceBlurb();
  return (
    <div className="settings-section" data-testid="portable-upsell">
      <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
        <HardDrive size={18} className="text-mail-accent-text" />
        {t('portable.title')}
        <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-mail-accent-fill text-white rounded-full">
          {t('common.premium')}
        </span>
      </h4>
      <div className="space-y-4">
        <p className="text-sm text-mail-text-muted max-w-xl">{t('portable.intro')}</p>
        <p className="text-xs text-mail-text-muted">{priceBlurb}</p>
        {onUpgrade && <Button variant="primary" size="sm" onClick={onUpgrade}>{t('common.upgrade')}</Button>}
      </div>
    </div>
  );
}

function errorLine(t, err) {
  const message = String(err?.message || err);
  if (message.includes('E_PORTABLE_EXISTS')) return t('portable.error.exists');
  if (message.includes('E_PORTABLE_UNSUPPORTED_BUILD')) return t('portable.unsupportedBuild');
  return t('portable.error.failed', { message });
}

function PortableWizard() {
  const t = useT();
  const [dest, setDest] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [copyConfig, setCopyConfig] = useState(true);
  const [copyMail, setCopyMail] = useState(true);
  const [removeFromHost, setRemoveFromHost] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Removal is only offered for a full copy: what is not on the drive would be gone everywhere.
  const canRemove = copyMail && copyConfig;
  const remove = removeFromHost && canRemove;
  const mismatch = confirm !== '' && password !== confirm;
  const enough = !estimate || estimate.freeBytes == null || estimate.freeBytes >= estimate.neededBytes;
  const ready = !!dest && estimate?.supported !== false && enough
    && [...password].length >= MIN_PASSWORD && password === confirm && !busy;

  const choose = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, title: t('portable.chooseDrive') });
    if (!dir) return;
    setDest(dir);
    setEstimate(null);
    setResult(null);
    setError(null);
    try {
      setEstimate(await daemonCall('portable.estimate', { dest: dir }));
    } catch (err) {
      setError(errorLine(t, err));
    }
  };

  const run = async () => {
    setConfirmOpen(false);
    setBusy(true);
    setError(null);
    setProgress(null);
    let unlisten = null;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('portable-create-progress', e => setProgress(e.payload));
    } catch { /* no events: the button's spinner still shows */ }
    try {
      const reply = await daemonCall('portable.create', {
        dest, passphrase: password, copyMail, copyConfig, removeFromHost: remove,
      });
      setPassword('');
      setConfirm('');
      setResult(reply || {});
    } catch (err) {
      setError(errorLine(t, err));
    } finally {
      if (typeof unlisten === 'function') unlisten();
      setBusy(false);
      setProgress(null);
    }
  };

  const phase = progress && t(`portable.progress.${progress.phase}`, { done: progress.done, total: progress.total });

  return (
    <div className="settings-section space-y-4">
      <h4 className="font-semibold text-mail-text flex items-center gap-2">
        <HardDrive size={18} className="text-mail-accent-text" />
        {t('portable.title')}
      </h4>
      <p className="text-sm text-mail-text-muted max-w-xl">{t('portable.intro')}</p>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={choose} disabled={busy} data-testid="portable-choose-drive">
            <FolderOpen size={14} aria-hidden="true" />
            {t('portable.chooseDrive')}
          </Button>
          {dest && <span className="text-sm text-mail-text truncate" title={dest}>{dest}</span>}
        </div>
        {estimate && (
          <p data-testid="portable-space" data-enough={String(enough)} className={`text-xs ${enough ? 'text-mail-text-muted' : 'text-mail-danger'}`}>
            {estimate.freeBytes == null
              ? t('portable.spaceUnknown', { needed: formatBytes(estimate.neededBytes) })
              : t('portable.space', { free: formatBytes(estimate.freeBytes), needed: formatBytes(estimate.neededBytes) })}
            {!enough && ` ${t('portable.spaceLow')}`}
          </p>
        )}
        {estimate?.supported === false && <p className="text-xs text-mail-danger">{t('portable.unsupportedBuild')}</p>}
      </div>

      <div className="grid gap-3 max-w-md">
        <div>
          <label htmlFor="portable-password" className="block text-xs text-mail-text-muted mb-1">{t('portable.newPassword')}</label>
          <input id="portable-password" type="password" autoComplete="new-password" className={TRANSFER_INPUT}
            value={password} onChange={e => setPassword(e.target.value)} data-testid="portable-passphrase" />
          <p className="text-xs text-mail-text-muted mt-1">{t('settings.transfer.passwordHint', { count: MIN_PASSWORD })}</p>
        </div>
        <div>
          <label htmlFor="portable-password-confirm" className="block text-xs text-mail-text-muted mb-1">{t('settings.transfer.confirmPassword')}</label>
          <input id="portable-password-confirm" type="password" autoComplete="new-password" className={TRANSFER_INPUT}
            value={confirm} onChange={e => setConfirm(e.target.value)} aria-invalid={mismatch || undefined}
            data-testid="portable-passphrase-confirm" />
          {mismatch && <p className="text-xs text-mail-danger mt-1" data-testid="portable-passphrase-mismatch">{t('settings.transfer.passwordMismatch')}</p>}
        </div>
        <p className="flex items-start gap-2 text-xs text-mail-text-muted">
          <AlertTriangle size={14} aria-hidden="true" className="text-mail-warning flex-shrink-0 mt-0.5" />
          {t('portable.passwordWarning')}
        </p>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-mail-text">
          <input type="checkbox" className="accent-mail-accent" checked={copyConfig} onChange={e => setCopyConfig(e.target.checked)} data-testid="portable-copy-config" />
          {t('portable.copyConfig')}
        </label>
        <label className="flex items-center gap-2 text-sm text-mail-text">
          <input type="checkbox" className="accent-mail-accent" checked={copyMail} onChange={e => setCopyMail(e.target.checked)} data-testid="portable-copy-mail" />
          {t('portable.copyMail')}
        </label>
        <label className={`flex items-center gap-2 text-sm ${canRemove ? 'text-mail-text' : 'text-mail-text-muted'}`}>
          <input type="checkbox" className="accent-mail-accent" checked={remove} disabled={!canRemove} onChange={e => setRemoveFromHost(e.target.checked)} data-testid="portable-remove-from-host" />
          {t('portable.removeFromHost')}
        </label>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" disabled={!ready} loading={busy}
          onClick={() => (remove ? setConfirmOpen(true) : run())} data-testid="portable-create">
          {t('portable.create')}
        </Button>
        {phase && <span className="text-xs text-mail-text-muted" role="status">{phase}</span>}
      </div>

      {error && <p role="alert" className="text-sm text-mail-danger">{error}</p>}
      {result && (
        <div data-testid="portable-done" role="status" className="space-y-2 text-sm text-mail-text">
          <p className="flex items-start gap-2">
            <Check size={14} aria-hidden="true" className="text-mail-success mt-0.5 flex-shrink-0" />
            {result.removedFromHost ? t('portable.doneRemoved') : t('portable.done', { path: dest })}
          </p>
          {IS_MAC && result.quarantineCleared === false && (
            <p className="text-xs text-mail-text-muted">
              {t('portable.quarantine', { command: `xattr -dr com.apple.quarantine "${dest}/MailVault.app"` })}
            </p>
          )}
          {result.removedFromHost && <Button size="sm" onClick={quit}><LogOut size={14} aria-hidden="true" />{t('portable.quit')}</Button>}
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={run}
        title={t('portable.removeConfirm.title')}
        description={t('portable.removeConfirm.body')}
        confirmLabel={t('portable.removeConfirm.confirm')}
        cancelLabel={t('common.cancel')}
        destructive
      />
    </div>
  );
}

function RunningPortable({ status }) {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const mismatch = again !== '' && next !== again;
  const ready = current && [...next].length >= MIN_PASSWORD && next === again && !busy;

  const change = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await daemonCall('portable.change_passphrase', { old: current, new: next });
      setCurrent('');
      setNext('');
      setAgain('');
      setMessage({ ok: true, text: t('portable.passwordChanged') });
    } catch (err) {
      const wrong = String(err?.message || err).includes('E_PORTABLE_PASSPHRASE');
      setMessage({ ok: false, text: wrong ? t('portable.passwordWrong') : t('portable.error.failed', { message: String(err?.message || err) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section space-y-4" data-testid="portable-running">
      <h4 className="font-semibold text-mail-text flex items-center gap-2">
        <HardDrive size={18} className="text-mail-accent-text" />
        {t('portable.running.title')}
      </h4>
      <p className="text-sm text-mail-text-muted">{t('portable.running.body', { drive: status.drive })}</p>
      {status.freeBytes != null && (
        <p className="text-xs text-mail-text-muted">{t('portable.running.free', { size: formatBytes(status.freeBytes) })}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => daemonCall('portable.lock').catch(() => {})} data-testid="portable-lock">
          <Lock size={14} aria-hidden="true" />
          {t('portable.lockNow')}
        </Button>
        <Button size="sm" onClick={quit} data-testid="portable-eject">
          <LogOut size={14} aria-hidden="true" />
          {t('portable.eject')}
        </Button>
      </div>
      <p className="text-xs text-mail-text-muted">{t('portable.ejectHint')}</p>

      <div className="grid gap-3 max-w-md">
        <div>
          <label htmlFor="portable-current" className="block text-xs text-mail-text-muted mb-1">{t('portable.currentPassword')}</label>
          <input id="portable-current" type="password" autoComplete="current-password" className={TRANSFER_INPUT}
            value={current} onChange={e => setCurrent(e.target.value)} />
        </div>
        <div>
          <label htmlFor="portable-next" className="block text-xs text-mail-text-muted mb-1">{t('portable.newPassword')}</label>
          <input id="portable-next" type="password" autoComplete="new-password" className={TRANSFER_INPUT}
            value={next} onChange={e => setNext(e.target.value)} />
          <p className="text-xs text-mail-text-muted mt-1">{t('settings.transfer.passwordHint', { count: MIN_PASSWORD })}</p>
        </div>
        <div>
          <label htmlFor="portable-again" className="block text-xs text-mail-text-muted mb-1">{t('settings.transfer.confirmPassword')}</label>
          <input id="portable-again" type="password" autoComplete="new-password" className={TRANSFER_INPUT}
            value={again} onChange={e => setAgain(e.target.value)} aria-invalid={mismatch || undefined} />
          {mismatch && <p className="text-xs text-mail-danger mt-1">{t('settings.transfer.passwordMismatch')}</p>}
        </div>
        <div>
          <Button size="sm" variant="primary" disabled={!ready} loading={busy} onClick={change}>{t('portable.changePassword')}</Button>
        </div>
        {message && <p role={message.ok ? 'status' : 'alert'} className={`text-xs ${message.ok ? 'text-mail-success' : 'text-mail-danger'}`}>{message.text}</p>}
      </div>

      <p className="text-xs text-mail-text-muted">{t('portable.updateHint')}</p>
    </div>
  );
}
