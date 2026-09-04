import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
import { useT } from '../i18n/index.js';
import { formatTime } from '../utils/dateFormat';
import { useFocusStore, useFocusClock, remainingMs, formatRemaining } from '../stores/focusStore';

/**
 * The lock itself: an opaque full-window dialog over the whole app.
 *
 * `dismissable={false}` and no `title` mean there is no Escape, no backdrop
 * click and no X — the only way out is the text link, which asks first. That
 * is the entire mechanism; a lock with a one-click exit is a suggestion.
 *
 * A natural finish just unmounts this. The native notification is the
 * completion signal, so there is no in-app fanfare to dismiss.
 */
export function FocusLock() {
  const t = useT();
  const endsAt = useFocusStore(s => s.endsAt);
  const now = useFocusClock(s => s.now);
  const held = useFocusStore(s => s.held);
  const durationMin = useFocusStore(s => s.durationMin);
  const abandon = useFocusStore(s => s.abandon);

  const [confirming, setConfirming] = useState(false);
  const [shame, setShame] = useState(null);

  // The session can end under the confirm step — the timer runs out while the
  // user is still deciding. Without this the NEXT lock opens on "Unlock early?".
  useEffect(() => { if (!endsAt) setConfirming(false); }, [endsAt]);

  const remaining = formatRemaining(remainingMs({ endsAt, now }));

  const unlock = () => {
    const time = remaining;
    const count = durationMin;
    abandon();
    setConfirming(false);
    setShame({ count, time });
  };

  return (
    <>
      <Dialog
        open={!!endsAt}
        dismissable={false}
        size="full"
        z={Z.alert}
        portal
        panelClassName="flex flex-col items-center justify-center gap-6 text-center"
        aria-label={t('focus.lockedTitle')}
        data-testid="focus-lock"
        /* The a11y hook leaves Escape alone when there is no close handler, so
           the confirm step has to peel itself back. */
        onKeyDown={e => {
          if (confirming && e.key === 'Escape') {
            e.stopPropagation();
            setConfirming(false);
          }
        }}
      >
        {confirming ? (
          <>
            <h2 className="text-xl font-semibold text-mail-text">{t('focus.confirmTitle')}</h2>
            <p className="text-sm text-mail-text-muted max-w-sm">
              {t('focus.confirmBody', { count: durationMin, time: remaining })}
            </p>
            <div className="flex gap-3">
              <Button variant="secondary" size="lg" autoFocus onClick={() => setConfirming(false)}>
                {t('focus.keepGoing')}
              </Button>
              <Button variant="primary" size="lg" onClick={unlock} data-testid="focus-unlock-confirm">
                {t('focus.unlockAnyway')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Timer size={40} className="text-mail-accent-text" />
            <h1 className="text-xl font-semibold text-mail-text">{t('focus.lockedTitle')}</h1>
            <p className="text-7xl font-semibold tabular-nums text-mail-text" data-testid="focus-remaining">
              {remaining}
            </p>
            <p className="text-sm text-mail-text-muted">
              {t('focus.backAt', { time: formatTime(endsAt) })}
            </p>
            {held.length > 0 && (
              <p className="text-sm text-mail-text-muted" data-testid="focus-held">
                {t('focus.heldCount', { count: held.length })}
              </p>
            )}
            <Button
              variant="link"
              size="xs"
              onClick={() => setConfirming(true)}
              data-testid="focus-unlock-early"
            >
              {t('focus.unlockEarly')}
            </Button>
          </>
        )}
      </Dialog>

      {/* Renders once the overlay is gone — the one cheeky surface in the app. */}
      <Dialog
        open={!!shame}
        onClose={() => setShame(null)}
        role="alertdialog"
        size="sm"
        portal
        title={t('focus.shameTitle')}
        description={shame && t('focus.shameBody', shame)}
        data-testid="focus-shame"
        footer={
          <Button variant="primary" size="lg" fullWidth data-autofocus onClick={() => setShame(null)}>
            {t('focus.shameDismiss')}
          </Button>
        }
      />
    </>
  );
}
