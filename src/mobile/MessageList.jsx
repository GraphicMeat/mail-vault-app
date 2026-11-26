// The mobile message list: a virtualized scroller over the page cache. Rows have one fixed height,
// so positions come from `estimateSize` alone and nothing is measured while scrolling.
//
// Holding a row opens the quick action wheel on it (`wheel`: the app's paths for what the wheel runs,
// quickActions/RowWheel.jsx); without `wheel` a row cannot be held.
//
// Live: when the folder changes under it the cache drops its pages and keeps the top row as an
// anchor; once the reload finds that row again the list moves by the rows that landed above it,
// so what the user was reading stays put. Pull-to-refresh watches touches only (passive
// listeners, no `preventDefault`), never scroll events, so scrolling stays on the fast path.
// An empty folder says so, unless `emptyNote` is false (local drafts are shown above it, App.jsx).
import React, { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import MessageRow from './MessageRow.jsx';
import { useT } from './i18n.js';
import { haptic } from './haptics.js';
import { useMobileStore } from './store.js';
import { rowHeight } from './prefs.js';
import { pullMayStart } from './gestures/recognizers.js';
import RowWheel from './quickActions/RowWheel.jsx';
import SweepColumn from './selection/SweepColumn.jsx';
import { useSelection } from './selection/selectionStore.js';

const OVERSCAN = 8;
/** How far (px, after damping) a pull has to travel before letting go refreshes. */
export const PULL_TRIGGER = 64;
const PULL_MAX = 96;
/** Where the list rests (px) while a refresh runs: the indicator's height, so it covers no row. */
export const PULL_REST = 40;

/** The pull indicator. Owns the pull state, so a pull repaints this line and not the rows. */
export const PullIndicator = memo(function PullIndicator({ scrollRef, onRefresh, refreshing }) {
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
      // One tick each time the pull passes its trigger (not per move).
      if (d >= PULL_TRIGGER && distance.current < PULL_TRIGGER) haptic.impact('light');
      distance.current = d;
      setPull(d);
    };
    const down = (e) => {
      start.current = pullMayStart(el.scrollTop, e.touches.length) ? e.touches[0].clientY : null;
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

  // The rows move down with the indicator (and stay down by its height while refreshing), so the
  // spinner sits in the room they leave instead of over the first row. Written to the scroller's
  // style, not rendered: the rows never repaint for a pull.
  const offset = refreshing ? Math.max(PULL_REST, pull) : pull;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.style.transform = offset ? `translateY(${offset}px)` : '';
  }, [scrollRef, offset]);

  // The spinner is the whole indicator: no words while pulling or refreshing. Screen readers
  // hear that a refresh runs, from the label no one else sees.
  const showing = refreshing || pull > 0;
  return (
    <div
      className={refreshing ? 'mv-pull mv-pull--busy' : 'mv-pull'}
      style={{ transform: `translateY(${offset}px)`, opacity: showing ? 1 : 0 }}
      role="status"
      aria-live="polite"
    >
      {showing && <span className="mv-pull__spinner" aria-hidden="true" />}
      {refreshing && <span className="mv-visually-hidden">{t('mobile.list.refreshing')}</span>}
    </div>
  );
});

/** `accountOf(row)`: the row's account, in a list that spans accounts (All Inboxes); else null. */
function MessageList({ cache, onOpen, onSwipe, onRefresh, refreshing = false, demoSwipe = null, accountOf = null, emptyNote = true, wheel = null }) {
  const t = useT();
  // The row the wheel is open on: `{ row, key, x, y }`.
  const [held, setHeld] = useState(null);
  const hold = useCallback((row, point) => {
    haptic.impact('medium');
    setHeld({ row, key: Date.now(), x: point.x, y: point.y });
  }, []);
  const closeWheel = useCallback(() => setHeld(null), []);
  const selecting = useSelection((s) => s.active);
  const scrollRef = useRef(null);
  const [, rerender] = useReducer((n) => n + 1, 0);
  useEffect(() => cache.subscribe(rerender), [cache]);

  const total = cache.total ?? 0;
  const version = cache.version;
  // One height for every row, from the preferences (text size, density, preview lines).
  const height = useMobileStore((s) => rowHeight(s.prefs));
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => height,
    overscan: OVERSCAN,
  });
  // A preference changed the height: every position is recomputed from the new estimate.
  const measured = useRef(height);
  useLayoutEffect(() => {
    if (measured.current === height) return;
    measured.current = height;
    virtualizer.measure();
  }, [height, virtualizer]);
  const items = virtualizer.getVirtualItems();
  const first = items.length ? items[0].index : 0;
  const last = items.length ? items[items.length - 1].index : 0;
  cache.topIndex = Math.max(0, Math.floor((virtualizer.scrollOffset || 0) / height));

  // The anchor row was found again after a reload: move by however many rows landed above it.
  const anchor = cache.anchor;
  useLayoutEffect(() => {
    if (!anchor || anchor.to == null) return;
    const el = scrollRef.current;
    if (el && anchor.to !== anchor.from) el.scrollTop += (anchor.to - anchor.from) * height;
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
          emptyNote && <p className="mv-list__empty">{t('mobile.list.empty')}</p>
        ) : (
          <div className="mv-list__inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {selecting && <SweepColumn cache={cache} height={height} />}
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
                  onHold={wheel ? hold : null}
                  initialSwipe={demoSwipe && demoSwipe.index === it.index ? demoSwipe.side : null}
                />
              );
            })}
          </div>
        )}
      </div>
      {wheel && <RowWheel target={held} onClose={closeWheel} {...wheel} />}
    </div>
  );
}

export default memo(MessageList);
