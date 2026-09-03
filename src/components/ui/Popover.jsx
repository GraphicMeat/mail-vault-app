import React, { forwardRef, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useViewportShift } from '../../hooks/useViewportShift';
import { Z } from './layers';

/**
 * A floating panel anchored to something the caller has already measured.
 *
 * Five places grew their own version of this: portal to `<body>`, a fixed
 * panel, a way to close on an outside click, and a surface that drifted
 * between `bg-mail-bg`/`bg-mail-surface`, `rounded-lg`/`rounded-xl` and
 * `shadow-lg`/`shadow-xl`/`shadow-2xl`. The panel chrome and the closing
 * behaviour live here; the anchor maths stays with the caller, because a
 * row menu clamping to a viewport edge and a submenu opening beside its
 * parent are genuinely different sums.
 *
 * Outside clicks are caught by a transparent layer under the panel rather
 * than by a document listener, so the click that closes the popover does not
 * also land on the row behind it.
 *
 * Whatever the caller's sum says, the panel ends up inside the window: a menu
 * opened on the bottom row used to run off the bottom edge and the only way
 * to its last items was to scroll the list and try again.
 *
 * @param {boolean} open
 * @param {Function} onClose
 * @param {Object} [style]      position, from the caller's own measurement
 * @param {'menu'|'panel'} [variant='menu']
 * @param {string} [role]       'menu' for an action list, else omit
 */
const VARIANTS = {
  menu: 'bg-mail-bg border border-mail-border rounded-lg py-1 min-w-[160px]',
  panel: 'bg-mail-surface border border-mail-border rounded-xl p-4',
};

export const Popover = forwardRef(function Popover({
  open,
  onClose,
  style,
  variant = 'menu',
  role,
  className = '',
  children,
  ...rest
}, ref) {
  const panelRef = useRef(null);
  const setPanel = useCallback((node) => {
    panelRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  // Stays armed through the exit animation (the panel is still mounted then),
  // and re-runs when the caller moves the panel after measuring its anchor.
  useViewportShift(panelRef, true, [open, style?.top, style?.left, style?.right, style?.bottom]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose?.();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <div
            className={`fixed inset-0 ${Z.popover}`}
            onClick={(e) => { e.stopPropagation(); onClose?.(); }}
          />
          <motion.div
            ref={setPanel}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            role={role}
            className={`fixed ${Z.popover} ${VARIANTS[variant]} ${className}`}
            style={style}
            onClick={(e) => e.stopPropagation()}
            {...rest}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
});

/**
 * A row in a `variant="menu"` popover. `tone="danger"` for anything that
 * destroys something — the only colour a menu row is allowed to carry.
 */
export function MenuItem({ tone = 'default', className = '', children, ...rest }) {
  const color = tone === 'danger' ? 'text-mail-danger' : 'text-mail-text';
  return (
    <button
      type="button"
      role={rest.role ?? 'menuitem'}
      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-mail-surface-hover transition-colors disabled:opacity-50 ${color} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
