import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { openRender, tileUrl, hitRender, closeRender, onRenderUpdated } from './service';
import TextLayer from './text/TextLayer';

// The device pixel ratio, re-read when it changes (window moved to another
// display, browser zoom). matchMedia is absent in some test environments.
function useDevicePixelRatio() {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [dpr]);
  return dpr;
}

// A body drawn by the daemon's Blitz worker: PNG tiles fetched as they near
// the viewport, links found by hit-testing in the worker. While `privacy` is
// on, the hover URL chip is not drawn at all: a URL can carry a name that the
// pre-pass does not know to mask (a calendar slug, a ?name= query).
export default function BlitzTiles({ html, theme, onLink, onFailure, onFoldToggled, sizing = 'content', privacy = false }) {
  const t = useT();
  const boxRef = useRef(null);
  const [width, setWidth] = useState(0);
  const dpr = useDevicePixelRatio();
  const [doc, setDoc] = useState(null); // { docId, rev, meta }
  const [hover, setHover] = useState(null);
  const [hoverFold, setHoverFold] = useState(null); // set by fold-toggle hover (fold clicks)
  const textLayerRef = useRef(null);
  const [shown, setShown] = useState(() => new Set([0, 1]));
  const tileEls = useRef([]);
  const gen = useRef(0);
  const docIdRef = useRef(null);
  const failed = useRef(false);
  const hitBusy = useRef(false);
  const inside = useRef(false);

  // The callbacks arrive as fresh functions on every parent render. Holding the
  // latest in refs keeps the open effect from closing and reopening the doc.
  const onLinkRef = useRef(onLink);
  const onFailureRef = useRef(onFailure);
  const onFoldToggledRef = useRef(onFoldToggled);
  onLinkRef.current = onLink;
  onFailureRef.current = onFailure;
  onFoldToggledRef.current = onFoldToggled; // called with (id, open) when a fold toggle is clicked

  const fail = useCallback((code) => {
    if (failed.current) return;
    failed.current = true;
    onFailureRef.current?.(code);
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    let timer;
    let first = true;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (!w) return;
      clearTimeout(timer);
      if (first) { first = false; setWidth(w); return; }
      timer = setTimeout(() => setWidth(w), 150);
    });
    ro.observe(el);
    return () => { clearTimeout(timer); ro.disconnect(); };
  }, []);

  const dark = !!theme?.dark;
  useEffect(() => {
    if (!width) return undefined;
    const my = ++gen.current;
    failed.current = false;
    // The daemon rejects a width outside 1..4000 css px or a scale outside 0.5..4, which
    // would show the failure view on an ultrawide pane or a zoomed display. The layout
    // below uses the width the daemon answers with (meta.cssWidth), not this request.
    const cssWidth = Math.min(4000, Math.max(1, Math.round(width)));
    const scale = Math.min(4, Math.max(0.5, dpr));
    openRender({ html, cssWidth, scale, allowRemote: true, theme: { mode: dark ? 'dark' : 'light' } })
      .then((r) => {
        if (my !== gen.current) { closeRender(r.docId); return; }
        // The old doc keeps its tiles on screen until this one replaces it; only then is it closed.
        const prev = docIdRef.current;
        docIdRef.current = r.docId;
        setDoc(r);
        if (prev != null && prev !== r.docId) closeRender(prev);
      })
      // Any rejection is a failure (render_bad_request, render_too_complex, a plain object, a string).
      .catch((e) => { if (my === gen.current) fail(e?.message || e?.code || String(e)); });
    return () => { gen.current++; };
  }, [html, width, dpr, dark, fail]);

  // The current doc closes with the component, not with each re-open.
  useEffect(() => () => {
    if (docIdRef.current != null) { closeRender(docIdRef.current); docIdRef.current = null; }
  }, []);

  useEffect(() => {
    const m = doc?.meta;
    if (!m) return undefined;
    // A re-open of the same message keeps the tiles already near the viewport: a reset would
    // blank everything past the second tile until the observer re-adds it.
    setShown(s => new Set([0, 1, ...[...s].filter(i => i < m.tileCount)]));
    const io = new IntersectionObserver((entries) => {
      const seen = entries.filter(e => e.isIntersecting).map(e => Number(e.target.dataset.index));
      if (seen.length) setShown(s => { const n = new Set(s); seen.forEach(i => n.add(i)); return n; });
    }, { root: boxRef.current?.closest('.overflow-y-auto') ?? null, rootMargin: '100% 0px' });
    tileEls.current.slice(0, m.tileCount).forEach(el => el && io.observe(el));
    return () => io.disconnect();
  }, [doc?.docId, doc?.meta?.tileCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let unlisten = null;
    let gone = false;
    onRenderUpdated((p) => {
      if (p?.docId === docIdRef.current) setDoc(d => (d && d.docId === p.docId ? { ...d, rev: p.rev, meta: p.meta ?? d.meta } : d));
    }).then((u) => { if (gone) u?.(); else unlisten = u; })
      .catch(() => { /* no event bus: the tiles just never update */ });
    return () => { gone = true; unlisten?.(); };
  }, []);

  const hitAt = useCallback(async (clientX, clientY, target) => {
    if (!doc) return null;
    const docId = doc.docId;
    const rect = target.getBoundingClientRect();
    try {
      const r = await hitRender(docId, clientX - rect.left, clientY - rect.top);
      // The doc was closed or replaced while the worker answered.
      return docIdRef.current === docId ? (r?.link ?? null) : null;
    } catch { return null; }
  }, [doc]);

  const onMove = useCallback(async (e) => {
    if (hitBusy.current) return;
    hitBusy.current = true;
    inside.current = true;
    const link = await hitAt(e.clientX, e.clientY, e.currentTarget);
    hitBusy.current = false;
    if (inside.current) setHover(link);
  }, [hitAt]);

  const onLeave = useCallback(() => { inside.current = false; setHover(null); }, []);

  const onClick = useCallback(async (e) => {
    const link = await hitAt(e.clientX, e.clientY, e.currentTarget);
    if (link) onLinkRef.current?.(link);
  }, [hitAt]);

  // 'content' is exactly the document's height; the other two scroll inside.
  const scrollsInside = sizing === 'fill' || (sizing && typeof sizing === 'object');
  const boxStyle = sizing === 'fill' ? { height: '100%' }
    : (sizing && typeof sizing === 'object' ? { maxHeight: sizing.collapsedMax } : undefined);

  const m = doc?.meta;
  return (
    <div ref={boxRef} data-renderer="blitz" data-testid="blitz-email-body" data-doc-id={doc?.docId}
      className={`w-full overflow-x-auto relative${scrollsInside ? ' overflow-y-auto' : ''}`} style={boxStyle}>
      {m && (
        <div role="presentation" onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick}
          onContextMenu={e => e.preventDefault()}
          style={{ position: 'relative', width: m.cssWidth, height: m.cssHeight, cursor: hover ? 'pointer' : 'default' }}>
          {Array.from({ length: m.tileCount }, (_, i) => {
            const top = i * m.tileCssHeight;
            const tileDoc = doc.docId;
            return (
              <img key={i} ref={el => { tileEls.current[i] = el; }} data-index={i} data-testid="blitz-tile"
                src={shown.has(i) ? tileUrl(doc.docId, doc.rev, i) : undefined}
                alt="" draggable={false} decoding="async"
                // A tile of a doc that was just closed fails by design; only the live doc's tiles count.
                onError={() => { if (tileDoc === docIdRef.current) fail('render_tile_failed'); }}
                style={{ position: 'absolute', left: 0, top, width: m.cssWidth, height: Math.min(m.tileCssHeight, m.cssHeight - top) }} />
            );
          })}
          <TextLayer
            ref={textLayerRef}
            docId={doc.docId}
            rev={doc.rev}
            meta={m}
            shownTiles={shown}
            hover={!!hover || !!hoverFold}
          />
        </div>
      )}
      {hover && !privacy && (
        <div data-testid="blitz-link-chip" className="sticky bottom-0 left-0 max-w-[60%] truncate text-xs px-2 py-1 rounded bg-mail-surface border border-mail-border text-mail-text-muted">
          {hover.href}
        </div>
      )}
      {m && m.links.length > 0 && (
        <nav aria-label={t('blitz.linksInMessage')} className="sr-only">
          {m.links.map((l, i) => (
            <a key={i} href={l.href} onClick={(e) => { e.preventDefault(); onLinkRef.current?.(l); }}>{l.text || l.href}</a>
          ))}
        </nav>
      )}
    </div>
  );
}
