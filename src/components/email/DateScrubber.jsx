// Date scrubber for the chronological email list: a subdued rail on
// the left edge, a month pill beside it, and a pinned
// current-month header. Design: docs/superpowers/specs/2026-09-22-list-date-scrubber-design.md

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useMailStore } from '../../stores/mailStore';
import * as db from '../../services/db';
import { useT } from '../../i18n/index.js';
import { formatMonthYear, monthYearFormatter } from '../../utils/dateFormat';
import { bucketAtIndex, monthBuckets, railSegments, reachedMonth, rowDate } from '../../utils/dateBuckets';

export const MONTH_HEADER_H = 26;
const RAIL_W = 28;
// Only the left gutter arms the rail; row actions stay clear on the right.
const EDGE_PX = 12;
const RAIL_IDLE_MS = 1200;
const PILL_IDLE_MS = 800;
const PENDING_MS = 1500;
const MAG_RADIUS = 56;
const MAG_MAX = 0.9;
const HEADER_CLASS = 'flex items-end px-4 pb-1 text-xs font-semibold text-mail-text-muted bg-mail-surface';

/** The band drawn above the first row of a month, inside that row's wrapper. */
export function MonthHeader({ bucket }) {
  if (!bucket) return null;
  return (
    <div data-testid="list-month-header" className={HEADER_CLASS} style={{ height: MONTH_HEADER_H }}>
      {formatMonthYear(bucket.y, bucket.m)}
    </div>
  );
}

/** monthBuckets, keeping the previous array while nothing month-wise changed
 *  (a flag change rebuilds every row, not the months). */
export function useMonthBuckets(rows, enabled) {
  const prevRef = useRef([]);
  return useMemo(() => {
    const next = enabled ? monthBuckets(rows) : [];
    const prev = prevRef.current;
    if (next.length === prev.length && next.every((b, i) =>
      b.key === prev[i].key && b.firstIndex === prev[i].firstIndex && b.rows === prev[i].rows)) return prev;
    prevRef.current = next;
    return next;
  }, [rows, enabled]);
}

function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query)?.matches);
  useEffect(() => {
    const mq = typeof window !== 'undefined' ? window.matchMedia?.(query) : null;
    if (!mq?.addEventListener) return undefined;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function oldestLoadedDate(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const d = rowDate({ type: 'email', email: list[i] });
    if (d) return d;
  }
  return null;
}

// Resolves on the next change of what a page load moves, or after `ms`.
function waitForStore(ms) {
  return new Promise((resolve) => {
    const pick = s => `${s.sortedEmails.length}|${s.loadingMore}|${s.hasMoreEmails}`;
    const start = pick(useMailStore.getState());
    let unsub = null;
    const done = () => { unsub?.(); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, ms);
    unsub = useMailStore.subscribe(s => { if (pick(s) !== start) done(); });
  });
}

// Page older mail in until the target month is reached (null target: until
// the mailbox is exhausted). loadMoreEmails can resolve without adding a row
// (a load already in flight, offline, daemon backfilling, a scheduled
// follow-up), so progress is measured on the store, and a few passes without
// any end the loop instead of spinning.
async function loadUntil(target, aborted) {
  let stalls = 0;
  while (!aborted()) {
    const s = useMailStore.getState();
    if (target && reachedMonth(oldestLoadedDate(s.sortedEmails), target)) return;
    if (!s.hasMoreEmails) return;
    const before = s.sortedEmails.length;
    await s.loadMoreEmails();
    if (aborted()) return;
    if (useMailStore.getState().sortedEmails.length > before) { stalls = 0; continue; }
    await waitForStore(4000);
    if (useMailStore.getState().sortedEmails.length > before) stalls = 0;
    else if (++stalls >= 3) return;
  }
}

/**
 * Rail segments (loaded months, histogram months not loaded yet, the uncached
 * tail) and the jump action. The histogram is fetched once per
 * (account, mailbox) and again whenever the header cache's totalCached moves.
 */
export function useDateScrubber({
  enabled, buckets, virtualizer, scrollRef, rowCount,
  accountId, mailbox, viewMode, histogramEligible, totalEmails, loadedCount,
}) {
  const fetchHist = enabled && histogramEligible;
  const histKey = `${accountId}|${mailbox}`;
  const histRef = useRef(null);
  const [hist, setHist] = useState(null);

  useEffect(() => {
    if (!fetchHist) return undefined;
    let dead = false;
    (async () => {
      try {
        const meta = await db.getEmailHeadersMeta(accountId, mailbox);
        const totalCached = meta?.totalCached || 0;
        if (dead) return;
        if (histRef.current?.key === histKey && histRef.current.totalCached === totalCached) return;
        const histogram = await db.getMonthHistogram(accountId, mailbox);
        if (dead || !histogram) return;
        histRef.current = { key: histKey, totalCached, histogram };
        setHist(histRef.current);
      } catch { /* no histogram: the rail shows loaded months only */ }
    })();
    return () => { dead = true; };
  }, [fetchHist, histKey, accountId, mailbox, totalEmails, loadedCount]);

  const activeHist = fetchHist && hist?.key === histKey ? hist : null;
  const segments = useMemo(() => (enabled
    ? railSegments(buckets, activeHist?.histogram || null,
      activeHist ? { totalEmails, totalCached: activeHist.totalCached } : {})
    : []), [enabled, buckets, activeHist, totalEmails]);

  const [jumping, setJumping] = useState(null);
  const jumpingRef = useRef(null);
  jumpingRef.current = jumping;
  const [pendingSeq, setPendingSeq] = useState(0);
  const genRef = useRef(0);
  const pendingRef = useRef(null);
  const bucketsRef = useRef(buckets);
  bucketsRef.current = buckets;
  const rowCountRef = useRef(rowCount);
  rowCountRef.current = rowCount;

  // A folder, account or mode change aborts a running jump.
  useEffect(() => () => {
    genRef.current++;
    pendingRef.current = null;
    setJumping(null);
  }, [accountId, mailbox, viewMode, enabled]);

  // A loaded jump lands after React has the new rows, and again whenever the
  // months move (threads are built a tick after the flat list), until the
  // user scrolls themselves or PENDING_MS passes.
  useEffect(() => {
    const p = pendingRef.current;
    const list = bucketsRef.current;
    if (!p || !list.length) return;
    if (Date.now() > p.until) { pendingRef.current = null; return; }
    if (!p.target) { virtualizer.scrollToIndex(Math.max(0, rowCountRef.current - 1), { align: 'end' }); return; }
    const t = p.target.y * 12 + p.target.m;
    const b = list.find(x => x.y * 12 + x.m <= t) || list[list.length - 1];
    virtualizer.scrollToIndex(b.firstIndex, { align: 'start' });
  }, [buckets, pendingSeq, virtualizer]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !enabled) return undefined;
    // The user taking over the list stops a running load and its landing.
    const cancel = () => {
      if (!pendingRef.current && !jumpingRef.current) return;
      genRef.current++;
      pendingRef.current = null;
      setJumping(null);
    };
    el.addEventListener('wheel', cancel, { passive: true });
    el.addEventListener('pointerdown', cancel, { passive: true });
    el.addEventListener('keydown', cancel, { passive: true });
    return () => {
      el.removeEventListener('wheel', cancel);
      el.removeEventListener('pointerdown', cancel);
      el.removeEventListener('keydown', cancel);
    };
  }, [scrollRef, enabled]);

  const jump = useCallback(async (seg) => {
    if (!seg) return;
    const gen = ++genRef.current;
    pendingRef.current = null;
    if (seg.kind === 'loaded') {
      setJumping(null);
      virtualizer.scrollToIndex(seg.bucket.firstIndex, { align: 'start' });
      return;
    }
    const target = seg.kind === 'unloaded' ? { y: seg.y, m: seg.m } : null;
    setJumping(seg);
    await loadUntil(target, () => genRef.current !== gen);
    if (genRef.current !== gen) return;
    pendingRef.current = { target, until: Date.now() + PENDING_MS };
    setJumping(null);
    setPendingSeq(n => n + 1);
  }, [virtualizer]);

  return { segments, jump, jumping };
}

function segLabel(seg, olderLabel) {
  if (!seg) return '';
  return seg.kind === 'older' ? olderLabel : formatMonthYear(seg.y, seg.m);
}

export const DateScrubber = memo(function DateScrubber({ scrollRef, virtualizer, buckets, segments, onJump, loading }) {
  const t = useT();
  const older = t('list.older');
  const reduced = usePrefersReducedMotion();
  const [currentKey, setCurrentKey] = useState(buckets[0]?.key || null);
  const [scrolling, setScrolling] = useState(false);
  const [pillOn, setPillOn] = useState(false);
  const [near, setNear] = useState(false);
  const [hover, setHover] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [railH, setRailH] = useState(0);
  const railRef = useRef(null);
  const pillRef = useRef(null);
  const labelRef = useRef(null);
  const hoverLabelRef = useRef(null);
  const hoverY = useRef(0);
  const moveRaf = useRef(0);
  const dragRef = useRef(null);
  const bucketsRef = useRef(buckets);
  bucketsRef.current = buckets;
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const syncCurrent = useCallback(() => {
    const el = scrollRef.current;
    // The first row visible BELOW the pinned band, not the one hidden under it.
    const item = el ? virtualizerRef.current.getVirtualItemForOffset?.(el.scrollTop + MONTH_HEADER_H) : null;
    const b = bucketAtIndex(bucketsRef.current, item ? item.index : 0);
    setCurrentKey(b ? b.key : null);
  }, [scrollRef]);
  // Rows paged in or arriving move the months without a scroll event.
  useEffect(() => { syncCurrent(); }, [buckets, syncCurrent]);

  // Scroll: current month and pill position, rAF-throttled; visibility timers.
  // Subscribed once: re-subscribing would drop the hide timers mid-flight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    let raf = 0;
    let railTimer = null;
    let pillTimer = null;
    const frame = () => {
      raf = 0;
      syncCurrent();
      const pill = pillRef.current;
      if (pill && el.scrollHeight > 0) {
        const vh = el.clientHeight;
        const thumbH = (vh * vh) / el.scrollHeight;
        const y = (el.scrollTop / el.scrollHeight) * vh + thumbH / 2 - pill.offsetHeight / 2;
        pill.style.transform = `translateY(${Math.max(4, Math.min(vh - pill.offsetHeight - 4, y))}px)`;
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(frame);
      setScrolling(true);
      setPillOn(true);
      clearTimeout(railTimer);
      railTimer = setTimeout(() => setScrolling(false), RAIL_IDLE_MS);
      clearTimeout(pillTimer);
      pillTimer = setTimeout(() => setPillOn(false), PILL_IDLE_MS);
    };
    const measure = () => {
      setRailH(railRef.current?.clientHeight || 0);
    };
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      setNear(e.clientX - r.left <= EDGE_PX);
    };
    const onLeave = () => setNear(false);
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(railTimer);
      clearTimeout(pillTimer);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      ro?.disconnect();
    };
  }, [scrollRef, syncCurrent]);

  const currentIdx = segments.findIndex(s => s.key === currentKey);
  const current = segments[currentIdx] || null;
  const pillSeg = loading || current;

  // Odometer roll on a year change, crossfade on a month change.
  const prevPill = useRef(null);
  useLayoutEffect(() => {
    const prev = prevPill.current;
    prevPill.current = pillSeg;
    const root = labelRef.current;
    if (!prev || !pillSeg || reduced || !root || prev.key === pillSeg.key) return;
    if (prev.y !== pillSeg.y && pillSeg.y) {
      const dir = pillSeg.y < prev.y ? 1 : -1;
      root.querySelector('[data-part="year"]')?.animate?.(
        [{ transform: `translateY(${dir * 80}%)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
        { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
    root.querySelectorAll('[data-part="month"]').forEach(el => el.animate?.(
      [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' }));
  });

  const ticks = useMemo(() => {
    const out = [];
    const dotGap = railH ? 5 / railH : 0;
    const labelGap = railH ? 16 / railH : 0;
    let lastDot = -Infinity;
    let lastLabel = -Infinity;
    let prevYear = null;
    segments.forEach((s, i) => {
      if (s.kind === 'older') return;
      const dim = s.kind !== 'loaded';
      if (s.y !== prevYear) {
        prevYear = s.y;
        if (s.start - lastLabel >= labelGap) {
          out.push({ type: 'year', i, pos: s.start, y: s.y, dim });
          lastLabel = s.start;
          lastDot = s.start;
          return;
        }
      }
      if (s.start - lastDot >= dotGap) {
        out.push({ type: 'dot', i, pos: s.start, dim });
        lastDot = s.start;
      }
    });
    return out;
  }, [segments, railH]);
  const tail = segments[segments.length - 1]?.kind === 'older' ? segments[segments.length - 1] : null;

  const segAt = (clientY) => {
    const r = railRef.current?.getBoundingClientRect();
    hoverY.current = r ? clientY - r.top : 0;
    const f = r?.height ? hoverY.current / r.height : 0;
    for (let i = segments.length - 1; i > 0; i--) if (segments[i].start <= f) return i;
    return 0;
  };

  const resetMagnify = () => {
    railRef.current?.querySelectorAll('[data-tick]').forEach(el => { el.style.transform = 'translateY(-50%)'; });
  };
  const magnify = () => {
    moveRaf.current = 0;
    const rail = railRef.current;
    if (!rail) return;
    const y = hoverY.current;
    if (hoverLabelRef.current) hoverLabelRef.current.style.transform = `translateY(${y}px) translateY(-50%)`;
    if (reduced) return;
    const h = rail.clientHeight;
    rail.querySelectorAll('[data-tick]').forEach((el) => {
      const d = Math.abs(Number(el.dataset.pos) * h - y);
      const s = 1 + MAG_MAX * Math.max(0, 1 - d / MAG_RADIUS);
      el.style.transform = `translateY(-50%) scale(${s.toFixed(3)})`;
    });
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const i = segAt(e.clientY);
    dragRef.current = { i };
    setDragging(true);
    if (segments[i]?.kind === 'loaded') onJump(segments[i]);
  };
  const onPointerMove = (e) => {
    const i = segAt(e.clientY);
    setHover(i);
    const drag = dragRef.current;
    if (drag && drag.i !== i) {
      drag.i = i;
      if (segments[i]?.kind === 'loaded') onJump(segments[i]);
    }
    if (!moveRaf.current) moveRaf.current = requestAnimationFrame(magnify);
  };
  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    // Unloaded months page mail in, so they wait for the release.
    if (drag && segments[drag.i] && segments[drag.i].kind !== 'loaded') onJump(segments[drag.i]);
  };
  const onPointerLeave = () => {
    if (dragRef.current) return;
    setHover(null);
    resetMagnify();
  };
  const onKeyDown = (e) => {
    const last = segments.length - 1;
    const from = currentIdx < 0 ? 0 : currentIdx;
    const to = { ArrowDown: from + 1, PageDown: from + 1, ArrowUp: from - 1, PageUp: from - 1, Home: 0, End: last }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation(); // not the global list shortcuts too
    onJump(segments[Math.max(0, Math.min(last, to))]);
  };
  useEffect(() => () => { if (moveRaf.current) cancelAnimationFrame(moveRaf.current); }, []);

  const railVisible = scrolling || near || hover !== null || dragging || !!loading;
  // Scrolling only shows the rail; it takes clicks once the pointer is at the
  // edge or on it, so a click on a row just after a scroll still hits the row.
  const railLive = near || hover !== null || dragging || !!loading;
  const pillVisible = pillOn || dragging || !!loading;
  const parts = pillSeg && pillSeg.kind !== 'older'
    ? monthYearFormatter().formatToParts(new Date(pillSeg.y, pillSeg.m - 1, 1))
    : null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <div aria-hidden="true" className={`absolute top-0 left-0 ${HEADER_CLASS}`} style={{ right: 0, height: MONTH_HEADER_H }}>
        {current ? segLabel(current, older) : null}
      </div>

      <div ref={pillRef} aria-hidden="true"
        className={`absolute top-0 flex items-center gap-2 whitespace-nowrap rounded-md border border-mail-border bg-mail-surface px-2 py-1 text-xs font-medium text-mail-text transition-opacity duration-200 ${pillVisible ? 'opacity-100' : 'opacity-0'}`}
        style={{ left: RAIL_W + 8 }}>
        {loading && <Loader2 size={16} className="animate-spin text-mail-accent-text" />}
        <span ref={labelRef} data-testid="date-scrubber-pill">
          {parts
            ? parts.map((p, i) => (p.type === 'year'
              ? <span key={i} className="inline-block overflow-hidden align-bottom"><span data-part="year" className="inline-block">{p.value}</span></span>
              : p.type === 'month'
                ? <span key={i} data-part="month" className="inline-block">{p.value}</span>
                : <React.Fragment key={i}>{p.value}</React.Fragment>))
            : segLabel(pillSeg, older)}
        </span>
      </div>

      <div ref={railRef} role="slider" tabIndex={0} data-testid="date-scrubber-rail"
        aria-label={t('list.timeline')} aria-orientation="vertical"
        aria-valuemin={0} aria-valuemax={Math.max(0, segments.length - 1)}
        aria-valuenow={Math.max(0, currentIdx)} aria-valuetext={segLabel(current, older)}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp} onPointerLeave={onPointerLeave} onKeyDown={onKeyDown}
        className={`absolute touch-none select-none rounded-full bg-transparent outline-none transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-mail-accent ${railVisible ? 'opacity-100' : 'opacity-50 focus-visible:opacity-100'} ${railLive
          ? 'pointer-events-auto' : 'pointer-events-none focus-visible:pointer-events-auto'}`}
        style={{ top: MONTH_HEADER_H + 6, bottom: 6, left: 0, width: RAIL_W }}>
        <div className="absolute inset-y-0 left-[13px] w-px bg-mail-border" />
        {tail && (
          <div className="absolute left-[12px] w-[3px] rounded-full bg-mail-text-muted/25"
            style={{ top: `${tail.start * 100}%`, height: `${tail.size * 100}%` }} />
        )}
        {current && (
          <div className="absolute left-[6px] h-[2px] w-4 -translate-y-1/2 rounded-full bg-mail-accent"
            style={{ top: `${current.start * 100}%` }} />
        )}
        {ticks.map(tick => (
          <div key={`${tick.type}-${tick.i}`} data-tick data-pos={tick.pos}
            className={`absolute left-[4px] origin-left ${tick.dim ? 'opacity-50' : ''}`}
            style={{ top: `${tick.pos * 100}%`, transform: 'translateY(-50%)' }}>
            {tick.type === 'year'
              ? <span className="block text-[11px] font-semibold leading-none text-mail-text-muted">{tick.y}</span>
              : <span className="ml-[7px] block h-[3px] w-[3px] rounded-full bg-mail-text-muted" />}
          </div>
        ))}
        {hover !== null && segments[hover] && (
          <div ref={hoverLabelRef}
            className="absolute left-full top-0 ml-2 whitespace-nowrap rounded-md border border-mail-border bg-mail-surface px-2 py-0.5 text-xs font-medium text-mail-text"
            style={{ transform: `translateY(${hoverY.current}px) translateY(-50%)` }}>
            {segLabel(segments[hover], older)}
          </div>
        )}
      </div>
    </div>
  );
});
