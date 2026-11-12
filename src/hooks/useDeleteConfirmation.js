import { useCallback, useRef, useState } from 'react';
import { MESSAGE_ACTIONS } from '../utils/messageActions';

// The quick actions that raise a confirmation (the action table's `confirms`):
// the trigger is noted for them, so Cancel or Delete hands focus back to the
// button that asked.
export const CONFIRMING_ACTIONS = Object.freeze(Object.keys(MESSAGE_ACTIONS).filter(id => MESSAGE_ACTIONS[id].confirms));
// A reader's Archive on a message already archived is Unarchive, which asks.
export const READER_CONFIRMING_ACTIONS = Object.freeze([...CONFIRMING_ACTIONS, 'archive']);

const asIs = value => value;

/**
 * One surface's delete confirmation: the pending delete its
 * <DeleteConfirmModal> shows, and focus back to the trigger once it closes.
 *
 * - `request(pending)` raises it (`{ executor, copy, confirmOptional? }`, see
 *   DeleteConfirmModal); `dismiss()` drops it without moving focus (a view or
 *   message change).
 * - `onActionStart(event, trigger, entry)` is QuickActions' hook: for an entry
 *   in `actions` it keeps `capture(trigger)`.
 * - `modalProps` goes on the modal. Closing it (Cancel, Escape, or the delete
 *   itself) focuses `returnFocus(kept)` on the next frame.
 * - `onOpenChange(open)` hears every open and close (a chat bubble keeps its
 *   hover bar up while the confirm is open).
 * `actions`, `capture` and `returnFocus` are read once per render into stable
 * callbacks: pass module-level values.
 */
export function useDeleteConfirmation({ actions = CONFIRMING_ACTIONS, capture = asIs, returnFocus = asIs, onOpenChange } = {}) {
  const [pending, setPending] = useState(null);
  const kept = useRef(null);
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;

  const request = useCallback((next) => {
    openChange.current?.(!!next);
    setPending(next);
  }, []);
  const dismiss = useCallback(() => {
    openChange.current?.(false);
    setPending(null);
  }, []);
  const onActionStart = useCallback((event, trigger, entry) => {
    if (actions.includes(entry?.action)) kept.current = capture(trigger || event?.currentTarget);
  }, [actions, capture]);
  const onClose = useCallback(() => {
    dismiss();
    requestAnimationFrame(() => returnFocus(kept.current)?.focus?.());
  }, [dismiss, returnFocus]);

  return { pending, request, dismiss, onActionStart, modalProps: { pending, onClose } };
}
