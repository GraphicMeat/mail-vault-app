// The checkbox column of a selecting list: a strip down the leading edge of the rows. A tap on it
// toggles the row; a drag down (or up) sweeps, ticking every row it passes if it began on an
// unticked one and unticking if on a ticked one. The strip takes the touch (`touch-action: none`),
// so the list scrolls from anywhere else. Rows are read from the page cache by index; only rows
// that have loaded can be ticked. Not rendered per row: one strip over the whole list.
import React, { useRef } from 'react';
import { useMobileStore } from '../store.js';
import { selectionKey, useSelection } from './selectionStore.js';
import { rowIndexAt, span, sweepMode } from './sweep.js';

export default function SweepColumn({ cache, height }) {
  const strip = useRef(null);
  const drag = useRef(null);
  const entryAt = (index) => {
    const row = cache.rowAt(index);
    if (!row) return null;
    return { row, place: useMobileStore.getState().placeOf(row) };
  };
  const indexOf = (e) => rowIndexAt(e.clientY, strip.current.getBoundingClientRect().top, height, cache.total ?? 0);
  const apply = (from, to, on) => {
    const entries = span(from, to).map(entryAt).filter(Boolean);
    useSelection.getState().setMany(entries, on);
  };
  const down = (e) => {
    if (e.button > 0 || e.isPrimary === false) return;
    const index = indexOf(e);
    const entry = index < 0 ? null : entryAt(index);
    if (!entry) return;
    const ticked = useSelection.getState().items.has(selectionKey(entry.place, entry.row.uid));
    drag.current = { id: e.pointerId, from: index, last: index, on: sweepMode(ticked) };
    try { strip.current.setPointerCapture?.(e.pointerId); } catch { /* fine without */ }
    apply(index, index, drag.current.on);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const index = indexOf(e);
    if (index < 0 || index === d.last) return;
    // Only the rows between the last row and this one are new.
    apply(d.last, index, d.on);
    d.last = index;
  };
  const end = (e) => { if (drag.current?.id === e.pointerId) drag.current = null; };
  return (
    <div
      ref={strip}
      className="mv-checkcol"
      data-mv-checkcol
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
