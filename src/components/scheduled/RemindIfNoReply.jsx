import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/Button';
import { REMIND_DAYS } from '../../stores/followUpStore';

const LABEL = { 0: 'compose.remind.off', 1: 'compose.remind.days1', 3: 'compose.remind.days3', 7: 'compose.remind.days7' };

/**
 * Compose's "Remind me if no reply": a bell in the footer and a small menu,
 * Off / 1 day / 3 days / 1 week. Armed, the bell is lit and names the delay.
 * Without Premium the menu shows the upgrade instead of the choices, like
 * Send later. `isPremium` is asked only when it matters (armed, or the menu
 * open), so a window with nothing armed reads no billing state.
 */
export function RemindIfNoReply({ days, onChange, isPremium, onUpgrade, disabled }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Same outside-click and Escape handling as the templates dropdown: the
  // capture-phase Escape keeps the compose window open.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const armed = days > 0 && isPremium();
  const premium = open && isPremium();
  const pick = (value) => { onChange(value); setOpen(false); };

  return (
    <div className="relative" ref={ref}>
      <Button variant="ghost" icon={!armed} size={armed ? 'sm' : 'md'} type="button"
        data-testid="compose-remind-toggle"
        disabled={disabled}
        aria-pressed={armed}
        aria-expanded={open}
        aria-label={t('compose.remind.title')}
        title={t('compose.remind.title')}
        onClick={() => setOpen(v => !v)}
        className={`hover:bg-mail-border ${armed ? 'text-mail-accent-text min-h-9' : ''}`}
      >
        <Bell size={18} className={armed ? 'text-mail-accent-text' : 'text-mail-text-muted'} />
        {armed && <span data-testid="compose-remind-armed" className="text-xs">{t(LABEL[days] || LABEL[3])}</span>}
      </Button>
      {open && (
        <div data-testid="compose-remind-panel"
          className="absolute bottom-full -left-24 sm:left-0 mb-1 w-64 bg-mail-surface border border-mail-border rounded-lg z-50 overflow-hidden">
          <div className="px-3 pt-2 pb-1 text-sm font-medium text-mail-text">{t('compose.remind.title')}</div>
          {premium ? <>
            <div role="menu" aria-label={t('compose.remind.title')}>
              {[0, ...REMIND_DAYS].map(value => (
                <button key={value} type="button" role="menuitemradio" aria-checked={days === value}
                  data-testid={`compose-remind-option-${value}`}
                  onClick={() => pick(value)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-sm text-mail-text hover:bg-mail-surface-hover transition-colors">
                  {t(LABEL[value])}
                  {days === value && <Check size={14} className="text-mail-accent-text" aria-hidden="true" />}
                </button>
              ))}
            </div>
            <p className="px-3 py-2 text-xs text-mail-text-muted border-t border-mail-border">{t('compose.remind.hint')}</p>
          </> : (
            <div data-testid="compose-remind-locked" className="px-3 pb-3 space-y-2">
              <p className="text-xs text-mail-text">{t('compose.remind.upsell')}</p>
              <p className="text-xs text-mail-text-muted">{t('compose.remind.hint')}</p>
              <div className="flex justify-end pt-1">
                <button type="button" data-testid="compose-remind-upgrade" onClick={() => { setOpen(false); onUpgrade?.(); }}
                  className="px-3 py-1.5 text-sm bg-mail-accent-fill hover:bg-mail-accent-hover text-white font-medium rounded-lg transition-all">
                  {t('common.upgrade')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
