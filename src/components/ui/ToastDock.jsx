import React, { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Z } from './layers';

/**
 * Where banners and toasts live, so two of them can never share a spot.
 *
 * Every bottom-pinned banner used to carry its own `fixed bottom-… z-…`, and
 * two that were up together (a selection bar and an undo toast, a backup chip
 * and a restore bubble) were painted on top of each other. The dock is one
 * stack for the whole bottom edge and one for the top: a slot joins it, and a
 * slot added later lands above the ones already there. A slot's `position`
 * only picks its horizontal alignment inside the stack.
 *
 * `order` ranks slots from the bottom up (lower sits lower); equal orders go in
 * arrival order. A slot with no host mounted (a test, a secondary window)
 * pins itself like the old fixed element did.
 */
const EDGE = {
  'bottom-left': 'bottom',
  'bottom-center': 'bottom',
  'bottom-right': 'bottom',
  'top-right': 'top',
};

const ALIGN = {
  'bottom-left': 'self-start',
  'bottom-center': 'self-center',
  'bottom-right': 'self-end',
  'top-right': 'self-end',
};

const STACK = {
  bottom: 'bottom-4 sm:bottom-6 flex-col-reverse',
  top: 'top-4 flex-col',
};

const STACK_CLASS = `fixed inset-x-4 sm:inset-x-6 ${Z.toast} flex gap-2 pointer-events-none`;

/** The default rank: above the selection bar (0) and the bulk bubble (1). */
export const DOCK_ORDER = 2;

const hosts = { bottom: null, top: null };
const listeners = new Set();
let version = 0;

function setHost(edge, el) {
  if (hosts[edge] === el) return;
  hosts[edge] = el;
  version += 1;
  listeners.forEach((l) => l());
}

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const getVersion = () => version;

/** Mount once, in the app root: the two stacks every slot portals into. */
export function ToastDockHost() {
  return (
    <>
      {['bottom', 'top'].map((edge) => (
        <div
          key={edge}
          ref={(el) => setHost(edge, el)}
          data-toast-dock={edge}
          className={`${STACK_CLASS} ${STACK[edge]}`}
        />
      ))}
    </>
  );
}

/**
 * One banner's place in the stack. Pointer events pass through the stack, so a
 * slot's own element opts back in with `pointer-events-auto`.
 *
 * @param {'bottom-left'|'bottom-center'|'bottom-right'|'top-right'} position
 * @param {number} [order]  rank from the bottom up
 * @param {boolean} [fill]  span the whole stack width instead of aligning
 */
export function DockSlot({ position = 'bottom-right', order = DOCK_ORDER, fill = false, children }) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const edge = EDGE[position];
  const host = hosts[edge];
  const slot = (
    <div style={{ order }} className={fill ? 'self-stretch' : ALIGN[position]}>
      {children}
    </div>
  );
  if (!host) return <div className={`${STACK_CLASS} ${STACK[edge]}`}>{slot}</div>;
  return createPortal(slot, host);
}
