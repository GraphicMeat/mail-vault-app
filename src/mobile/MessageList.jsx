// The mobile message list: a virtualized scroller over the page cache. Rows have one fixed height,
// so positions come from `estimateSize` alone and nothing is measured while scrolling.
import React, { memo, useEffect, useReducer, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import MessageRow, { ROW_HEIGHT } from './MessageRow.jsx';

const OVERSCAN = 8;

function MessageList({ cache, onOpen }) {
  const scrollRef = useRef(null);
  const [, rerender] = useReducer((n) => n + 1, 0);
  useEffect(() => cache.subscribe(rerender), [cache]);

  const total = cache.total ?? 0;
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const items = virtualizer.getVirtualItems();
  const first = items.length ? items[0].index : 0;
  const last = items.length ? items[items.length - 1].index : 0;

  // Ask for the pages on screen and the one after, so a steady scroll meets loaded rows.
  useEffect(() => {
    if (!total) return;
    const ahead = Math.min(total - 1, last + cache.pageSize);
    for (const i of [first, last, ahead]) cache.ensure(i).catch(() => {});
  }, [cache, first, last, total]);

  return (
    <div ref={scrollRef} className="mv-list" data-mv-list data-total={total}>
      <div className="mv-list__inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {items.map((it) => (
          <MessageRow key={it.index} index={it.index} start={it.start} row={cache.rowAt(it.index)} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

export default memo(MessageList);
