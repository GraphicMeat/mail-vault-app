import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { useSettingsStore } from '../../stores/settingsStore';
import { useBackupStore } from '../../stores/backupStore';
import { fetchPolicy } from '../../utils/fetchPolicy';
import { resolveServerAccount } from '../../services/authUtils';
import { send } from '../../services/transport';
import { decodeImapUtf7 } from '../../utils/imapUtf7';
import { useT } from '../../i18n/index.js';

/**
 * One account's copies that the app has shown or cached but the vault does not
 * hold, with "Save them now" (Phase 5, D7). The daemon counts
 * (`vault_gap_count`) and saves (`vault_gap_save`, which reports through the
 * backup's own `backup-progress` frames and stops on `backup_cancel`); this
 * row shows what it says. It never claims "all in your vault" when it cannot
 * know: a floor (`partial`), an unknown count, an unreachable vault, or a
 * download mode that keeps no copies each read as what they are.
 */

// The daemon codes this row can meet, as catalog words. A count's `reason` is
// the bare code; a refusal is `CODE: detail`, and the detail is internal.
const CODES = ['E_ACCOUNT_NOT_FOUND', 'E_HEADER_CACHE_UNAVAILABLE', 'E_VAULT_GAP_GRAPH', 'E_VAULT_UNAVAILABLE'];
export function errorKey(e, fallback) {
  const text = String(e?.message ?? e ?? '');
  const code = CODES.find((c) => text === c || text.startsWith(`${c}:`));
  return code ? `errors.${code}` : fallback;
}

// Hidden, On Demand and Index Only keep no copy here by design: nothing to count.
const keepsNoCopies = (state, accountId) => {
  const policy = fetchPolicy(state, accountId);
  return !policy || policy.mode === 'onDemand' || policy.mode === 'indexOnly';
};

// Keep Recent promises only mail dated inside its window (the daemon leaves
// older copies out of the count on purpose: the mode leaves them on the
// server), so the row names the window. 0 = no window (a window of 0 keeps
// everything, as Hoarder does).
const recentWindow = (state, accountId) => {
  const policy = fetchPolicy(state, accountId);
  return policy?.mode === 'keepRecent' ? policy.windowMonths : 0;
};

export default function VaultGapRow({ account }) {
  const t = useT();
  const byDesign = useSettingsStore((s) => keepsNoCopies(s, account.id));
  const months = useSettingsStore((s) => recentWindow(s, account.id));
  // A backup running or queued for this account would displace a save.
  const backupBusy = useBackupStore((s) => (!!s.activeBackup?.active && !s.activeBackup.done
    && s.activeBackup.accountId === account.id) || s.queue.includes(account.id));
  const isGraph = account.oauth2Transport === 'graph';
  // The daemon's count reply, else the catalog key of why there is none.
  const [gap, setGap] = useState(null);
  // While a save runs: whether it joined a backup, and its latest frame.
  const [run, setRun] = useState(null);
  // The last save's end: how many copies failed, or the key of its refusal.
  const [outcome, setOutcome] = useState(null);
  const running = useRef(false);
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++seq.current;
    send('vault_gap_count', { accountId: account.id })
      .then((reply) => { if (mine === seq.current) setGap(reply || {}); })
      .catch((e) => { if (mine === seq.current) setGap({ error: errorKey(e, 'settings.backup.vaultGap.countFailed') }); });
  }, [account.id]);

  useEffect(() => { if (!byDesign) refresh(); }, [byDesign, refresh]);

  useEffect(() => {
    let unlisten = null;
    let gone = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('backup-progress', ({ payload: p }) => {
        if (p?.account_id !== account.id) return;
        if (p.active) {
          if (running.current) setRun((r) => r && { ...r, frame: p });
          return;
        }
        if (running.current) {
          running.current = false;
          setRun(null);
          // A run that died before its own last frame says so with a code.
          setOutcome(p.success === false && !p.cancelled
            ? { error: errorKey(p.last_error, 'settings.backup.vaultGap.saveFailed') }
            : { failed: p.errors || 0 });
        }
        // Any backup of this account that ends may have changed the count.
        refresh();
      }))
      .then((u) => { if (gone) u(); else unlisten = u; })
      .catch(() => {});
    return () => { gone = true; unlisten?.(); };
  }, [account.id, refresh]);

  const save = async () => {
    running.current = true;
    setRun({ joined: false, frame: null });
    setOutcome(null);
    try {
      // The value backup_run_account takes: keychain plus token refresh.
      const resolved = await resolveServerAccount(account.id, account);
      if (!resolved.ok) throw Object.assign(new Error(resolved.reason), { key: 'errors.conn.recovery.signAgainReconnectAccount' });
      const reply = await send('vault_gap_save', { accountId: account.id, accountJson: JSON.stringify(resolved.account) });
      // Joined a backup already running: its frames end this row's wait too.
      if (running.current && reply?.started === false) setRun((r) => r && { ...r, joined: true });
    } catch (e) {
      running.current = false;
      setRun(null);
      setOutcome({ error: e?.key || errorKey(e, 'settings.backup.vaultGap.saveFailed') });
    }
  };

  const count = typeof gap?.count === 'number' ? gap.count : null;
  const unreachable = gap?.vaultReachable === false;
  const state = byDesign ? 'byDesign'
    : !gap ? 'loading'
    : gap.error ? 'error'
    : count === null ? 'unknown'
    : unreachable ? 'unreachable'
    : gap.partial ? 'partial'
    : count > 0 ? 'missing' : 'none';
  // Only for a reply that came back without a usable count: never while it is
  // on its way, and never for a mode that keeps no copies (nothing is counted).
  const reasonKey = gap && !gap.error && !byDesign && (count === null || unreachable)
    ? errorKey(gap.reason, unreachable ? 'errors.E_VAULT_UNAVAILABLE' : 'settings.backup.vaultGap.countFailed')
    : null;
  const showCount = count !== null && !byDesign && (count > 0 || unreachable);
  const frame = run?.frame;
  const canSave = !run && !backupBusy && !byDesign && !isGraph && !unreachable && count > 0;

  return (
    <div data-testid="vault-gap-row" data-account-id={account.id} data-state={state}
      data-count={count ?? ''} data-running={run ? 'true' : 'false'}
      className="mb-3 rounded-lg bg-mail-bg p-3 space-y-1.5">
      <div className="text-sm font-medium text-mail-text">{t('settings.backup.vaultGap.title')}</div>
      <p className="text-xs text-mail-text-muted">
        {months ? t('settings.backup.vaultGap.hintRecent', { count: months }) : t('settings.backup.vaultGap.hint')}
      </p>

      {state === 'loading' && <p className="text-xs text-mail-text-muted">{t('settings.daemon.checking')}</p>}
      {state === 'byDesign' && <p className="text-xs text-mail-text-muted">{t('settings.backup.vaultGap.byDesign')}</p>}
      {state === 'error' && <p className="text-xs text-mail-warning">{t(gap.error)}</p>}
      {showCount && (
        <p data-testid="vault-gap-count" className="text-sm font-semibold text-mail-text">
          {t(gap.partial && count > 0 ? 'settings.backup.vaultGap.atLeast' : 'settings.backup.vaultGap.count', { count })}
        </p>
      )}
      {state === 'none' && (
        <p className="text-xs text-mail-success">
          {months ? t('settings.backup.vaultGap.noneRecent', { count: months }) : t('settings.backup.vaultGap.none')}
        </p>
      )}
      {gap?.partial && count !== null && <p className="text-xs text-mail-text-muted">{t('settings.backup.vaultGap.partial')}</p>}
      {reasonKey && <p data-testid="vault-gap-reason" className="text-xs text-mail-warning">{t(reasonKey)}</p>}
      {isGraph && count > 0 && <p className="text-xs text-mail-text-muted">{t('errors.E_VAULT_GAP_GRAPH')}</p>}

      {run && (
        <div data-testid="vault-gap-progress" className="space-y-1">
          <p className="text-xs text-mail-text-muted">
            {run.joined ? t('settings.backup.vaultGap.joined')
              : frame ? t('settings.backup.vaultGap.progress', {
                folder: decodeImapUtf7(frame.folder), done: frame.completed_folders,
                total: frame.total_folders, saved: frame.completed_emails,
              })
              : t('settings.migration.starting')}
          </p>
          <div className="h-1 rounded-full bg-mail-border overflow-hidden">
            {frame?.total_folders > 0 ? (
              <div data-testid="vault-gap-bar" className="h-1 rounded-full bg-mail-accent transition-all"
                style={{ width: `${Math.round((frame.completed_folders / frame.total_folders) * 100)}%` }} />
            ) : (
              <div data-testid="vault-gap-bar" className="h-1 w-1/3 rounded-full bg-mail-accent animate-pulse" />
            )}
          </div>
        </div>
      )}
      {outcome?.failed > 0 && (
        <p className="text-xs text-mail-warning">{t('settings.backup.vaultGap.failed', { count: outcome.failed })}</p>
      )}
      {outcome?.error && <p className="text-xs text-mail-warning">{t(outcome.error)}</p>}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="accentTint" size="sm" className="text-xs" data-testid="vault-gap-save"
          onClick={save} disabled={!canSave} loading={!!run}>
          {t('settings.backup.vaultGap.save')}
        </Button>
        {run && !run.joined && (
          <Button variant="ghost" size="sm" className="text-xs" data-testid="vault-gap-cancel"
            onClick={() => send('backup_cancel', { accountId: account.id }).catch(() => {})}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </div>
  );
}
