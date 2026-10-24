import React from 'react';
import { motion } from 'framer-motion';
import { DockSlot } from './ToastDock';

/**
 * The card a transient message lives in.
 *
 * Five toasts (send undo, backup, migration, keychain, the generic one) each
 * carried their own pinned-corner class string, with the corner and the
 * entrance direction copied by hand. The shell owns position, entrance, stacking and chrome; the toast
 * owns its content.
 *
 * Entrance comes from the edge the toast is pinned to, so a bottom-left toast
 * does not slide in from the right.
 *
 * @param {'bottom-left'|'bottom-right'|'bottom-center'|'top-right'} [position]
 * @param {boolean} [bare]  skip the card chrome — for a toast that draws its own
 */
const ENTRANCE = {
  'bottom-left': { y: 20 },
  'bottom-right': { y: 20 },
  'bottom-center': { y: 20 },
  'top-right': { y: -20 },
};

export function ToastShell({
  position = 'bottom-right',
  bare = false,
  role = 'status',
  className = '',
  children,
  ...rest
}) {
  const from = ENTRANCE[position];
  return (
    <DockSlot position={position}>
      <motion.div
        initial={{ opacity: 0, ...from }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, ...from }}
        transition={{ duration: 0.2 }}
        role={role}
        aria-live={role === 'status' ? 'polite' : undefined}
        className={`pointer-events-auto ${bare ? '' : 'bg-mail-surface border border-mail-border rounded-xl p-2'} ${className}`}
        /* Kept out of a social export's app-window capture. */
        data-capture-exclude=""
        {...rest}
      >
        {children}
      </motion.div>
    </DockSlot>
  );
}
