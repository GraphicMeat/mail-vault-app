import { t } from '../i18n/index.js';
/**
 * Decide what Escape means, given what is currently on screen.
 *
 * Extracted so this is testable: t('util.escapeAction.appJsx') has no render tests, and the
 * ordering here is load-bearing. The global shortcut and the bulk modal's own
 * handler both listen on `window` in the bubble phase, and `App` mounts first —
 * so the global one runs first and must not act on state the modal is about to
 * handle itself.
 *
 * Returns the action to perform, never performs it.
 */
export function resolveEscapeAction({
  bulkModalOpen = false,
  bulkSessionActive = false,
  selectedCount = 0,
  composeOpen = false,
  settingsOpen = false,
  shortcutsOpen = false,
} = {}) {
  // The bulk modal minimizes on Escape and deliberately keeps its session and
  // selection. Clearing the selection here would destroy exactly what that
  // gesture promises — the bug this ordering was written for.
  if (bulkModalOpen) return 'none';

  // A minimized session still owns the selection it is counting. Escape
  // dismisses the whole session, matching the bubble's ×, rather than leaving
  // a bubble reading "0 selected".
  if (bulkSessionActive) return 'end-bulk-session';

  if (selectedCount > 0) return 'clear-selection';
  if (composeOpen) return 'close-compose';
  if (settingsOpen) return 'close-settings';
  if (shortcutsOpen) return 'close-shortcuts';
  return 'none';
}

/**
 * True when Escape is meant for a text field or an open dialog (the Contacts
 * details form, its merge dialog), not for the full page behind them.
 */
export function escapeBelongsToField(el, doc = typeof document === 'undefined' ? null : document) {
  if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return true;
  return !!doc && [...doc.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(dialog =>
    !dialog.closest('[hidden], [inert], [aria-hidden="true"]'));
}
