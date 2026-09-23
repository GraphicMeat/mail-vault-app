import React, { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Clock, X, Send, RotateCcw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useT, tErr, getLocale } from '../../i18n/index.js';
import { useScheduledStore } from '../../stores/scheduledStore';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { useAutostartState } from '../../hooks/useAutostartState';
import { scheduledSendCopyKey, canOfferAlwaysOn } from '../../utils/scheduledCopy';
import { formatWallClock } from '../../utils/scheduledTime';
import { SchedulePicker } from './SchedulePicker';
import { getAccounts } from '../../stores/accountStore';
import * as db from '../../services/db';
import { scheduledEmlToInitialData } from '../../services/localDrafts';
import { openCompose } from '../../utils/composeOpener';

function accountEmail(accountId) {
  return getAccounts().find(a => a.id === accountId)?.email || accountId;
}

function parseEnvelope(row) {
  try { return JSON.parse(row.envelope) || {}; } catch { return {}; }
}

/** The honest "does the app need to be running" line under the compose
 * picker — see scheduledCopy.js for why keying off `daemonAlwaysOn` alone is
 * enough to stay truthful on every build. This folder says the same thing at
 * more length, in BackgroundHelperCard below. */
export function ScheduledSendNotice({ className = '' }) {
  const t = useT();
  const daemonAlwaysOn = useSettingsStore(s => s.daemonAlwaysOn);
  const autostart = useAutostartState();
  return (
    <p className={`text-xs text-mail-text-muted ${className}`}>
      {t(scheduledSendCopyKey(daemonAlwaysOn))}
      {canOfferAlwaysOn(daemonAlwaysOn, autostart) && ` ${t('scheduled.copy.offerAlwaysOn')}`}
    </p>
  );
}

/**
 * Why a scheduled email can go out while MailVault is closed, and the way to
 * make it so. It keys off the same truth as ScheduledSendNotice
 * (scheduledCopy.js): `daemonAlwaysOn` is what the OS confirmed, and
 * `autostart_state` says whether this build can offer it at all, so it never
 * promises a background send, or offers a switch, the build does not have.
 * Compose keeps the one-line notice instead: this card is too much for a
 * popover over the message being written.
 */
function BackgroundHelperCard({ onOpenSettings }) {
  const t = useT();
  const daemonAlwaysOn = useSettingsStore(s => s.daemonAlwaysOn);
  const autostart = useAutostartState();
  let state;
  if (daemonAlwaysOn) {
    state = (
      <p className="flex items-center gap-1.5 text-mail-success" data-testid="scheduled-background-on">
        <CheckCircle2 size={14} className="shrink-0" aria-hidden="true" />
        {t('scheduled.background.on')}
      </p>
    );
  } else if (canOfferAlwaysOn(daemonAlwaysOn, autostart)) {
    state = (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-mail-text-muted">{t('scheduled.background.off')}</span>
        <Button variant="accentTint" size="xs" data-testid="scheduled-background-turn-on" onClick={() => onOpenSettings?.('daemon')}>
          {t('scheduled.background.turnOn')}
        </Button>
      </div>
    );
  } else {
    // `autostart` is null until Rust answers (and outside Tauri): that is not
    // "unsupported", so only the way to Settings shows until it is known.
    state = (
      <div className="flex flex-wrap items-center gap-x-2">
        {autostart && (
          <span className="text-mail-text-muted" data-testid="scheduled-background-unsupported">
            {t('scheduled.background.unsupported')}
          </span>
        )}
        <Button variant="link" size="xs" data-testid="scheduled-background-settings" onClick={() => onOpenSettings?.('daemon')}>
          {t('scheduled.background.settingsLink', { tab: t('settings.tab.daemon') })}
        </Button>
      </div>
    );
  }
  return (
    <div data-testid="scheduled-background-card"
      className="mb-3 rounded-lg border border-mail-border bg-mail-surface px-3 py-2.5 text-xs flex flex-col gap-1.5">
      <p className="text-mail-text">
        {t('scheduled.background.explain', { setting: t('settings.daemon.alwaysOn.label') })}
      </p>
      {state}
    </div>
  );
}

function RowActions({ row, onReschedule, onCancel, onSendNow }) {
  const t = useT();
  const busy = row.status === 'sending';
  return (
    <div className="flex items-center gap-1 shrink-0">
      {row.status === 'queued' && (
        <Button variant="ghost" icon size="xs" title={t('scheduled.row.reschedule')} onClick={() => onReschedule(row)}>
          <Clock size={14} />
        </Button>
      )}
      {(row.status === 'queued' || row.status === 'failed') && (
        <Button variant="ghost" icon size="xs" title={t('common.cancel')} onClick={() => onCancel(row)}>
          <X size={14} />
        </Button>
      )}
      {(row.status === 'queued' || row.status === 'failed') && (
        <Button variant="ghost" icon size="xs" disabled={busy}
          title={row.status === 'failed' ? t('common.retry') : t('scheduled.row.sendNow')}
          onClick={() => onSendNow(row)}>
          {row.status === 'failed' ? <RotateCcw size={14} /> : <Send size={14} />}
        </Button>
      )}
    </div>
  );
}

/**
 * The Scheduled folder: every row `scheduled.list` returns, live-updated from
 * the `scheduled-send` event via the store. Not a real IMAP mailbox — the
 * rows are the daemon's queue, so this reads the store instead of the mail
 * list machinery every other folder uses.
 *
 * Editing and rescheduling are Premium; seeing the queue, Cancel, Send now
 * and Retry are not, so a lapsed subscriber can still get their mail out or
 * stop it.
 */
export function ScheduledFolderModal({ onClose, onOpenSettings }) {
  const t = useT();
  const rows = useScheduledStore(s => s.rows);
  const loadRows = useScheduledStore(s => s.loadRows);
  const reschedule = useScheduledStore(s => s.reschedule);
  const cancel = useScheduledStore(s => s.cancel);
  const sendNow = useScheduledStore(s => s.sendNow);
  const isPremium = hasPremiumAccess(useSettingsStore(s => s.billingProfile));
  // The row whose edit or reschedule was refused, to show the upgrade under it.
  const [lockedId, setLockedId] = useState(null);
  const [reschedulingId, setReschedulingId] = useState(null);
  const [draft, setDraft] = useState({ localTime: '', tz: '' });
  const [error, setError] = useState(null);

  useEffect(() => { loadRows().catch(err => setError(String(err?.message || err))); }, [loadRows]);

  // A message that went out belongs in Sent, not in a list of things still
  // waiting to happen -- and a cancelled one never happened at all. What stays
  // is what still needs the user: queued, sending, and failed.
  const visible = rows.filter(r => r.status !== 'cancelled' && r.status !== 'sent');

  const startReschedule = (row) => {
    if (!isPremium) { setLockedId(row.id); return; }
    setReschedulingId(row.id);
    setDraft({ localTime: row.localTime, tz: row.tz });
  };

  const submitReschedule = async (row) => {
    try {
      const { zonedTimeToEpoch, isPastLocalTime } = await import('../../utils/scheduledTime');
      if (isPastLocalTime(draft.localTime, draft.tz)) return; // picker already shows the error
      await reschedule(row.id, { ...draft, fireAt: zonedTimeToEpoch(draft.localTime, draft.tz) });
      setReschedulingId(null);
    } catch (err) {
      setError(String(err?.message || err));
    }
  };

  const handleEdit = async (row) => {
    if (!isPremium) { setLockedId(row.id); return; }
    try {
      if (!getAccounts().some(a => a.id === row.accountId)) throw new Error(t('scheduled.errors.accountGone'));
      // The frozen message lives only in the vault's `Scheduled` mailbox
      // (daemon `scheduled.create`); the server has never seen it, so this
      // reads the vault copy, not IMAP.
      const eml = await db.getLocalEmailFull(row.accountId, row.mailbox, row.uid);
      if (!eml) throw new Error(t('scheduled.errors.openFailed'));
      // Nothing is cancelled here. The row stays queued, holding the message,
      // until the edit is scheduled over it or sent in its place
      // (composeSend.js); closing the window leaves it exactly as it was.
      openCompose({ initialData: scheduledEmlToInitialData({ row, eml }) });
      onClose?.();
    } catch (err) {
      setError(String(err?.message || err));
    }
  };

  // The daemon refuses a row it is already sending with an E_ code (tErr).
  const handleCancel = async (row) => {
    try { await cancel(row.id); } catch (err) { setError(tErr(err)); }
  };

  const handleSendNow = async (row) => {
    try { await sendNow(row.id); } catch (err) { setError(String(err?.message || err)); }
  };

  return (
    <Dialog open onClose={onClose} title={t('scheduled.folder.title')} size="lg" data-testid="scheduled-folder-modal">
      <BackgroundHelperCard onOpenSettings={onOpenSettings} />
      {error && <p role="alert" className="text-xs text-mail-danger mb-2">{error}</p>}
      {visible.length === 0 ? (
        <p data-testid="scheduled-empty" className="text-sm text-mail-text-muted py-6 text-center">
          {t('scheduled.folder.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-mail-border">
          {visible.map(row => {
            const envelope = parseEnvelope(row);
            const summary = (
              <>
                <div className="text-sm text-mail-text truncate">{envelope.to || t('scheduled.row.noRecipient')}</div>
                <div className="text-xs text-mail-text-muted">
                  {accountEmail(row.accountId)} — {formatWallClock(row.localTime, getLocale())} ({row.tz})
                </div>
              </>
            );
            return (
              <li key={row.id} data-testid={`scheduled-row-${row.id}`} className="py-2.5 flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  {/* The row itself opens the email for editing. A sending
                      row is not a button: the message is already on its way. */}
                  {row.status === 'queued' || row.status === 'failed' ? (
                    <button type="button" data-testid={`scheduled-row-open-${row.id}`} title={t('scheduled.row.edit')}
                      className="min-w-0 flex-1 text-left -mx-2 px-2 py-1 rounded-md hover:bg-mail-surface-hover transition-colors"
                      onClick={() => handleEdit(row)}>
                      {summary}
                    </button>
                  ) : (
                    <div className="min-w-0 flex-1">{summary}</div>
                  )}
                  <RowActions row={row} onReschedule={startReschedule} onCancel={handleCancel} onSendNow={handleSendNow} />
                </div>
                {row.status === 'failed' && (
                  <div className="flex items-center gap-1 text-xs text-mail-danger">
                    <AlertTriangle size={12} />
                    {row.lastError || t('scheduled.row.failedGeneric')}
                  </div>
                )}
                {row.status === 'sending' && (
                  <div className="text-xs text-mail-text-muted">{t('scheduled.row.sending')}</div>
                )}
                {lockedId === row.id && (
                  <div data-testid={`scheduled-locked-${row.id}`} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-mail-text-muted">{t('scheduled.premium.editLocked')}</span>
                    <Button variant="accentTint" size="xs" data-testid={`scheduled-upgrade-${row.id}`}
                      onClick={() => onOpenSettings?.('billing')}>
                      {t('common.upgrade')}
                    </Button>
                  </div>
                )}
                {reschedulingId === row.id && (
                  <div className="pt-1">
                    <SchedulePicker
                      localTime={draft.localTime}
                      tz={draft.tz}
                      presets={false}
                      testIdPrefix={`scheduled-reschedule-${row.id}`}
                      onChange={setDraft}
                    />
                    <div className="flex gap-2 mt-2">
                      <Button variant="primary" size="xs" onClick={() => submitReschedule(row)}>
                        {t('common.save')}
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setReschedulingId(null)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
