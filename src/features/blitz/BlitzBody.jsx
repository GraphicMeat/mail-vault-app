import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { AddressText } from '../../components/email/AddressText';
import { maskString } from '../../utils/privacy/piiDetector';
import { emailKey } from '../../stores/slices/unifiedHelpers';
import { runPrepass } from './prepass';
import { usePrivacyDict } from './prepass/privacyDict';
import { prepareMailFonts, useBlitzMailFonts } from './fonts/useBlitzMailFonts';
import BlitzTiles from './BlitzTiles';
import FailureBubble from './FailureBubble';
import { boxStyle, MIN_OPEN_WIDTH, LAZY_SURFACES } from './surfaces/sizing';
import { useNearViewport } from './surfaces/useNearViewport';
import { recordFailure } from './surfaces/debugHook';

// No Dark Reader ever runs on these surfaces' iframes today, so Blitz draws them light too.
const ALWAYS_LIGHT = new Set(['bubble', 'preview']);

const bubbled = new Set(); // message keys that already showed the bubble this session

// A cheap content signature (djb2): tells two messages apart when the caller has no key for them.
const signature = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h >>> 0}`;
};

// The readable text of an HTML body for the failure view. Style, script and
// noscript text is code, not content.
const textOf = (html) => {
  try {
    const body = new DOMParser().parseFromString(html || '', 'text/html').body;
    for (const el of body.querySelectorAll('style, script, noscript, template')) el.remove();
    return body.textContent?.trim() || '';
  } catch { return ''; }
};

/** @type {React.ForwardRefExoticComponent<import('./types').AltBodyProps & React.RefAttributes<{ selectionRoot(): HTMLElement | null, selectionText(): string }>>} */
const BlitzBody = forwardRef(function BlitzBody(props, ref) {
  const { bodyHtml, documentHtml, indicatorCss, plainText, message, onLink, sizing, className, style, surface } = props;
  const t = useT();
  const tilesRef = useRef(null);
  // The surface's theme: bubble and preview never draw dark. Feeds the pre-pass deps (theme?.dark / palette) and the tiles.
  const theme = ALWAYS_LIGHT.has(surface) && props.theme?.dark ? { ...props.theme, dark: false } : props.theme;

  // The gate: nothing is pre-passed or opened until this wrapper has a real width (a hidden pane, a bubble
  // mid-layout) and, on the lazy surfaces, is near the viewport. Boolean state, so a resize re-renders only at the threshold.
  // With no ResizeObserver (some test environments) the width counts as open, as no IntersectionObserver counts as near.
  const wrapRef = useRef(null);
  const [wide, setWide] = useState(() => typeof ResizeObserver === 'undefined');
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setWide(Math.round(e.contentRect.width) >= MIN_OPEN_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const near = useNearViewport(wrapRef, { enabled: LAZY_SURFACES.has(surface) });
  const gateOpen = wide && near;
  // Reply quotes what the user selected: the text layer is real DOM, so the
  // reader's replySelection works on it as on the iframe's body. Null while
  // held for privacy or after a failure (the plain fallback is not the root).
  // selectionText is the selection's copy text (the layer draws a <br> newline
  // as a space, so the DOM's own Selection.toString loses it); '' with no tiles.
  useImperativeHandle(ref, () => ({
    selectionRoot: () => tilesRef.current?.layerEl?.() ?? null,
    selectionText: () => tilesRef.current?.selectionText?.() ?? '',
  }), []);
  // emailScopeKey is null for a message whose location cannot be resolved. All such
  // messages must not share one failure, bubble and pre-pass state, so they get a key
  // from the message's own identity and content.
  const body = documentHtml ?? bodyHtml ?? plainText ?? '';
  const sig = useMemo(() => signature(body), [body]);
  const key = props.messageKey ?? `~${message ? emailKey(message) : ''}~${sig}`;
  const setEmailRenderer = useSettingsStore(s => s.setEmailRenderer);
  // Failure, bubble and pre-passed HTML are stored with the message they belong
  // to and read back only while key still matches. A new message so
  // starts clean in the very render it arrives in, with no frame of the old
  // message's tiles or failure view.
  const [failure, setFailure] = useState(null); // { key, code }
  const [bubble, setBubble] = useState(null); // key whose bubble is open
  const [prepassed, setPrepassed] = useState(null); // { key, html, masked }
  const [pendingFonts, setPendingFonts] = useState(null); // { key, list }: mail fonts not installed yet
  const failed = failure?.key === key;

  // Leaving a message forgets its failure, so coming back to it tries Blitz again.
  useEffect(() => () => { setFailure(null); setBubble(null); }, [key]);

  // The open search re-renders the body (the iframe repaints its live DOM;
  // Blitz has none to repaint). Debounced: typing must not re-open per key.
  const liveQuery = props.searchQuery || '';
  const [query, setQuery] = useState(liveQuery);
  useEffect(() => {
    const id = setTimeout(() => setQuery(liveQuery), 150);
    return () => clearTimeout(id);
  }, [liveQuery]);

  // Folds the user opened, by id, for this message: a re-open (search, fonts)
  // must not fold them again; the iframe keeps them open across a highlight.
  // Held with its message key so a new message starts folded in its first pre-pass.
  const folds = useRef({ key, open: new Set() });
  if (folds.current.key !== key) folds.current = { key, open: new Set() };
  // Bound to its message: a late toggle from the message just left must not open a fold on this one.
  const onFoldToggled = useCallback((id, open) => {
    if (folds.current.key !== key) return;
    if (open) folds.current.open.add(id); else folds.current.open.delete(id);
  }, [key]);

  const priv = usePrivacyDict({ message, messageKey: key });
  // Derived in render, so no frame is ever painted from HTML built for another
  // privacy state: HTML pre-passed unmasked is never served once masking is on
  // (privacy turned on, a peek released, a capture mask), and masked HTML is
  // not served while a peek shows the real text. A hold serves nothing.
  const html = !priv.hold && prepassed?.key === key && prepassed.masked === priv.active ? prepassed.html : null;
  // A privacy hold clears the body at once. Any other re-run (theme, search,
  // folds) keeps the old tiles up until the new HTML lands, so typing a search
  // does not blank the body on every keystroke.
  useEffect(() => {
    if (priv.hold) { setPrepassed(null); return undefined; }
    if (!gateOpen) return undefined;
    let live = true;
    const masked = priv.active;
    runPrepass({ ...props, theme, searchQuery: query }, { privacy: priv, openFolds: folds.current.open })
      // Installed mail fonts reach the worker before the body is handed to the tiles (capped at 300 ms),
      // so the first layout uses them. The rest download after open and reflow the doc when they land.
      .then(async r => ({ ...r, fonts: await prepareMailFonts(r.doc) }))
      .then(r => {
        if (live) setPendingFonts(f => (f && f.key === key && f.list.join('|') === r.fonts.pending.join('|') ? f : { key, list: r.fonts.pending }));
        // Same HTML again keeps the old state object, so an identical re-run renders nothing.
        // `masked` is part of the match: a body with nothing to mask gives the same HTML
        // either way, and must still be served once privacy is on.
        if (live) setPrepassed(p => (p && p.key === key && p.masked === masked && p.html === r.html ? p : { key, html: r.html, masked }));
      })
      .catch(err => { console.error('[blitz] pre-pass failed; the body stays hidden', err); if (live) setPrepassed(null); });
    return () => { live = false; };
  }, [key, bodyHtml, documentHtml, indicatorCss, theme?.tableMode, theme?.dark, theme?.palette, props.signatureDisplay, props.foldQuotes, query, priv.active, priv.dict, priv.hold, gateOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useBlitzMailFonts({ families: pendingFonts?.key === key ? pendingFonts.list : [], messageKey: key });

  const onFailure = (code) => {
    recordFailure(code);
    console.warn('[blitz] could not draw', key, code);
    setFailure({ key, code });
    if (!bubbled.has(key)) { bubbled.add(key); setBubble(key); }
  };

  if (failed) {
    // The standard plain-text view's own masking (AddressText), fed the same
    // dictionary the pre-pass uses: the global names plus this message's own
    // parties. While the dictionary loads (hold) no body text is shown at all.
    // maskString runs first so a name only the message knows is masked too;
    // AddressText then masks again and honours peek, linkifying and the
    // mailto href drop.
    const shown = plainText || textOf(bodyHtml);
    const text = priv.active ? maskString(shown, priv.dict) : shown;
    return (
      <div ref={wrapRef} className={className} style={style}>
        <p data-testid="blitz-failure-notice" className="text-xs text-mail-text-muted mb-2">{t('blitz.failed.notice')}</p>
        {!priv.hold && (
          <div className="email-content email-plain-body whitespace-pre-wrap rounded-lg">
            <AddressText text={text} accountId={props.accountId ?? message?._accountId} />
          </div>
        )}
        <AnimatePresence>
          {bubble === key && (
            <FailureBubble
              key="blitz-failure-bubble"
              onSwitch={() => { setBubble(null); setEmailRenderer('web'); }}
              onDismiss={() => setBubble(null)}
            />
          )}
        </AnimatePresence>
      </div>
    );
  }
  const root = { 'data-renderer': 'blitz', 'data-blitz-surface': surface, 'data-blitz-masked': String(priv.active) };
  // Gate closed: only the wrapper, not busy (a capture does not wait on an overscan row or a hidden bubble).
  if (!gateOpen) return <div ref={wrapRef} {...root} aria-busy="false" className={className} style={boxStyle(sizing, null, style)} />;
  // Held for privacy or still pre-passing: busy, so a capture waits for it and never draws it.
  if (html == null) return <div ref={wrapRef} {...root} aria-busy="true" data-testid="blitz-privacy-hold" className={className} style={boxStyle(sizing, null, style)} />;
  return (
    // The wrapper only carries the class and the measure; the tiles' root is the box (sizing, style).
    <div ref={wrapRef} className={className} style={sizing === 'fill' ? { height: '100%' } : undefined}>
      {/* Keyed on the privacy state: a flip unmounts the old tiles at once (closing their doc),
          so nothing built for the other state stays on screen while the new doc opens.
          A dictionary update while masking stays on does not change the key. */}
      <BlitzTiles ref={tilesRef} key={priv.active ? 'masked' : 'plain'} html={html} theme={theme} onLink={onLink} onFailure={onFailure} sizing={sizing} style={style} surface={surface} transparent={surface === 'bubble'} privacy={priv.active} onFoldToggled={onFoldToggled} />
    </div>
  );
});

export default BlitzBody;
