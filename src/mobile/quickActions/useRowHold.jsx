// Holding a message row opens the quick action wheel on it. Every list of message rows uses this:
// `const { hold, wheelNode } = useRowHold(wheel)`, `onHold={hold}` on its rows and `wheelNode` in
// its markup. Without `wheel` a row cannot be held (`hold` is null, `wheelNode` is null). The main
// list's `wheel` carries `onSelect`; a list that cannot select (search, a view, a conversation,
// the chat view) gets none, so its wheel has no Select wedge. `wheel` should be one stable object.
import React, { useCallback, useState } from 'react';
import { haptic } from '../haptics.js';
import RowWheel from './RowWheel.jsx';

export function useRowHold(wheel) {
  // The row the wheel is open on: `{ row, key, x, y }`.
  const [held, setHeld] = useState(null);
  const hold = useCallback((row, point) => {
    haptic.impact('medium');
    setHeld({ row, key: Date.now(), x: point.x, y: point.y });
  }, []);
  const close = useCallback(() => setHeld(null), []);
  return {
    hold: wheel ? hold : null,
    wheelNode: wheel ? <RowWheel target={held} onClose={close} {...wheel} /> : null,
  };
}
