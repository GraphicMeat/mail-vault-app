import React, { useId } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import { Z } from './layers';

/**
 * The app's modal dialog.
 *
 * Fourteen modals used to hand-roll this: six different shells, four scrim
 * opacities, four z values, three corner radii — and of the fourteen, three
 * carried `aria-modal` and two trapped focus. A dialog that does not trap
 * focus lets Tab walk into the 17,000-row list underneath it, which is how a
 * confirmation for "delete from server" ends up with the keyboard somewhere
 * else. That behaviour now lives in one place.
 *
 * Depth is scrim and hairline, never shadow (DESIGN.md, The No-Shadow Rule):
 * the app goes behind glass, the panel sits on the ground colour with a 1px
 * border.
 *
 * @param {boolean} open
 * @param {Function} onClose            backdrop click, Escape, and the X
 * @param {string}   [title]            renders the header and the close button
 * @param {React.ReactNode} [description] sets `aria-describedby`
 * @param {React.ReactNode} [icon]      leading element in the header
 * @param {React.ReactNode} [footer]    action row, laid out by the caller
 * @param {'sm'|'md'|'lg'|'xl'|'full'} [size='md']
 * @param {'dialog'|'alertdialog'} [role='dialog']
 * @param {boolean}  [dismissable=true] false while an operation is in flight
 * @param {boolean}  [padded]          padding and the 8px content rhythm.
 *                                     Defaults to true for the sized dialogs
 *                                     and false for `full`/`custom`, which own
 *                                     their whole layout
 * @param {string}   [panelBg='bg-mail-bg'] the panel's ink step
 * @param {string}   [panelBorder]     a hairline other than `--mail-border`,
 *                                     for a dialog whose whole point is alarm
 * @param {boolean}  [portal=false]    render into `<body>` — for a dialog
 *                                     raised from inside a clipped or
 *                                     transformed subtree
 * @param {string}   [z]                a level from `./layers`, not a number
 */

const SIZES = {
  sm: 'w-full max-w-sm',
  md: 'w-full max-w-md',
  lg: 'w-full max-w-lg',
  xl: 'w-full max-w-2xl',
  full: 'w-full h-full',
  /* The caller sizes the panel itself, via panelClassName — for a working
     surface (Settings, an account form) that is a dialog by behaviour but a
     window by shape. */
  custom: '',
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  footer,
  size = 'md',
  role = 'dialog',
  dismissable = true,
  padded,
  portal = false,
  panelBg = 'bg-mail-bg',
  panelBorder = 'border-mail-border',
  closeLabel = 'Close',
  z = Z.dialog,
  className = '',
  panelClassName = '',
  children,
  ...rest
}) {
  const titleId = useId();
  const descId = useId();
  const dismiss = dismissable ? onClose : undefined;
  const panelRef = useDialogA11y(open, dismiss);

  if (!open) return null;

  const isFull = size === 'full' || size === 'custom';
  // A caller-sized panel lays itself out (Settings is a flex row, the full
  // reader is a flex column); wrapping its children in a padded, spaced box
  // collapses that layout into one column taller than the panel.
  const isPadded = padded ?? !isFull;

  const dialog = (
    <AnimatePresence>
      <div
        className={`fixed inset-0 ${z} flex items-center justify-center ${isFull ? '' : 'p-4'} ${className}`}
        onClick={dismiss}
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          aria-hidden="true"
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        />

        <motion.div
          ref={panelRef}
          role={role}
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-describedby={description ? descId : undefined}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          /* A sized panel never outgrows the window: it stops at the
             container's padding and scrolls, instead of losing its footer
             below the bottom edge on a short window. */
          className={`relative ${SIZES[size]} ${isFull ? '' : `max-w-[92vw] max-h-full overflow-y-auto rounded-2xl ${isPadded ? 'p-6' : ''}`} ${panelBg} border ${panelBorder} ${panelClassName}`}
          onClick={e => e.stopPropagation()}
          {...rest}
        >
          {title && (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={!dismissable}
                aria-label={closeLabel}
                className="absolute top-4 right-4 p-1 rounded-lg text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover transition-colors disabled:opacity-50"
              >
                <X size={18} />
              </button>

              <div className="flex items-center gap-3 mb-4">
                {icon}
                <h3 id={titleId} className="text-lg font-semibold text-mail-text pr-8">{title}</h3>
              </div>
            </>
          )}

          {(description || children) && (
            /* A padded dialog stacks its own content on the 8px rhythm; an
               unpadded one draws flush bands and must not get gaps between
               them. */
            <div className={isPadded ? 'space-y-4' : 'contents'}>
              {description && (
                <div id={descId} className="text-sm text-mail-text-muted">
                  {typeof description === 'string' ? <p>{description}</p> : description}
                </div>
              )}
              {children}
            </div>
          )}

          {footer && <div className="flex gap-3 mt-6">{footer}</div>}
        </motion.div>
      </div>
    </AnimatePresence>
  );

  return portal ? createPortal(dialog, document.body) : dialog;
}
