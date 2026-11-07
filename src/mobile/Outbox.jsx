// The outbox over the message list: a row while anything is unsent (store `outbox`: queued,
// sending, failed or uncertain), and on tap a sheet with each message, its state and, for one
// that failed or may have gone out, Retry and Discard. An uncertain send says so plainly: Retry
// may deliver it twice, which is the user's call (the engine never resends it on its own).
import React, { useCallback, useState } from 'react';
import { displayText } from '../utils/bidiText.js';
import Sheet from './Sheet.jsx';
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

export function OutboxSheet({ rows, onClose }) {
  const t = useT();
  const store = useMobileStore.getState;
  return (
    <Sheet kind="sheet" label={t('mobile.outbox.title')} onClose={onClose}>
      <div className="mv-sheet__grip" aria-hidden="true" />
      <h2 className="mv-sheet__title">{t('mobile.outbox.title')}</h2>
      {rows.length === 0 ? (
        <p className="mv-drawer__empty">{t('mobile.outbox.empty')}</p>
      ) : (
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
  const [open, setOpen] = useState(initialOpen);
  const close = useCallback(() => setOpen(false), []);
  useBackLayer(open && rows.length > 0, close);
  if (!rows.length) return null;
  const attention = rows.some((r) => r.state === 'failed' || r.state === 'uncertain');
  return (
    <>
      <button type="button" className={`mv-outbox-row${attention ? ' mv-outbox-row--alert' : ''}`} data-mv-outbox onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" />
        </svg>
        <span>{t('mobile.outbox.waiting', { count: rows.length })}</span>
      </button>
      {open && <OutboxSheet rows={rows} onClose={close} />}
    </>
  );
}
