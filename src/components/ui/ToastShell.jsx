import React from 'react';
import { motion } from 'framer-motion';
import { Z } from './layers';

/**
 * The card a transient message lives in.
 *
 * Five toasts (send undo, backup, migration, keychain, the generic one) each
 * carried their own `fixed bottom-… z-[60] bg-mail-surface border rounded-xl
 * shadow-lg` string, with the corner and the entrance direction copied by
 * hand. The shell owns position, entrance, stacking and chrome; the toast
 * owns its content.
 *
 * Entrance comes from the edge the toast is pinned to, so a bottom-left toast
 * does not slide in from the right.
 *
 * @param {'bottom-left'|'bottom-right'|'bottom-center'|'top-right'} [position]
 * @param {boolean} [bare]  skip the card chrome — for a toast that draws its own
 */
const POSITIONS = {
  'bottom-left': 'bottom-6 left-6',
  'bottom-right': 'bottom-6 right-6',
  'bottom-center': 'bottom-6 left-1/2',
  'top-right': 'top-4 right-4',
};

/* A centered toast is held on the midline by a transform, and framer-motion
 * owns transform while it animates — so the -50% has to travel in the motion
 * props, not in a `-translate-x-1/2` class it would overwrite. */
const ENTRANCE = {
  'bottom-left': { y: 20 },
  'bottom-right': { y: 20 },
  'bottom-center': { y: 20, x: '-50%' },
  'top-right': { y: -20 },
};

const RESTING = { 'bottom-center': { y: 0, x: '-50%' } };

export function ToastShell({
  position = 'bottom-right',
  bare = false,
  role = 'status',
  className = '',
  children,
  ...rest
}) {
  const from = ENTRANCE[position];
  const to = RESTING[position] ?? { y: 0 };
  return (
    <motion.div
      initial={{ opacity: 0, ...from }}
      animate={{ opacity: 1, ...to }}
      exit={{ opacity: 0, ...from }}
      transition={{ duration: 0.2 }}
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      className={`fixed ${POSITIONS[position]} ${Z.toast} ${bare ? '' : 'bg-mail-surface border border-mail-border rounded-xl p-2'} ${className}`}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
