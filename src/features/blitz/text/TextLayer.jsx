import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
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

  // Runs of another doc are never shown, not even for the one render before the effect below runs.
  const runsByTile = store.docId === docId ? store.map : null;

  useEffect(() => {
    requested.current = new Map();
    setStore((s) => (s.docId === docId ? s : { docId, map: new Map() }));
  }, [key, docId]);

  const load = useCallback((index) => {
    if (requested.current.has(index)) return requested.current.get(index);
    const asked = `${docId}:${rev}`;
    const p = textRunsRender(docId, index)
      .then((r) => {
        // A reply for an older rev (a fold toggled meanwhile) would put old
        // layout spans over moved content: drop it.
        if (currentKey.current !== asked) return;
        const runs = r?.runs || [];
        setStore((s) => {
          const map = new Map(s.docId === docId ? s.map : undefined);
          map.set(index, runs);
          return { docId, map };
        });
        onLoadedRef.current?.(index, runs);
      })
      // The tile keeps what it had; a later rev (or the next shown set) asks again.
      .catch(() => { if (requested.current.get(index) === p) requested.current.delete(index); });
    requested.current.set(index, p);
    return p;
  }, [docId, rev]);

  useEffect(() => {
    if (docId == null) return;
    for (const i of shownTiles) if (i < meta.tileCount) load(i);
  }, [key, shownTiles, meta.tileCount, load, docId]);

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
        <Tile key={i} index={i} runs={runsByTile?.get(i) ?? NO_RUNS} measure={measure} />
      ))}
    </div>
  );
});

function groupByRoot(runs) {
  const groups = [];
  for (const r of runs) {
    const last = groups[groups.length - 1];
    if (last && last.node === r.node) last.runs.push(r); else groups.push({ node: r.node, runs: [r] });
  }
  return groups;
}

// Memoized on the tile's runs array (a stable reference in the store) and the
// measure, so a hover, a shown-set change or another tile's reply never
// refits the spans of a loaded tile.
const Tile = React.memo(function Tile({ index, runs, measure }) {
  const groups = useMemo(() => groupByRoot(runs), [runs]);
  return (
    <div data-tile={index}>
      {groups.map((group) => (
        <Root key={`${group.node}@${index}`} runs={group.runs} measure={measure} />
      ))}
    </div>
  );
});

function Root({ runs, measure }) {
  const spans = useMemo(() => {
    const top = Math.min(...runs.map(r => r.y));
    const left = Math.min(...runs.map(r => r.x));
    let flow = 0;
    const out = runs.map((r) => {
      const { letterSpacing, width } = fitRun(r, measure);
      const style = {
        position: 'relative',
        left: r.x - left - flow,
        top: r.y - top,
        fontSize: r.fontPx,
        lineHeight: `${r.h}px`,
        letterSpacing,
      };
      flow += width;
      // A <br> is "\n" in the layout text, and a tab would expand to a tab stop
      // under white-space:pre while the canvas measures it as a space. Either
      // would shift every later span in this one flow line, so both are drawn
      // as a space: same byte and UTF-16 length, offsets unchanged (copy goes
      // through serialize, which keeps the real characters).
      return <span key={r.start} dir="auto" data-node={r.node} data-start={r.start} style={style}>{r.text.replace(/[\n\r\t]/g, ' ')}</span>;
    });
    return { top, left, out };
  }, [runs, measure]);
  return (
    <div className="mv-blitz-root" style={{ position: 'absolute', left: spans.left, top: spans.top, whiteSpace: 'pre' }}>
      {spans.out}
    </div>
  );
}

export default TextLayer;
