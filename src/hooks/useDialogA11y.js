import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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

  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    if (!panel) return;

    restoreRef.current = document.activeElement;
    const initial = panel.querySelector('[data-autofocus]') || panel.querySelector(FOCUSABLE);
    initial?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose?.();
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
      const restore = restoreRef.current;
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [isOpen, onClose]);

  return panelRef;
}
