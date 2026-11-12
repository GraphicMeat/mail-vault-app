import { useCallback, useEffect, useMemo, useRef } from 'react';

// The row-appear fade in index.css, plus a frame.
const ROW_APPEAR_MS = 300;

export function useRowAppearance({ threadedDisplay, emailKey }) {
  // Rows that joined the list since the last paint fade in: a batch landing
  // while All Inboxes fills, new mail, the first rows after a skeleton. A list
  // replaced wholesale (a folder switch with rows on both sides) does not
  // animate, nor does the first paint. A row stays marked for the length of
  // its animation, whatever re-derives meanwhile (threads land right after the
  // flat pass), so the fade is never cut short. Keys are committed after
  // render so a StrictMode double render cannot swallow them.
  // A thread row goes by its newest message, the row that stood for it in the
  // flat pass before the threads were built, so threading does not fade it.
  const rowKeyOf = useCallback(r => emailKey(r.type === 'thread' ? r.thread.lastEmail : r.email), [emailKey]);
  const committedRowKeys = useRef(null);
  const appearedAt = useRef(new Map());
  useMemo(() => {
    const prev = committedRowKeys.current;
    const now = performance.now();
    for (const [k, t] of appearedAt.current) if (now - t > ROW_APPEAR_MS) appearedAt.current.delete(k);
    if (!prev) return;
    const fresh = [];
    let overlap = prev.size === 0;
    for (const r of threadedDisplay) {
      const k = rowKeyOf(r);
      if (prev.has(k)) overlap = true;
      else fresh.push(k);
    }
    if (overlap) for (const k of fresh) if (!appearedAt.current.has(k)) appearedAt.current.set(k, now);
  }, [threadedDisplay, rowKeyOf]);
  useEffect(() => { committedRowKeys.current = new Set(threadedDisplay.map(rowKeyOf)); }, [threadedDisplay, rowKeyOf]);
  const isFreshRow = (item) => {
    const t = appearedAt.current.get(rowKeyOf(item));
    return t !== undefined && performance.now() - t < ROW_APPEAR_MS;
  };

  return { rowKeyOf, isFreshRow };
}
