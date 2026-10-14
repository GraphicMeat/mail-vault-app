import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { textRunsRender } from '../service';
import { createMeasure, fitRun } from './textMetrics';

// Must match --mv-blitz-text-font in blitz.css: the width fit measures with it.
export const LAYER_FONT = 'sans-serif';
const defaultMeasure = createMeasure(LAYER_FONT);

const NO_RUNS = [];

// The selectable text over the tiles: real DOM text, transparent, fitted to
// the worker's laid-out runs, so the webview's own selection, copy keys and
// accessibility work as they do in the iframe. Runs are fetched per shown
// tile only; a tile's container exists for every index so a late tile lands
// in reading order.
//
// A rev change (remote images landing, a fold toggle) keeps the runs it has
// until each tile's new reply replaces them: root and span keys are stable
// across relayouts, so React keeps the unchanged text nodes and a live
// selection survives. A docId change clears everything.
const TextLayer = forwardRef(function TextLayer({ docId, rev, meta, shownTiles, measure = defaultMeasure, hover = false, onRunsLoaded }, ref) {
  const [store, setStore] = useState(() => ({ docId, map: new Map() }));
  const requested = useRef(new Map()); // tile -> Promise
  const layer = useRef(null);
  const key = `${docId}:${rev}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const onLoadedRef = useRef(onRunsLoaded);
  onLoadedRef.current = onRunsLoaded;
  const tileCount = useRef(meta.tileCount);
  tileCount.current = meta.tileCount;

  // Runs of another doc are never shown, not even for the one render before the effect below runs.
  const runsByTile = store.docId === docId ? store.map : null;
  const held = useRef(runsByTile);
  held.current = runsByTile;

  useEffect(() => {
    requested.current = new Map();
    setStore((s) => (s.docId === docId ? s : { docId, map: new Map() }));
  }, [key, docId]);

  // `fetchTile` asks for one tile's runs once per rev and resolves to the owner
  // tiles its reply names; `load` (a shown tile, select-all) also fetches those
  // owners, one step only: an owner's own owners are not chased.
  const { fetchTile, load } = useMemo(() => {
    const fetch1 = (i) => {
      if (requested.current.has(i)) return requested.current.get(i);
      const asked = `${docId}:${rev}`;
      const p = textRunsRender(docId, i)
        .then((r) => {
          // A reply for an older rev (a fold toggled meanwhile) would put old
          // layout spans over moved content: drop it.
          if (currentKey.current !== asked) return [];
          const runs = r?.runs || [];
          setStore((s) => {
            const had = s.docId === docId ? s.map.get(i) : undefined;
            // An unchanged tile keeps its array: no re-render, no refit.
            if (had && sameRuns(had, runs)) return s;
            const map = new Map(s.docId === docId ? s.map : undefined);
            map.set(i, runs);
            return { docId, map };
          });
          onLoadedRef.current?.(i, runs);
          return (r?.owners || []).filter((j) => Number.isInteger(j) && j >= 0 && j < tileCount.current);
        })
        // The tile keeps what it had; a later rev (or the next shown set) asks again.
        .catch(() => { if (requested.current.get(i) === p) requested.current.delete(i); return []; });
      requested.current.set(i, p);
      return p;
    };
    // A segment lives in the tile of its first line: one that starts in an
    // earlier tile and runs on into this one is only there once its owner
    // tile is loaded too.
    const load1 = (i) => fetch1(i).then((owners) => { for (const j of owners) fetch1(j); });
    return { fetchTile: fetch1, load: load1 };
  }, [docId, rev]);

  // Shown tiles first. A new rev then asks again for every other tile that
  // holds runs: a tile loaded as an owner (or by select-all) would otherwise
  // keep a segment at its old place, and draw it twice once it moved to a
  // shown tile.
  useEffect(() => {
    if (docId == null) return;
    for (const i of shownTiles) if (i < meta.tileCount) load(i);
    for (const i of held.current?.keys() ?? []) if (i < meta.tileCount) fetchTile(i);
  }, [key, shownTiles, meta.tileCount, load, fetchTile, docId]);

  useImperativeHandle(ref, () => ({
    // Resolves when the replies are in state, which is before React commits
    // them to the DOM: a caller that reads spans right after must wait a frame.
    loadAll: () => Promise.all(Array.from({ length: meta.tileCount }, (_, i) => load(i))).then(() => undefined),
    firstSpan: () => layer.current?.querySelector('span[data-node]') ?? null,
    lastSpan: () => { const all = layer.current?.querySelectorAll('span[data-node]'); return all?.length ? all[all.length - 1] : null; },
    layerEl: () => layer.current,
  }), [load, meta.tileCount]);

  const tiles = useMemo(() => Array.from({ length: meta.tileCount }, (_, i) => i), [meta.tileCount]);

  return (
    <div
      ref={layer}
      data-testid="blitz-text-layer"
      className="mv-blitz-text"
      data-hover={hover ? 'true' : undefined}
      style={{ position: 'absolute', left: 0, top: 0, width: meta.cssWidth, height: meta.cssHeight, overflow: 'clip' }}
    >
      {tiles.map((i) => (
        <Tile key={i} index={i} runs={runsByTile?.get(i) ?? NO_RUNS} width={meta.cssWidth} measure={measure} />
      ))}
    </div>
  );
});

const sameRun = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.text === b.text
  && a.fontPx === b.fontPx && a.node === b.node && a.start === b.start && a.seg === b.seg;
const sameRuns = (a, b) => a.length === b.length && a.every((r, i) => sameRun(r, b[i]));

/**
 * The runs of each segment (a stretch of one inline root between hard
 * newlines, `seg` from the worker), with its box: one pass, no argument
 * spreading (a root of 65k+ runs would overflow JavaScriptCore's argument limit).
 */
export function groupSegments(runs) {
  const groups = [];
  let g = null;
  for (const r of runs) {
    const seg = r.seg ?? 0;
    if (!g || g.node !== r.node || g.seg !== seg) {
      g = { node: r.node, seg, runs: [], left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      groups.push(g);
    }
    g.runs.push(r);
    if (r.x < g.left) g.left = r.x;
    if (r.y < g.top) g.top = r.y;
    if (r.x + r.w > g.right) g.right = r.x + r.w;
    if (r.y + r.h > g.bottom) g.bottom = r.y + r.h;
  }
  return groups;
}

/**
 * Line boxes in whole px: line k's box starts at round(y_k - top) and the
 * heights telescope, so nothing accumulates down a tall block whatever an
 * engine does with a fractional line-height (Blink keeps 1/64 px, WebKit may
 * keep less). A box ends where the next line starts if it would reach past
 * it: parley rounds each top and each box height but steps by the unrounded
 * line height, so a box of round(LH) on an LH pitch overlaps the next line
 * whenever LH has a fraction of .5 or more in device px. `shift`
 * (|shift| <= 0.5) moves the drawn text back to its exact y; `gap` is the
 * height of dropped lines before the next line.
 */
export function stackLines(lines, top) {
  let flow = 0;
  return lines.map((line, i) => {
    const at = line.y - top;
    const next = i + 1 < lines.length ? lines[i + 1].y - top : Infinity;
    const stop = Math.max(at, Math.min(at + line.h, next));
    const height = Math.round(stop) - Math.round(at);
    const gap = next === Infinity ? 0 : Math.max(0, Math.round(next) - Math.round(stop));
    const box = { shift: at - flow, height, gap };
    flow += height + gap;
    return box;
  });
}

// How far right a root's box reaches: to the layer's edge, or to the next root
// on its right that shares some of its height (a table cell, a column). A drag
// that ends right of a line's end then lands in that line's root, as it lands
// in the paragraph in the iframe, instead of in the layer between roots.
function reach(groups, width) {
  return groups.map((g) => {
    let right = width;
    for (const o of groups) {
      if (o !== g && o.left >= g.right - 0.5 && o.top < g.bottom && o.bottom > g.top) right = Math.min(right, o.left);
    }
    return Math.max(right, g.right);
  });
}

// Memoized on the tile's runs array (a stable reference in the store) and the
// measure, so a hover, a shown-set change or another tile's reply never
// refits the spans of a loaded tile.
const Tile = React.memo(function Tile({ index, runs, width, measure }) {
  const groups = useMemo(() => groupSegments(runs), [runs]);
  const rights = useMemo(() => reach(groups, width), [groups, width]);
  return (
    <div data-tile={index}>
      {groups.map((group, g) => (
        <Root key={`${group.node}:${group.seg}@${index}`} group={group} right={rights[g]} measure={measure} />
      ))}
    </div>
  );
});

// One segment of an inline root (a paragraph, a cell, one hard-broken line of
// a <pre>) is one block with its lines as real line boxes, so the engine's hit
// test and paragraph selection work as in the iframe: a point right of a
// line's end resolves to that line, and a triple-click selects the segment,
// which is what the iframe's paragraph between two <br>s is. The block is 0 px
// wide (its hit area is padding out to `right`), so each line wrapper,
// `white-space: pre` inside, sits on a line of its own at the <wbr> after it:
// soft wraps, not <br>s, which would add a newline to the selection's text.
// A line the worker dropped (all of it unselectable) is a gap box of its
// height, so every line box sits at its drawn top (see stackLines).
function Root({ group, right, measure }) {
  const { runs, left, top } = group;
  const out = useMemo(() => {
    const lines = [];
    for (const r of runs) {
      const last = lines[lines.length - 1];
      // Runs come in logical order and a line's runs share its top.
      if (last && last.y === r.y) { last.runs.push(r); last.h = Math.max(last.h, r.h); } else lines.push({ y: r.y, h: r.h, runs: [r] });
    }
    const boxes = stackLines(lines, top);
    const nodes = [];
    lines.forEach((line, li) => {
      const first = line.runs[0].start;
      const { shift, height } = boxes[li];
      let flow = 0;
      const spans = line.runs.map((r) => {
        const { letterSpacing, width } = fitRun(r, measure);
        const style = {
          marginLeft: r.x - left - flow,
          top: shift,
          fontSize: r.fontPx,
          lineHeight: `${height}px`,
          letterSpacing,
        };
        flow = r.x - left + width;
        // A <br> is "\n" in the layout text and a tab would expand to a tab
        // stop under white-space:pre while the canvas measures it as a space:
        // both are drawn as a space, same byte and UTF-16 length, offsets
        // unchanged (copy goes through serialize, which keeps the real characters).
        return <span key={r.start} dir="auto" data-node={r.node} data-start={r.start} style={style}>{r.text.replace(/[\n\r\t]/g, ' ')}</span>;
      });
      nodes.push(<span key={`l${first}`} className="mv-blitz-line">{spans}</span>);
      if (li + 1 < lines.length) {
        const next = lines[li + 1].runs[0].start;
        nodes.push(<wbr key={`w${next}`} />);
        if (boxes[li].gap > 0) {
          nodes.push(<span key={`g${next}`} className="mv-blitz-gap" aria-hidden="true" style={{ height: boxes[li].gap }} />, <wbr key={`v${next}`} />);
        }
      }
    });
    return nodes;
  }, [runs, measure, left, top]);
  return (
    <div className="mv-blitz-root" style={{ position: 'absolute', left, top, width: 0, paddingRight: right - left }}>
      {out}
    </div>
  );
}

export default TextLayer;
