import React, { useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Clock, Pencil, X, Send, RotateCcw, AlertTriangle } from 'lucide-react';
import { useT, getLocale } from '../../i18n/index.js';
import { useScheduledStore } from '../../stores/scheduledStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAutostartState } from '../../hooks/useAutostartState';
import { scheduledSendCopyKey, canOfferAlwaysOn } from '../../utils/scheduledCopy';
import { formatWallClock } from '../../utils/scheduledTime';
import { SchedulePicker } from './SchedulePicker';
import { getAccounts } from '../../stores/accountStore';
import * as api from '../../services/api';
import { openCompose } from '../../utils/composeOpener';

function accountEmail(accountId) {
  return getAccounts().find(a => a.id === accountId)?.email || accountId;
}

function parseEnvelope(row) {
  try { return JSON.parse(row.envelope) || {}; } catch { return {}; }
}

/** The honest "does the app need to be running" line, shared by the picker
 * (ComposeModal) and this folder — see scheduledCopy.js for why keying off
 * `daemonAlwaysOn` alone is enough to stay truthful on every build. */
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

function RowActions({ row, onEdit, onReschedule, onCancel, onSendNow }) {
  const t = useT();
  const busy = row.status === 'sending';
  return (
    <div className="flex items-center gap-1 shrink-0">
      {(row.status === 'queued' || row.status === 'failed') && (
        <Button variant="ghost" icon size="xs" title={t('scheduled.row.edit')} onClick={() => onEdit(row)}>
          <Pencil size={14} />
        </Button>
      )}
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
 */
export function ScheduledFolderModal({ onClose }) {
  const t = useT();
  const rows = useScheduledStore(s => s.rows);
  const loadRows = useScheduledStore(s => s.loadRows);
  const reschedule = useScheduledStore(s => s.reschedule);
  const cancel = useScheduledStore(s => s.cancel);
  const sendNow = useScheduledStore(s => s.sendNow);
  const [reschedulingId, setReschedulingId] = useState(null);
  const [draft, setDraft] = useState({ localTime: '', tz: '' });
  const [error, setError] = useState(null);

  useEffect(() => { loadRows().catch(err => setError(String(err?.message || err))); }, [loadRows]);

  const visible = rows.filter(r => r.status !== 'cancelled');

  const startReschedule = (row) => {
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
    try {
      const account = getAccounts().find(a => a.id === row.accountId);
      if (!account) throw new Error(t('scheduled.errors.accountGone'));
      const eml = await api.fetchEmail(account, row.uid, row.mailbox);
      // Editing means this schedule stops existing — the compose window that
      // opens is a fresh session, not the frozen row kept in sync.
      await cancel(row.id);
      openCompose({
        initialData: {
          to: (eml.to || []).map(a => a.address).filter(Boolean).join(', '),
          cc: (eml.cc || []).map(a => a.address).filter(Boolean).join(', '),
          bcc: (eml.bcc || []).map(a => a.address).filter(Boolean).join(', '),
          subject: eml.subject || '',
          body: eml.html || eml.text || '',
          _accountId: row.accountId,
        },
      });
      onClose?.();
    } catch (err) {
      setError(String(err?.message || err));
    }
  };

  const handleCancel = async (row) => {
    try { await cancel(row.id); } catch (err) { setError(String(err?.message || err)); }
  };

  const handleSendNow = async (row) => {
    try { await sendNow(row.id); } catch (err) { setError(String(err?.message || err)); }
  };

  return (
    <Dialog open onClose={onClose} title={t('scheduled.folder.title')} size="lg" data-testid="scheduled-folder-modal">
      <ScheduledSendNotice className="mb-3" />
      {error && <p role="alert" className="text-xs text-mail-danger mb-2">{error}</p>}
      {visible.length === 0 ? (
        <p data-testid="scheduled-empty" className="text-sm text-mail-text-muted py-6 text-center">
          {t('scheduled.folder.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-mail-border">
          {visible.map(row => {
            const envelope = parseEnvelope(row);
            return (
              <li key={row.id} data-testid={`scheduled-row-${row.id}`} className="py-2.5 flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-mail-text truncate">{envelope.to || t('scheduled.row.noRecipient')}</div>
                    <div className="text-xs text-mail-text-muted">
                      {accountEmail(row.accountId)} — {formatWallClock(row.localTime, getLocale())} ({row.tz})
                    </div>
                  </div>
                  <RowActions row={row} onEdit={handleEdit} onReschedule={startReschedule} onCancel={handleCancel} onSendNow={handleSendNow} />
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
