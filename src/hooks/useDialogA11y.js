import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Dialogs stack: a settings modal can open a confirmation over itself. Every
// instance listens on document in the capture phase, and same-element listeners
// all fire regardless of stopPropagation — so without this, Escape would close
// the whole stack at once and the outer Tab trap would yank focus back out of
// the inner dialog. Only the top of the stack handles keys.
const openDialogs = [];

/**
 * Keyboard and focus behaviour for a modal dialog.
 *
 * Returns a ref to put on the dialog panel. While `isOpen`:
 *
 * - focus moves into the dialog (the element marked `data-autofocus`, else the
 *   first focusable one), and returns to whatever had it when the dialog closes;
 * - Tab and Shift+Tab cycle inside the dialog instead of walking the list behind it;
 * - Escape closes it.
 *
 * `onClose` is read through a ref, so an inline arrow at the call site does not
 * re-run the effect — otherwise every keystroke in a form dialog would re-enter
 * it and throw focus back to the first field.
 *
 * Nested dialogs stack: while an inner dialog is open the outer one ignores
 * Tab and Escape, so Escape peels one layer at a time.
 *
 * The Escape listener is on `document` in the **capture** phase and calls
 * `stopPropagation`. `App.jsx` has a global Escape shortcut on `window` in the
 * bubble phase, and window-bubble is the last stop in the event path — so
 * without capture, opening a delete confirmation and pressing Escape would run
 * the global handler and clear the selection instead of closing the dialog.
 * Capture on `document` (not `window`) is narrow enough to leave inputs alone.
 * See src/utils/escapeAction.js for the rest of that ordering.
 */
export function useDialogA11y(isOpen, onClose) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    if (!panel) return;

    const token = {};
    openDialogs.push(token);
    restoreRef.current = document.activeElement;
    const initial = panel.querySelector('[data-autofocus]') || panel.querySelector(FOCUSABLE);
    initial?.focus();

    const onKeyDown = (e) => {
      if (openDialogs[openDialogs.length - 1] !== token) return;
      // No close handler means the caller owns Escape (compose minimizes, an
      // update mid-download refuses to close). Leave the key alone entirely.
      if (e.key === 'Escape' && closeRef.current) {
        e.stopPropagation();
        e.preventDefault();
        closeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = [...panel.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      // A dialog opened by a click can leave focus outside it; pull it back
      // rather than letting Tab walk into the message list underneath.
      if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const at = openDialogs.indexOf(token);
      if (at !== -1) openDialogs.splice(at, 1);
      const restore = restoreRef.current;
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [isOpen]);

  return panelRef;
}
