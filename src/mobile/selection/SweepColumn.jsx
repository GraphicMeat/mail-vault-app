// The checkbox column of a selecting list: a strip down the leading edge of the rows. A tap on it
// toggles the row; a drag down (or up) sweeps, ticking every row it passes if it began on an
// unticked one and unticking if on a ticked one. Dragging back over a row restores it to the state it
// had before the sweep reached it (iOS), so a sweep always covers exactly the rows between where it
// began and the finger. The strip takes the touch (`touch-action: none`),
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
  /**
   * The drag now covers `from` to `to`: those rows take the sweep's mode, and a row the drag left
   * (it went back over it) returns to what it was before the sweep reached it (`d.before`).
   */
  const cover = (d, to) => {
    const store = useSelection.getState();
    const covered = new Set(span(d.from, to));
    const restore = { on: [], off: [] };
    for (const [index, entry] of d.before.entries()) {
      if (covered.has(index)) continue;
      d.before.delete(index);
      (entry.wasTicked ? restore.on : restore.off).push(entry.entry);
    }
    if (restore.on.length) store.setMany(restore.on, true);
    if (restore.off.length) store.setMany(restore.off, false);
    const fresh = [];
    for (const index of covered) {
      if (d.before.has(index)) continue;
      const entry = entryAt(index);
      if (!entry) continue;
      d.before.set(index, { entry, wasTicked: store.items.has(selectionKey(entry.place, entry.row.uid)) });
      fresh.push(entry);
    }
    if (fresh.length) store.setMany(fresh, d.on);
  };
  const down = (e) => {
    if (e.button > 0 || e.isPrimary === false) return;
    const index = indexOf(e);
    const entry = index < 0 ? null : entryAt(index);
    if (!entry) return;
    const ticked = useSelection.getState().items.has(selectionKey(entry.place, entry.row.uid));
    drag.current = { id: e.pointerId, from: index, last: index, on: sweepMode(ticked), before: new Map() };
    try { strip.current.setPointerCapture?.(e.pointerId); } catch { /* fine without */ }
    cover(drag.current, index);
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const index = indexOf(e);
    if (index < 0 || index === d.last) return;
    cover(d, index);
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
