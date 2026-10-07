import React, { useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
import { useT } from '../i18n/index.js';
import { formatTime } from '../utils/dateFormat';
import { useFocusStore, useFocusClock, remainingMs, formatRemaining, FOCUS_SCENES } from '../stores/focusStore';
import { FocusScene } from './focus/FocusScene';

/**
 * The lock itself: an opaque full-window dialog over the whole app.
 *
 * `dismissable={false}` and no `title` mean there is no Escape, no backdrop
 * click and no X — the only way out is the text link, which asks first. That
 * is the entire mechanism; a lock with a one-click exit is a suggestion.
 *
 * A natural finish just unmounts this. The native notification is the
 * completion signal, so there is no in-app fanfare to dismiss.
 *
 * With a scene chosen, the lock is a window onto a pixel-art diorama whose day
 * runs from dawn at the start to night at the end, and the countdown sits at
 * the top. 'none', or a machine where the scene cannot run, is the plain lock.
 */
export function FocusLock() {
  const t = useT();
  const endsAt = useFocusStore(s => s.endsAt);
  const now = useFocusClock(s => s.now);
  const held = useFocusStore(s => s.held);
  const durationMin = useFocusStore(s => s.durationMin);
  const abandon = useFocusStore(s => s.abandon);
  const scene = useFocusStore(s => s.scene);

  const [confirming, setConfirming] = useState(false);
  const [early, setEarly] = useState(null);
  const [sceneFailed, setSceneFailed] = useState(false);
  const textRef = useRef(null);

  // The session can end under the confirm step — the timer runs out while the
  // user is still deciding. Without this the NEXT lock opens on "Unlock early?".
  // A scene that failed gets another try on the next lock.
  useEffect(() => { if (!endsAt) { setConfirming(false); setSceneFailed(false); } }, [endsAt]);

  const withScene = !!endsAt && FOCUS_SCENES.includes(scene) && !sceneFailed;

  const remaining = formatRemaining(remainingMs({ endsAt, now }));

  const unlock = () => {
    const time = remaining;
    const count = durationMin;
    abandon();
    setConfirming(false);
    setEarly({ count, time });
  };

  const confirmBody = (
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
  );

  return (
    <>
      <Dialog
        open={!!endsAt}
        dismissable={false}
        size="full"
        z={Z.alert}
        portal
        panelBg={withScene ? 'bg-transparent' : undefined}
        panelBorder={withScene ? 'border-transparent' : undefined}
        panelClassName={withScene ? 'overflow-hidden' : 'flex flex-col items-center justify-center gap-6 text-center'}
        aria-label={t('focus.lockedTitle')}
        data-testid="focus-lock"
        data-capture-exclude=""
        /* The a11y hook leaves Escape alone when there is no close handler, so
           the confirm step has to peel itself back. */
        onKeyDown={e => {
          if (confirming && e.key === 'Escape') {
            e.stopPropagation();
            setConfirming(false);
          }
        }}
      >
        {withScene ? (
          <>
            <FocusScene
              scene={scene}
              startedAt={endsAt - durationMin * 60_000}
              endsAt={endsAt}
              textRef={textRef}
              onUnavailable={() => setSceneFailed(true)}
            />
            <div ref={textRef} className="focus-scene-text">
              <h1>{t('focus.lockedTitle')}</h1>
              <p className="focus-scene-time" data-testid="focus-remaining">{remaining}</p>
              <p className="focus-scene-sub">{t('focus.backAt', { time: formatTime(endsAt) })}</p>
              {held.length > 0 && (
                <p className="focus-scene-sub" data-testid="focus-held">
                  {t('focus.heldCount', { count: held.length })}
                </p>
              )}
              {/* Hidden, never removed: dropping it shrinks the text block, and the
                  scene insets itself from that block, so the diorama would jump up. */}
              <button
                type="button"
                className="focus-scene-link"
                style={confirming ? { visibility: 'hidden' } : undefined}
                onClick={() => setConfirming(true)}
                data-testid="focus-unlock-early"
              >
                {t('focus.unlockEarly')}
              </button>
            </div>
            {confirming && (
              <div className="absolute inset-0 flex items-center justify-center p-4">
                <div className="w-full max-w-sm rounded-2xl border border-mail-border bg-mail-bg p-6 flex flex-col items-center gap-4 text-center">
                  {confirmBody}
                </div>
              </div>
            )}
          </>
        ) : confirming ? confirmBody : (
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

      {/* Renders once the overlay is gone: the one cheeky surface in the app. */}
      <Dialog
        open={!!early}
        onClose={() => setEarly(null)}
        role="alertdialog"
        size="sm"
        portal
        title={t('focus.earlyTitle')}
        description={early && t('focus.earlyBody', early)}
        data-testid="focus-early"
        footer={
          <Button variant="primary" size="lg" fullWidth data-autofocus onClick={() => setEarly(null)}>
            {t('focus.earlyDismiss')}
          </Button>
        }
      />
    </>
  );
}
