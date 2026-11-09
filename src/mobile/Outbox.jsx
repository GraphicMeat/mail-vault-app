// The outbox over the message list: a row while anything is unsent (store `outbox`: queued,
// sending, failed or uncertain), and on tap a sheet with each message, its state and, for one
// that failed or may have gone out, Retry and Discard. An uncertain send says so plainly: Retry
// may deliver it twice, which is the user's call (the engine never resends it on its own).
//
// Scheduled (plan 4 Task 8): a `queued` row whose picked time (`scheduledMs`) is still to come is
// listed first, under its own heading, with when it goes and three actions: Change time (the send
// later sheet, then `mobile.outbox.reschedule`, which checks Premium again), Send now (Retry: at
// once, no longer scheduled) and Cancel (Discard).
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { displayText } from '../utils/bidiText.js';
import Sheet from './Sheet.jsx';
import SendLater from './SendLater.jsx';
import { formatSendTime } from './format.js';
import { useMobileStore } from './store.js';
import { useBackLayer } from './backStack.js';
import { useT } from './i18n.js';

// Literal keys, so the catalog tests can see every one.
const STATE_KEYS = Object.freeze({
  queued: 'mobile.outbox.state.queued',
  sending: 'mobile.outbox.state.sending',
  failed: 'mobile.outbox.state.failed',
  uncertain: 'mobile.outbox.state.uncertain',
});
const stateKey = (state) => (Object.hasOwn(STATE_KEYS, state) ? STATE_KEYS[state] : STATE_KEYS.queued);

/** A row waiting for the time the user picked (the engine's rule: queued, `scheduledMs` to come). */
/**
 * Re-renders when the soonest scheduled time among `rows` passes (checked at least every minute),
 * so a row whose time came moves out of "Scheduled" while the sheet is open.
 */
export function useScheduleClock(rows) {
  const [, tick] = useReducer((n) => n + 1, 0);
  const now = Date.now();
  const next = rows.reduce((m, r) => (isScheduled(r, now) ? Math.min(m, r.scheduledMs) : m), Infinity);
  useEffect(() => {
    if (!Number.isFinite(next)) return undefined;
    const wait = setTimeout(tick, Math.min(Math.max(next - Date.now() + 50, 1000), 60_000));
    return () => clearTimeout(wait);
  });
  return now;
}

export const isScheduled = (r, now) => r.state === 'queued' && Number.isFinite(r.scheduledMs) && now < r.scheduledMs;

function ScheduledList({ rows, now, onMove }) {
  const t = useT();
  const store = useMobileStore.getState;
  return (
    <>
      <h3 className="mv-outbox__heading">{t('mobile.outbox.scheduled')}</h3>
      <ul className="mv-outbox" data-mv-outbox-scheduled>
        {rows.map((r) => {
          const subject = displayText(r.subject, '') || t('common.noSubject');
          return (
            <li key={r.id} className="mv-outbox__item mv-outbox__item--scheduled" data-mv-outbox-row={r.id}>
              <div className="mv-outbox__text">
                <span className="mv-outbox__subject" dir="auto">{subject}</span>
                <span className="mv-outbox__state">{t('mobile.schedule.about', { time: formatSendTime(r.scheduledMs, now) })}</span>
              </div>
              <div className="mv-outbox__actions">
                <button type="button" className="mv-outbox__btn" aria-label={t('mobile.outbox.changeTimeOf', { subject })} onClick={() => onMove(r)}>
                  {t('mobile.outbox.changeTime')}
                </button>
                <button type="button" className="mv-outbox__btn" aria-label={t('mobile.outbox.sendNowOf', { subject })} onClick={() => store().retryOutbox(r.id)}>
                  {t('mobile.outbox.sendNow')}
                </button>
                <button type="button" className="mv-outbox__btn mv-outbox__btn--danger" aria-label={t('mobile.outbox.cancelOf', { subject })} onClick={() => store().discardOutbox(r.id)}>
                  {t('common.cancel')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function OutboxSheet({ rows: all, onClose }) {
  const t = useT();
  const store = useMobileStore.getState;
  const [moving, setMoving] = useState(null);
  const closeMoving = useCallback(() => setMoving(null), []);
  useBackLayer(Boolean(moving), closeMoving);
  const now = useScheduleClock(all);
  const scheduled = all.filter((r) => isScheduled(r, now));
  const rows = all.filter((r) => !isScheduled(r, now));
  if (moving) {
    return (
      <SendLater
        title={t('mobile.outbox.changeTime')}
        onPick={(at) => { setMoving(null); store().rescheduleOutbox(moving.id, at); }}
        onClose={closeMoving}
      />
    );
  }
  return (
    <Sheet kind="sheet" label={t('mobile.outbox.title')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('mobile.outbox.title')}</h2>
      {scheduled.length > 0 && <ScheduledList rows={scheduled} now={now} onMove={setMoving} />}
      {all.length === 0 && <p className="mv-drawer__empty">{t('mobile.outbox.empty')}</p>}
      {rows.length > 0 && (
        <ul className="mv-outbox">
          {rows.map((r) => {
            const subject = displayText(r.subject, '') || t('common.noSubject');
            const actionable = r.state === 'failed' || r.state === 'uncertain';
            return (
              <li key={r.id} className={`mv-outbox__item mv-outbox__item--${r.state}`} data-mv-outbox-row={r.id}>
                <div className="mv-outbox__text">
                  <span className="mv-outbox__subject" dir="auto">{subject}</span>
                  <span className="mv-outbox__state">{t(stateKey(r.state))}</span>
                </div>
                {actionable && (
                  <div className="mv-outbox__actions">
                    <button type="button" className="mv-outbox__btn" aria-label={t('mobile.outbox.retry', { subject })} onClick={() => store().retryOutbox(r.id)}>
                      {t('common.retry')}
                    </button>
                    <button type="button" className="mv-outbox__btn mv-outbox__btn--danger" aria-label={t('mobile.outbox.discard', { subject })} onClick={() => store().discardOutbox(r.id)}>
                      {t('common.discard')}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}

/** The row at the top of the list, or nothing while the outbox is empty. */
export default function OutboxRow({ initialOpen = false }) {
  const t = useT();
  const rows = useMobileStore((s) => s.outbox);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const opened = useRef(false);
  // An emptied outbox closes the sheet for good: it never comes back by itself with the next row.
  // (`initialOpen`, a screenshot hook, opens it once, when the first rows are there.)
  useEffect(() => {
    if (!rows.length) setOpen(false);
    else if (initialOpen && !opened.current) {
      opened.current = true;
      setOpen(true);
    }
  }, [rows.length, initialOpen]);
  useBackLayer(open && rows.length > 0, close);
  const now = useScheduleClock(rows);
  if (!rows.length) return null;
  const attention = rows.some((r) => r.state === 'failed' || r.state === 'uncertain');
  const label = rows.every((r) => isScheduled(r, now))
    ? t('mobile.outbox.scheduledCount', { count: rows.length })
    : t('mobile.outbox.waiting', { count: rows.length });
  return (
    <>
      <button type="button" className={`mv-outbox-row${attention ? ' mv-outbox-row--alert' : ''}`} data-mv-outbox onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" />
        </svg>
        <span>{label}</span>
      </button>
      {open && <OutboxSheet rows={rows} onClose={close} />}
    </>
  );
}
