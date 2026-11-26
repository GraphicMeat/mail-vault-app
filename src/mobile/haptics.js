// Taps of feedback for the phone: the official haptics plugin (`tauri-plugin-haptics`, MIT or
// Apache-2.0), reached through the global bridge like the camera (scanner.js; seam.test.js lists
// the commands). Fire and forget: every call returns nothing, never throws and never rejects, and
// without the shell (web, tests) it does nothing, so a caller neither awaits nor guards it.
//
// What ticks, and with what (the tasks that own each place call it):
//   selection  a crossing or a pick: swipe passing its commit point, wheel wedge changing, select
//              toggle, switches and pickers
//   impact     light: pull past its trigger, Undo. medium: a swipe or long press committing. heavy: spare
//   notify     success: a send or bulk action done. error: a send or sign-in retry refused. warning: spare

const IMPACTS = ['light', 'medium', 'heavy'];
const NOTIFICATIONS = ['success', 'warning', 'error'];

function bridge() {
  return (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) || null;
}

/** Runs one plugin call, swallowing everything: a missing shell, a throw, a rejection. */
function fire(call) {
  const invoke = bridge();
  if (!invoke) return;
  try {
    Promise.resolve(call(invoke)).catch(() => {});
  } catch {
    /* no haptics engine: the tap is lost, nothing else */
  }
}

export const haptic = {
  /** A light tick for a crossing or a pick. */
  selection() {
    fire((invoke) => invoke('plugin:haptics|selection_feedback'));
  },
  /** A tap of weight `style` (`light`, `medium`, `heavy`; anything else is light). */
  impact(style = 'light') {
    const picked = IMPACTS.includes(style) ? style : 'light';
    fire((invoke) => invoke('plugin:haptics|impact_feedback', { style: picked }));
  },
  /** An outcome: `success`, `warning` or `error` (anything else is success). */
  notify(type = 'success') {
    const picked = NOTIFICATIONS.includes(type) ? type : 'success';
    fire((invoke) => invoke('plugin:haptics|notification_feedback', { type: picked }));
  },
};

/**
 * One tick for a tap on any switch (`role="switch"`) anywhere on the page, so the desktop's
 * settings controls the phone renders feel the same without a change to them. Capture phase,
 * passive; a disabled switch is silent. Returns the function that stops it.
 */
export function watchSwitchHaptics() {
  if (typeof document === 'undefined') return () => {};
  const onClick = (e) => {
    const sw = e.target?.closest?.('[role="switch"]');
    if (!sw || sw.disabled || sw.getAttribute('aria-disabled') === 'true') return;
    haptic.selection();
  };
  document.addEventListener('click', onClick, { capture: true, passive: true });
  return () => document.removeEventListener('click', onClick, { capture: true });
}
