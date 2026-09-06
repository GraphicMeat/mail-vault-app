import React, { useState } from 'react';
import { Timer } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { PremiumFeaturesLink } from './PremiumFeaturesLink';
import { useT } from '../i18n/index.js';
import { useFocusStore } from '../stores/focusStore';
import { hasPremiumAccess, useSettingsStore } from '../stores/settingsStore';

const PRESETS = [15, 25, 45, 60];
const MAX_MIN = 480;

/* The app's input class minus `w-full`: both widths live in Tailwind's width
   group, so keeping it would leave the winner to stylesheet order. */
const INPUT_CLASS = 'w-20 px-2 py-1.5 bg-mail-bg border border-mail-border rounded-lg '
  + 'text-sm text-mail-text text-right tabular-nums focus:outline-none focus:border-mail-accent';

/**
 * The sidebar footer row that starts a session. Mounted twice, collapsed rail
 * and expanded footer, because the footer has two shapes, not because it has
 * two behaviours.
 *
 * Idle only: a running session covers the whole window, and this sidebar is
 * behind it, so there is no countdown state to draw here.
 *
 * Starting a session is Premium; the session itself is not. A lock already
 * running when a subscription lapses still counts down, still holds
 * notifications and still unlocks early. Only this dialog gates.
 */
export function FocusTimerButton({ collapsed, onUpgrade }) {
  const t = useT();
  const durationMin = useFocusStore(s => s.durationMin);
  const start = useFocusStore(s => s.start);
  const isPremium = hasPremiumAccess(useSettingsStore(s => s.billingProfile));

  const [open, setOpen] = useState(false);
  /* The raw field text, not a number. Clearing the box to retype leaves it
     empty for a keystroke or two, and a number state would snap a 0 back
     under the cursor. `minutes` is derived, and is the one source of truth
     for both the chips and Start. */
  const [draft, setDraft] = useState(String(durationMin));

  const minutes = /^\d+$/.test(draft) ? Number(draft) : NaN;
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_MIN;

  /* With no preset checked the whole group would fall out of the tab order if
     every chip kept -1, so the first one holds it instead. */
  const tabbable = PRESETS.includes(minutes) ? minutes : PRESETS[0];

  /* Read the remembered duration when the dialog OPENS, not at mount: persist
     hydration is async, so a sidebar mounted before it would offer the
     defaults instead of what the user last chose. */
  const openDialog = () => {
    setDraft(String(useFocusStore.getState().durationMin));
    setOpen(true);
  };

  return (
    <>
      {collapsed ? (
        <Button
          variant="ghost" icon size="sm"
          onClick={openDialog}
          title={t('focus.title')}
          data-testid="focus-button"
        >
          <Timer size={15} className="text-mail-text-muted" />
        </Button>
      ) : (
        <Button
          variant="ghost" fullWidth size="xs" className="justify-start"
          onClick={openDialog}
          title={t('focus.title')}
          data-testid="focus-button"
        >
          <Timer size={14} />
          {t('focus.title')}
        </Button>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        portal
        title={t('focus.title')}
        icon={<Timer size={20} className="text-mail-accent-text" />}
        data-testid="focus-dialog"
        footer={isPremium ? (
          <Button
            variant="primary" size="lg" fullWidth
            disabled={!valid}
            onClick={() => { start(minutes); setOpen(false); }}
            data-testid="focus-start"
          >
            {t('bulk.ops.start')}
          </Button>
        ) : null}
      >
        {!isPremium ? (
          <>
            <p className="text-sm text-mail-text-muted" data-testid="focus-upsell">
              {t('focus.upsell')}
            </p>
            <div className="flex flex-col gap-2">
              <Button
                variant="primary" size="lg" fullWidth
                onClick={() => { setOpen(false); onUpgrade?.(); }}
              >
                {t('common.upgrade')}
              </Button>
              <PremiumFeaturesLink className="self-center mt-1" />
            </div>
          </>
        ) : (
          <>
            {/* ponytail: click and Tab, no arrow-key roving. Four chips sitting
                next to the number input that answers the same question are
                reachable without it. */}
            <div className="flex gap-2" role="radiogroup" aria-label={t('focus.title')}>
              {PRESETS.map(n => (
                <Button
                  key={n}
                  variant={n === minutes ? 'accentTint' : 'secondary'}
                  size="sm"
                  /* The tint alone lost to the raised bordered chips beside it
                     on the dark theme: the freshly DEselected preset read as
                     the chosen one. Same geometry, accent border on top. */
                  className={n === minutes ? 'flex-1 border border-mail-accent' : 'flex-1'}
                  role="radio"
                  aria-checked={n === minutes}
                  tabIndex={n === tabbable ? 0 : -1}
                  onClick={() => setDraft(String(n))}
                  data-testid={`focus-preset-${n}`}
                >
                  {t('focus.min', { n })}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-mail-text">
                {t('focus.custom')}
                <input
                  type="number"
                  min={1}
                  max={MAX_MIN}
                  step={1}
                  inputMode="numeric"
                  className={INPUT_CLASS}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  data-testid="focus-custom"
                />
              </label>
              <span className="text-sm text-mail-text-muted">{t('focus.minutesUnit')}</span>
            </div>
            {/* Start covers the window with no warning otherwise. */}
            <p className="text-xs text-mail-text-muted">{t('focus.startHint')}</p>
          </>
        )}
      </Dialog>
    </>
  );
}
