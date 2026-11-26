// Drags a list row sideways the way a finger does (SwipeRow.jsx): down, a move past the slop, the
// move to the end point, up. A row at rest has no swipe action in the DOM, so a test that clicks
// one opens the row first with `revealSide`.
import { fireEvent } from '@testing-library/react';

/** Drags `el` by `dx` px; `release: false` leaves the finger down. */
export function dragRow(el, dx, { release = true } = {}) {
  const from = 20;
  fireEvent.pointerDown(el, { pointerId: 1, clientX: from, clientY: 20, button: 0, isPrimary: true });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: from + Math.sign(dx) * 20, clientY: 21, isPrimary: true });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: from + dx, clientY: 22, isPrimary: true });
  if (release) fireEvent.pointerUp(el, { pointerId: 1, clientX: from + dx, clientY: 22, isPrimary: true });
}

/** Opens the row in `scope` on `side` (left-to-right layout) and returns that side's action. */
export function revealSide(scope, side) {
  const row = scope.matches?.('.mv-row') ? scope : scope.querySelector('.mv-row');
  dragRow(row, side === 'leading' ? 60 : -60);
  return (row.closest('.mv-swipe') || scope).querySelector(`[data-mv-swipe-action="${side}"]`);
}
