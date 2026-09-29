import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { Popover } from './Popover';

const WIDTH = 320;
const GAP = 6;
const MARGIN = 8;

/**
 * A small "i" button that opens a panel of explanation beside a setting.
 *
 * The button names itself with `label` (also the panel's accessible name).
 * Escape and a click outside close it through ui/Popover, and focus goes into
 * the panel on open and back to the button on close, so a keyboard user is
 * never dropped at the top of the page.
 *
 * @param {string} label   accessible name of the button and the panel
 * @param {string} [title] visible heading of the panel (defaults to `label`)
 */
export function InfoPopover({ label, title, children, className = '', ...rest }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: MARGIN });
  const buttonRef = useRef(null);
  const panelRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) { close(); return; }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(MARGIN, Math.min(rect.right - WIDTH, window.innerWidth - WIDTH - MARGIN));
      setPos({ top: rect.bottom + GAP, left });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={toggle}
        className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover transition-colors ${className}`}
        {...rest}
      >
        <Info size={15} aria-hidden="true" />
      </button>
      <Popover
        open={open}
        onClose={close}
        variant="panel"
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        ref={panelRef}
        className="outline-none text-sm text-mail-text shadow-xl"
        style={{ top: pos.top, left: pos.left, width: `min(${WIDTH}px, calc(100vw - ${MARGIN * 2}px))` }}
      >
        <div className="text-sm font-semibold text-mail-text mb-2">{title || label}</div>
        {children}
      </Popover>
    </>
  );
}
