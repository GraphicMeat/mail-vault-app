import React, { useState } from 'react';
import { Timer } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';
import { useFocusStore } from '../stores/focusStore';

const PRESETS = [15, 25, 45, 60];

/**
 * The sidebar footer row that starts a session. Mounted twice — collapsed rail
 * and expanded footer — because the footer has two shapes, not because it has
 * two behaviours.
 *
 * Idle only: a running session covers the whole window, and this sidebar is
 * behind it, so there is no countdown state to draw here.
 */
export function FocusTimerButton({ collapsed }) {
  const t = useT();
  const durationMin = useFocusStore(s => s.durationMin);
  const start = useFocusStore(s => s.start);

  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(durationMin);

  /* Read the remembered preset when the dialog OPENS, not at mount: persist
     hydration is async, so a sidebar mounted before it would offer the
     defaults instead of what the user last chose. */
  const openDialog = () => {
    setMinutes(useFocusStore.getState().durationMin);
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
        footer={
          <Button
            variant="primary" size="lg" fullWidth
            onClick={() => { start(minutes); setOpen(false); }}
            data-testid="focus-start"
          >
            {t('bulk.ops.start')}
          </Button>
        }
      >
        <div className="flex gap-2">
          {PRESETS.map(n => (
            <Button
              key={n}
              variant={n === minutes ? 'accentTint' : 'secondary'}
              size="sm"
              className="flex-1"
              aria-pressed={n === minutes}
              onClick={() => setMinutes(n)}
              data-testid={`focus-preset-${n}`}
            >
              {t('focus.min', { n })}
            </Button>
          ))}
        </div>
        {/* Start covers the window with no warning otherwise. */}
        <p className="text-xs text-mail-text-muted">{t('focus.startHint')}</p>
      </Dialog>
    </>
  );
}
