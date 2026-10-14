import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { textRunsRender } from '../service';
import { createMeasure, fitRun } from './textMetrics';

// Must match --mv-blitz-text-font in blitz.css: the width fit measures with it.
export const LAYER_FONT = 'sans-serif';
const defaultMeasure = createMeasure(LAYER_FONT);

// The selectable text over the tiles: real DOM text, transparent, fitted to
// the worker's laid-out runs, so the webview's own selection, copy keys and
// accessibility work as they do in the iframe. Runs are fetched per shown
// tile only; a tile's container exists for every index so a late tile lands
// in reading order.
const TextLayer = forwardRef(function TextLayer({ docId, rev, meta, shownTiles, measure = defaultMeasure, hover = false, onRunsLoaded }, ref) {
  const [runsByTile, setRunsByTile] = useState(() => new Map());
  const requested = useRef(new Map()); // tile -> Promise
  const layer = useRef(null);
  const key = `${docId}:${rev}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const onLoadedRef = useRef(onRunsLoaded);
  onLoadedRef.current = onRunsLoaded;

  useEffect(() => {
    requested.current = new Map();
    setRunsByTile(new Map());
  }, [key]);

  const load = useCallback((index) => {
    if (requested.current.has(index)) return requested.current.get(index);
    const asked = `${docId}:${rev}`;
    const p = textRunsRender(docId, index)
      .then((r) => {
        // A reply for an older rev (a fold toggled meanwhile) would put old
        // layout spans over moved content: drop it.
        if (currentKey.current !== asked) return;
        const runs = r?.runs || [];
        setRunsByTile((m) => { const n = new Map(m); n.set(index, runs); return n; });
        onLoadedRef.current?.(index, runs);
      })
      // The tile stays empty; a later rev (or the next shown set) asks again.
      .catch(() => { if (requested.current.get(index) === p) requested.current.delete(index); });
    requested.current.set(index, p);
    return p;
  }, [docId, rev]);

  useEffect(() => {
    if (docId == null) return;
    for (const i of shownTiles) if (i < meta.tileCount) load(i);
  }, [key, shownTiles, meta.tileCount, load, docId]);

  useImperativeHandle(ref, () => ({
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
        <div key={i} data-tile={i}>
          {groupByRoot(runsByTile.get(i) || []).map((group) => (
            <Root key={`${group.node}@${i}`} runs={group.runs} measure={measure} />
          ))}
        </div>
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

function Root({ runs, measure }) {
  const top = Math.min(...runs.map(r => r.y));
  const left = Math.min(...runs.map(r => r.x));
  let flow = 0;
  return (
    <div className="mv-blitz-root" style={{ position: 'absolute', left, top, whiteSpace: 'pre' }}>
      {runs.map((r) => {
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
        // A <br> is "\n" in the layout text. Inside this one `white-space:pre`
        // flow line it would break the line and shift every later span, so it
        // is drawn as a space: same byte and UTF-16 length, offsets unchanged
        // (copy goes through serialize, which keeps the real newline).
        return <span key={r.start} dir="auto" data-node={r.node} data-start={r.start} style={style}>{r.text.replace(/[\n\r]/g, ' ')}</span>;
      })}
    </div>
  );
}

export default TextLayer;
