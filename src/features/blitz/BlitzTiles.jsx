import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { tileUrl, hitRender, serializeRender, foldRender } from './service';
import { useSurfaceDoc } from './surfaces/useSurfaceDoc';
import { onDocGone } from './surfaces/docGone';
import { boxStyle, scrollsInside, surfaceWorkerTheme, MIN_OPEN_WIDTH, LAZY_SURFACES } from './surfaces/sizing';
import { foldLabels } from './prepass/folds';
import TextLayer from './text/TextLayer';
import { createCopyController } from './text/clipboard';
import { layerPlainText, selectionInLayer, selectLayer } from './text/selection';
import { useBodyKeyboard } from './text/useBodyKeyboard';
import { applySelectionColors, inactiveSelectionColor, lightSelectionColor } from './text/selectionColors';
import BodyContextMenu from './menu/BodyContextMenu';
import { menuColorsFor } from './menu/menuColors';
import { viewportShift } from '../../hooks/useViewportShift';

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
// pre-pass does not know to mask (a calendar slug, a ?name= query), and the
// root says it is masked (data-blitz-masked) for a capture to read.
// The doc itself comes from the shared registry (surfaces/useSurfaceDoc).
// `surface` names the AltBodyProps surface (root attribute; only the lazy
// surfaces keep their doc for reuse on unmount, and the bubble draws on no
// canvas: surfaceWorkerTheme); `style` joins the sizing box.
const BlitzTiles = forwardRef(function BlitzTiles({ html, theme, onLink, onFailure, onFoldToggled, sizing = 'content', privacy = false, style, surface }, ref) {
  const t = useT();
  const boxRef = useRef(null);
  const [width, setWidth] = useState(0);
  const dpr = useDevicePixelRatio();
  const [hover, setHover] = useState(null);
  const [hoverFold, setHoverFold] = useState(null); // id of the fold toggle under the pointer
  const textLayerRef = useRef(null);
  const copyRef = useRef(null); // the live copy controller (one per rev)
  // The owner (BlitzBody) reaches the selectable text through this: reply quotes the selection under it.
  // selectionText is what a copy would put on the plain clipboard: the serialized text once it is in
  // (a drag or key selection is serialized as it ends), until then the layer's own text.
  useImperativeHandle(ref, () => ({
    layerEl: () => textLayerRef.current?.layerEl() ?? null,
    selectionText: () => {
      const el = textLayerRef.current?.layerEl();
      if (!el) return '';
      return copyRef.current?.cachedText() || layerPlainText(window.getSelection(), el);
    },
  }), []);
  const [shown, setShown] = useState(() => new Set([0, 1]));
  const tileEls = useRef([]);
  const docIdRef = useRef(null);
  const foldSeq = useRef(new Map()); // fold id -> newest toggle issued, so an older refusal cannot undo a newer click
  const docRef = useRef(null); // the latest doc, for a click handler that awaits a hit reply
  const failed = useRef(false);
  const hitBusy = useRef(false);
  const inside = useRef(false);
  const [menu, setMenu] = useState(null); // { at: {x, y}, link, seq }
  const menuSeq = useRef(0); // a right-click answered after a newer one or a doc change opens nothing

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
  const palette = theme?.palette; // the dark poles come from it: a palette change must reopen the doc
  const workerTheme = useMemo(() => surfaceWorkerTheme({ dark, palette }, surface), [dark, palette, surface]);
  // The daemon rejects a width outside 1..4000 css px or a scale outside 0.5..4, which
  // would show the failure view on an ultrawide pane or a zoomed display. The layout
  // below uses the width the daemon answers with (meta.cssWidth), not this request.
  // Under MIN_OPEN_WIDTH there is no real width yet (null params: no doc is opened).
  const cssWidth = width >= MIN_OPEN_WIDTH ? Math.min(4000, Math.max(1, Math.round(width))) : null;
  const scale = Math.min(4, Math.max(0.5, dpr));
  const params = cssWidth ? { html, cssWidth, scale, allowRemote: true, theme: workerTheme } : null;
  const { key: docKeyNow, doc, sentWidth, error, busy, retry } = useSurfaceDoc(params, { deferOnUnmount: LAZY_SURFACES.has(surface) });
  docRef.current = doc;
  docIdRef.current = doc?.docId ?? null;

  // A new key starts with a clean failure latch; a new doc has no hover (toggle ids repeat across docs).
  useEffect(() => { failed.current = false; }, [docKeyNow]);
  useEffect(() => { setHover(null); setHoverFold(null); }, [doc?.docId]);

  // One quiet reopen per failure: the first tile error (or an open that finds its doc gone) discards the doc
  // and opens it again, which hides a worker restart or an eviction. A second failure before the reopened doc
  // has drawn is the user's. Once it has drawn the tile that failed, the budget is back, so a long session's
  // later evictions each get their own quiet reopen. A tile that keeps failing while its siblings draw never
  // refills it (that would reopen forever): `index` is the tile that failed, null when none did (an open).
  const retried = useRef({ key: null, index: null });
  const failOrRetry = useCallback((code, failedDocId, index = null) => {
    if (failed.current) return;
    if (retried.current.key !== docKeyNow) {
      retried.current = { key: docKeyNow, index };
      // Off the live list now: a sibling tile of the discarded doc that errors before the re-render is not a second failure.
      docIdRef.current = null;
      retry(failedDocId);
      return;
    }
    fail(code);
  }, [docKeyNow, retry, fail]);
  const refillRetry = (tileDoc, index) => {
    const r = retried.current;
    if (r.key !== docKeyNow || tileDoc !== docIdRef.current) return;
    // The reopened doc may lay out shorter (images still pending): a tile that no longer exists cannot draw.
    const gone = r.index != null && r.index >= (docRef.current?.meta?.tileCount ?? Infinity);
    if (r.index == null || r.index === index || gone) retried.current = { key: null, index: null };
  };
  // A hit, fold, text-run or serialize call that finds the live doc gone (the worker evicted it) takes the same quiet
  // path as a tile error. A drawn body fires no tile error, so without this it would stay inert (dead links, folds, selection).
  const failOrRetryRef = useRef(failOrRetry);
  failOrRetryRef.current = failOrRetry;
  useEffect(() => onDocGone((id) => {
    if (id === docIdRef.current) failOrRetryRef.current('render_unknown_doc', id);
  }), []);
  useEffect(() => {
    if (!error) return;
    if (error === 'render_unknown_doc') failOrRetry(error); else fail(error);
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // The reply carries both: a toggle inside a link hits the link and the fold.
  const hitAt = useCallback(async (clientX, clientY, target) => {
    if (!doc) return { link: null, fold: null };
    const docId = doc.docId;
    const rect = target.getBoundingClientRect();
    try {
      const r = await hitRender(docId, clientX - rect.left, clientY - rect.top);
      // The doc was closed or replaced while the worker answered.
      if (docIdRef.current !== docId) return { link: null, fold: null };
      return { link: r?.link ?? null, fold: r?.fold ?? null, docId };
    } catch { return { link: null, fold: null }; }
  }, [doc]);

  // The new layout comes back as render-updated (the worker's `updated` frame), the same
  // path every relayout takes; the reply is not applied here. The worker ignores a fold
  // already in the requested state, so a stale double click only re-sends it: nothing waits
  // for a rev. The owner is told at click time, and told back if the worker refuses.
  const toggleFold = useCallback(async (docId, id) => {
    const d = docRef.current;
    const f = d && d.docId === docId ? d.meta?.folds?.find(x => x.id === id) : null;
    if (!f) return;
    const open = !f.open;
    const seq = (foldSeq.current.get(id) ?? 0) + 1;
    foldSeq.current.set(id, seq);
    onFoldToggledRef.current?.(id, open);
    try {
      await foldRender(docId, id, open);
    } catch (e) {
      console.debug('[blitz] fold toggle refused', id, e?.message || e);
      // Undo only our own record: not after a newer click on this fold, and not after the doc
      // was replaced (the new open carries the state the owner recorded for it).
      if (foldSeq.current.get(id) === seq && docIdRef.current === docId) onFoldToggledRef.current?.(id, !open);
    }
  }, []);

  const onMove = useCallback(async (e) => {
    if (hitBusy.current) return;
    hitBusy.current = true;
    inside.current = true;
    const { link, fold } = await hitAt(e.clientX, e.clientY, e.currentTarget);
    hitBusy.current = false;
    if (!inside.current) return;
    // A toggle inside a link is a toggle: no URL chip for what a click will not open. A surface
    // with no onLink has inert links: no pointer and no chip either (folds still work).
    setHover(fold || !onLinkRef.current ? null : link);
    setHoverFold(fold);
  }, [hitAt]);

  const onLeave = useCallback(() => { inside.current = false; setHover(null); setHoverFold(null); }, []);

  const onClick = useCallback(async (e) => {
    // The iframe's menu closes on the next click and that click does nothing else.
    if (menu) { setMenu(null); return; }
    // A click that ended a drag-selection selects text; it never opens a link or toggles a fold.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && selectionInLayer(sel, textLayerRef.current?.layerEl())) return;
    const { link, fold, docId } = await hitAt(e.clientX, e.clientY, e.currentTarget);
    if (fold) { void toggleFold(docId, fold); return; }
    if (link) onLinkRef.current?.(link);
  }, [hitAt, toggleFold, menu]);

  // The menu belongs to the doc it was opened on: a message switch or re-open closes it. A theme or
  // palette flip closes it too: its inline colours are those of the theme it opened in.
  useEffect(() => { menuSeq.current++; setMenu(null); }, [html, doc?.docId, dark, palette]);

  const onContextMenu = useCallback((e) => {
    e.preventDefault();
    const seq = ++menuSeq.current;
    const at = { x: e.clientX, y: e.clientY }; // window coordinates: the menu is fixed
    let opened = false;
    // A toggle is not a link: nothing to copy there, as the click does not open it.
    const linkOf = (hit) => (hit.fold ? null : hit.link);
    // A worker that is slow to answer must not hold the menu back: it opens after 300 ms without
    // Copy Link, and the hit adds the item in place when it lands. An answer for a newer
    // right-click, a doc change or a closed menu is dropped.
    const timer = setTimeout(() => {
      if (opened || seq !== menuSeq.current) return;
      opened = true;
      setMenu({ at, link: null, seq });
    }, 300);
    void hitAt(e.clientX, e.clientY, e.currentTarget).then((hit) => {
      clearTimeout(timer);
      if (seq !== menuSeq.current) return;
      const link = linkOf(hit);
      if (!opened) { opened = true; setMenu({ at, link, seq }); return; }
      if (link) setMenu(m => (m && m.seq === seq && !m.link ? { ...m, link } : m));
    });
  }, [hitAt]);

  // The menu is fixed in the window, outside the body box (which scrolls, clips and can be
  // shorter than the menu): clamp it into the window.
  const clampTo = useCallback((menuEl) => {
    const r = menuEl.getBoundingClientRect();
    const { x, y } = viewportShift(r, { width: menuEl.offsetWidth, height: menuEl.offsetHeight },
      { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight });
    return { dx: x, dy: y };
  }, []);
  const inBody = useCallback((target) => !!boxRef.current?.contains(target), []);

  // Copy: serialize ahead, write synchronously on copy (text/clipboard.js). The
  // controller is rebuilt per rev (a fold toggle changes what a range covers),
  // so it asks again right away for a selection that is already live.
  useEffect(() => {
    if (!doc) return undefined;
    const ctl = createCopyController({
      layerEl: () => textLayerRef.current?.layerEl(),
      serialize: (s, e) => serializeRender(doc.docId, s, e),
    });
    copyRef.current = ctl;
    // A drag is serialized when it ends, a key-driven selection on key up, and
    // anything else (select all, a script) on a short pause.
    const on = [
      ['selectionchange', () => ctl.onSelectionChange()],
      ['pointerdown', (e) => ctl.onPointerDown(e.target)],
      ['pointerup', () => ctl.onPointerUp()],
      ['pointercancel', () => ctl.onPointerUp()],
      ['keyup', () => ctl.onKeyUp()],
      ['copy', (e) => ctl.onCopy(e)],
    ];
    for (const [type, fn] of on) document.addEventListener(type, fn, type !== 'copy');
    const onBlur = () => ctl.onPointerUp(); // a pointer up lost to another window
    window.addEventListener('blur', onBlur);
    ctl.onSelectionChange();
    return () => {
      ctl.dispose();
      if (copyRef.current === ctl) copyRef.current = null;
      for (const [type, fn] of on) document.removeEventListener(type, fn, type !== 'copy');
      window.removeEventListener('blur', onBlur);
    };
  }, [doc?.docId, doc?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // Select all: every tile's runs first (a never-shown tile has none), so the
  // selection covers the whole message and copy serializes all of it.
  const selectAllBody = useCallback(async () => {
    const tl = textLayerRef.current;
    if (!tl) return;
    await tl.loadAll();
    // Two frames: React commits the new spans before we pick first/last.
    const raf = window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 16));
    await new Promise(r => raf(() => raf(r)));
    const layer = tl.layerEl();
    if (layer) selectLayer(layer, tl.firstSpan(), tl.lastSpan());
  }, []);
  useBodyKeyboard(boxRef, { selectAll: selectAllBody, layerEl: () => textLayerRef.current?.layerEl() });

  // Selection colour: the engine's light highlight (grey while the window is inactive) in
  // every theme. The worker paints a dark paper in the dark theme (plan B's Dark Reader port),
  // but nothing wires Dark Reader's colours for the menu and the selection yet: the
  // theme/darkSwatch.js probe seam has no render.inspect probe, so both stay light.
  const paintSelection = useCallback(() => {
    const el = textLayerRef.current?.layerEl();
    if (!el) return;
    const active = lightSelectionColor();
    applySelectionColors(el, active, inactiveSelectionColor(active));
  }, []);
  useEffect(() => { paintSelection(); }, [doc?.docId, paintSelection]);

  // The OS accent colour changes while the app is in the background (System Settings), so the
  // highlight is read again when the window comes back.
  useEffect(() => {
    window.addEventListener('focus', paintSelection);
    return () => window.removeEventListener('focus', paintSelection);
  }, [paintSelection]);

  const m = doc?.meta;
  const labels = useMemo(() => foldLabels(), [t]);
  const hoverFoldInfo = m?.folds?.find(f => f.id === hoverFold);
  // The iframe's quote toggle carries this title; a signature toggle has none.
  const foldTitle = hoverFoldInfo?.kind === 'quote' ? (hoverFoldInfo.open ? labels.quoteHideTitle : labels.quoteShowTitle) : undefined;
  // The parity harness (e2e) reads these to pair this surface with the iframe's.
  const parityAttrs = globalThis.__MV_PARITY__ && doc ? {
    'data-mv-parity-doc': String(doc.docId),
    'data-mv-parity-width': String(sentWidth),
    'data-mv-parity-rev': String(doc.rev),
    'data-mv-parity-theme': dark ? 'dark' : 'light',
  } : null;
  return (
    <div ref={boxRef} data-renderer="blitz" data-testid="blitz-email-body" data-doc-id={doc?.docId} {...parityAttrs}
      data-blitz-surface={surface} aria-busy={busy || (!doc && !error) ? 'true' : 'false'} data-blitz-doc={!busy && doc ? doc.docId : undefined}
      data-blitz-masked={String(privacy)}
      // Focusable like the iframe's document: a click focuses it, Tab leaves it, no ring.
      tabIndex={-1}
      className={`w-full overflow-x-auto relative${scrollsInside(sizing) ? ' overflow-y-auto' : ''}`} style={{ outline: 'none', ...boxStyle(sizing, doc?.meta ?? null, style) }}>
      {m && (
        <div role="presentation" data-blitz-tiles data-capture-exclude title={foldTitle} onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick}
          onContextMenu={onContextMenu}
          style={{ position: 'relative', width: m.cssWidth, height: m.cssHeight, cursor: hover || hoverFold ? 'pointer' : 'default' }}>
          {Array.from({ length: m.tileCount }, (_, i) => {
            const top = i * m.tileCssHeight;
            const tileDoc = doc.docId;
            return (
              <img key={i} ref={el => { tileEls.current[i] = el; }} data-index={i} data-testid="blitz-tile"
                src={shown.has(i) ? tileUrl(doc.docId, doc.rev, i) : undefined}
                alt="" draggable={false} decoding="async"
                // A tile of a doc that was just closed fails by design; only the live doc's tiles count. A doc still on
                // screen while its key's successor opens (busy) is being replaced: its error is not the successor's failure.
                onLoad={() => refillRetry(tileDoc, i)}
                onError={() => { if (tileDoc === docIdRef.current && !busy) failOrRetry('render_tile_failed', tileDoc, i); }}
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
          {menu && (
            <BodyContextMenu
              at={menu.at}
              link={menu.link}
              colors={menuColorsFor(theme, null)} // light in every theme: no dark swatch probe yet (theme/darkSwatch.js)
              clampTo={clampTo}
              inBody={inBody}
              onCopy={() => document.execCommand('copy')}
              onSelectAll={() => { void selectAllBody(); }}
              onClose={() => setMenu(null)}
            />
          )}
        </div>
      )}
      {hover && !privacy && (
        <div data-testid="blitz-link-chip" className="sticky bottom-0 left-0 max-w-[60%] truncate text-xs px-2 py-1 rounded pointer-events-none bg-mail-surface border border-mail-border text-mail-text-muted">
          {hover.href}
        </div>
      )}
      {m && m.links.length > 0 && (
        <nav aria-label={t('blitz.linksInMessage')} className="sr-only">
          {m.links.map((l, i) => (privacy
            // Privacy mode: no href attribute and no href text for assistive tech, only the visible link text.
            ? l.text && (
              <span key={i} role="link" tabIndex={0}
                onClick={() => onLinkRef.current?.(l)}
                // Capture phase: useBodyKeyboard stops every keydown at the body box, before
                // React's bubble-phase handlers (delegated to the app root) would see it.
                onKeyDownCapture={(e) => { if (e.key === 'Enter') { e.preventDefault(); onLinkRef.current?.(l); } }}>{l.text}</span>
            )
            : <a key={i} href={l.href} onClick={(e) => { e.preventDefault(); onLinkRef.current?.(l); }}>{l.text || l.href}</a>
          ))}
        </nav>
      )}
    </div>
  );
});

export default BlitzTiles;
