import { useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Actions that should still fire when the user is focused on an
 * input / textarea / contenteditable element.
 */
const ALLOWED_IN_INPUT = new Set(['escape', 'focusSearch']);

/**
 * Returns true when the active element is a text-input control.
 */
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * Normalise a KeyboardEvent into the string format used by the shortcuts config.
 * Modifier keys are prefixed in a fixed order: Meta+Ctrl+Alt+Shift+<key>
 */
function eventToKeyString(e) {
  const parts = [];
  if (e.metaKey) parts.push('Meta');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && e.key.length > 1) parts.push('Shift'); // only explicit Shift for named keys

  let key = e.key;
  // Normalise common key names
  if (key === ' ') key = 'Space';

  parts.push(key);
  return parts.join('+');
}

/**
 * Build a lookup table from keybinding string -> action name.
 * Supports both single keys ("j") and multi-key sequences ("g i").
 *
 * For sequences like "g i", the map contains:
 *   "g" -> { _isPrefix: true }
 *   "g i" -> "goToInbox"
 */
function buildShortcutMap(shortcuts) {
  const map = {};
  for (const [action, keybinding] of Object.entries(shortcuts)) {
    if (!keybinding) continue;
    map[keybinding] = action;

    // If this is a multi-key sequence, register prefix entries
    const parts = keybinding.split(' ');
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join(' ');
        if (!map[prefix] || map[prefix]._isPrefix) {
          map[prefix] = { _isPrefix: true };
        }
      }
    }
  }
  return map;
}

const SEQUENCE_TIMEOUT = 500; // ms to wait for next key in a sequence

/**
 * React hook that listens for keyboard shortcuts and dispatches actions.
 *
 * @param {Object} actionHandlers - Map of action name -> callback function
 *   e.g. { compose: () => openModal(), reply: () => handleReply() }
 */
export function useKeyboardShortcuts(actionHandlers) {
  const shortcuts = useSettingsStore((s) => s.keyboardShortcuts);
  const enabled = useSettingsStore((s) => s.keyboardShortcutsEnabled);

  // Keep handlers in a ref so the effect closure never goes stale
  const handlersRef = useRef(actionHandlers);
  handlersRef.current = actionHandlers;

  // Sequence tracking refs
  const sequenceRef = useRef('');      // current accumulated key sequence
  const sequenceTimerRef = useRef(null);

  const resetSequence = useCallback(() => {
    sequenceRef.current = '';
    if (sequenceTimerRef.current) {
      clearTimeout(sequenceTimerRef.current);
      sequenceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const shortcutMap = buildShortcutMap(shortcuts);

    const handleKeyDown = (e) => {
      // Ignore bare modifier presses
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

      const keyStr = eventToKeyString(e);
      const typing = isTypingTarget(e.target);

      // Build the candidate sequence string
      const candidate = sequenceRef.current
        ? `${sequenceRef.current} ${keyStr}`
        : keyStr;

      // Check if candidate is a prefix of a longer sequence
      const prefixEntry = shortcutMap[candidate];
      if (prefixEntry && prefixEntry._isPrefix && !typing) {
        // Start / continue sequence — wait for next key
        sequenceRef.current = candidate;
        if (sequenceTimerRef.current) clearTimeout(sequenceTimerRef.current);
        sequenceTimerRef.current = setTimeout(resetSequence, SEQUENCE_TIMEOUT);
        e.preventDefault();
        return;
      }

      // Check for an exact match (full sequence or single key)
      const action = shortcutMap[candidate];
      if (action && typeof action === 'string') {
        resetSequence();

        // Block most shortcuts when typing in an input
        if (typing && !ALLOWED_IN_INPUT.has(action)) return;

        const handler = handlersRef.current[action];
        if (handler) {
          e.preventDefault();
          handler();
        }
        return;
      }

      // No match on the accumulated sequence — try the key alone
      // (handles case where user presses an unrelated key mid-sequence)
      if (sequenceRef.current) {
        resetSequence();

        // Check single-key match
        const singlePrefix = shortcutMap[keyStr];
        if (singlePrefix && singlePrefix._isPrefix && !typing) {
          sequenceRef.current = keyStr;
          sequenceTimerRef.current = setTimeout(resetSequence, SEQUENCE_TIMEOUT);
          e.preventDefault();
          return;
        }

        const singleAction = shortcutMap[keyStr];
        if (singleAction && typeof singleAction === 'string') {
          if (typing && !ALLOWED_IN_INPUT.has(singleAction)) return;
          const handler = handlersRef.current[singleAction];
          if (handler) {
            e.preventDefault();
            handler();
          }
          return;
        }
      }

      // Nothing matched — reset
      resetSequence();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      resetSequence();
    };
  }, [shortcuts, enabled, resetSequence]);
}
