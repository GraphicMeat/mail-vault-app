// The mobile message list: a virtualized scroller over the page cache. Rows have one fixed height,
// so positions come from `estimateSize` alone and nothing is measured while scrolling.
//
// Live: when the folder changes under it the cache drops its pages and keeps the top row as an
// anchor; once the reload finds that row again the list moves by the rows that landed above it,
// so what the user was reading stays put. Pull-to-refresh watches touches only (passive
// listeners, no `preventDefault`), never scroll events, so scrolling stays on the fast path.
import React, { memo, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import MessageRow, { ROW_HEIGHT } from './MessageRow.jsx';
import { useT } from './i18n.js';

const OVERSCAN = 8;
/** How far (px, after damping) a pull has to travel before letting go refreshes. */
export const PULL_TRIGGER = 64;
const PULL_MAX = 96;

/** The pull indicator. Owns the pull state, so a pull repaints this line and not the rows. */
const PullIndicator = memo(function PullIndicator({ scrollRef, onRefresh, refreshing }) {
  const t = useT();
  const [pull, setPull] = useState(0);
  const start = useRef(null);
  const distance = useRef(0);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const set = (d) => {
      if (d === distance.current) return;
      distance.current = d;
      setPull(d);
    };
    const down = (e) => {
      start.current = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
    };
    const move = (e) => {
      if (start.current == null) return;
      const dy = e.touches[0].clientY - start.current;
      // Only a pull from the very top counts; any scroll down ends it.
      if (dy <= 0 || el.scrollTop > 0) {
        if (el.scrollTop > 0) start.current = null;
        set(0);
        return;
      }
      set(Math.min(PULL_MAX, Math.round(dy * 0.5)));
    };
    const up = () => {
      if (start.current != null && distance.current >= PULL_TRIGGER) refreshRef.current?.();
      start.current = null;
      set(0);
    };
    const opts = { passive: true };
    el.addEventListener('touchstart', down, opts);
    el.addEventListener('touchmove', move, opts);
    el.addEventListener('touchend', up, opts);
    el.addEventListener('touchcancel', up, opts);
    return () => {
      el.removeEventListener('touchstart', down, opts);
      el.removeEventListener('touchmove', move, opts);
      el.removeEventListener('touchend', up, opts);
      el.removeEventListener('touchcancel', up, opts);
    };
  }, [scrollRef]);

  const status = refreshing ? 'refreshing' : pull >= PULL_TRIGGER ? 'release' : pull > 0 ? 'pull' : null;
  const statusText = {
    refreshing: t('mobile.list.refreshing'),
    release: t('mobile.list.release'),
    pull: t('mobile.list.pull'),
  }[status];
  return (
    <div
      className={refreshing ? 'mv-pull mv-pull--busy' : 'mv-pull'}
      style={{ transform: `translateY(${refreshing ? PULL_TRIGGER : pull}px)`, opacity: status ? 1 : 0 }}
      role="status"
      aria-live="polite"
    >
      {status && <span className="mv-pull__spinner" aria-hidden="true" />}
      {statusText}
    </div>
  );
});

/** `accountOf(row)`: the row's account, in a list that spans accounts (All Inboxes); else null. */
function MessageList({ cache, onOpen, onSwipe, onRefresh, refreshing = false, demoSwipe = null, accountOf = null }) {
  const t = useT();
  const scrollRef = useRef(null);
  const [, rerender] = useReducer((n) => n + 1, 0);
  useEffect(() => cache.subscribe(rerender), [cache]);

  const total = cache.total ?? 0;
  const version = cache.version;
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const items = virtualizer.getVirtualItems();
  const first = items.length ? items[0].index : 0;
  const last = items.length ? items[items.length - 1].index : 0;
  cache.topIndex = Math.max(0, Math.floor((virtualizer.scrollOffset || 0) / ROW_HEIGHT));

  // The anchor row was found again after a reload: move by however many rows landed above it.
  const anchor = cache.anchor;
  useLayoutEffect(() => {
    if (!anchor || anchor.to == null) return;
    const el = scrollRef.current;
    if (el && anchor.to !== anchor.from) el.scrollTop += (anchor.to - anchor.from) * ROW_HEIGHT;
    cache.clearAnchor();
  });

  // Ask for the pages on screen and the one after, so a steady scroll meets loaded rows.
  useEffect(() => {
    if (!total) return;
    const ahead = Math.min(total - 1, last + cache.pageSize);
    for (const i of [first, last, ahead]) cache.ensure(i).catch(() => {});
  }, [cache, first, last, total, version]);

  return (
    <div className="mv-list-wrap">
      <PullIndicator scrollRef={scrollRef} onRefresh={onRefresh} refreshing={refreshing} />
      <div ref={scrollRef} className="mv-list" data-mv-list data-total={total}>
        {total === 0 && cache.total != null ? (
          <p className="mv-list__empty">{t('mobile.list.empty')}</p>
        ) : (
          <div className="mv-list__inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {items.map((it) => {
              const row = cache.rowAt(it.index);
              return (
                <MessageRow
                  key={it.index}
                  index={it.index}
                  start={it.start}
                  row={row}
                  account={accountOf && row ? accountOf(row) : undefined}
                  onOpen={onOpen}
                  onSwipe={onSwipe}
                  initialSwipe={demoSwipe && demoSwipe.index === it.index ? demoSwipe.side : null}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(MessageList);
