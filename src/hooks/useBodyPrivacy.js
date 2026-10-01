import { useLayoutEffect, useRef } from 'react';
import { usePrivacyActive, attachPeekToDocument } from './usePrivacy';
import { usePrivacyStore } from '../stores/privacyStore';
import { usePrivacyDictStore, getPrivacyDictionary, isPrivacyDictionaryReady } from '../utils/privacy/privacyDictionary';
import { applyPrivacyRedaction, restorePrivacyRedaction, releasePrivacyGate, PRIVACY_GATE_ID } from '../utils/iframePrivacyRedact';

// When the pass first saw each frame document: the readiness wait is per
// document, so a dictionary update mid-wait does not restart the clock.
const firstSeen = new WeakMap();

const frameDoc = (iframe) => {
  try { return iframe.contentDocument || iframe.contentWindow?.document || null; } catch { return null; }
};

/**
 * Whether a frame's srcDoc must start gated (buildEmailIframeHtml `privacy`):
 * privacy on, peeking or not, so a peek never reloads the frame; or a detached
 * window that has not read the persisted choice yet (usePrivacyActive).
 * A capture's captureMask does not gate: reloading would hand the capture a
 * blank frame, and the pass below masks the one on screen in place before paint.
 */
export function usePrivacyFrameGate() {
  const enabled = usePrivacyStore(s => s.enabled);
  const captureMask = usePrivacyStore(s => s.captureMask);
  const active = usePrivacyActive();
  return enabled || (active && !captureMask);
}

/**
 * A layout effect re-run when `deps` change OR the frame element does. The
 * element is read as committed, not at render: a remounted <iframe> showing
 * the same srcDoc (a branch that toggles, thread to single on one message)
 * would otherwise load its gated document with nobody listening, and stay
 * blank. Kept a layout effect, not state plus a re-render, so on mount it is
 * still attached before useSearchHighlight's passive effect.
 */
function useFrameEffect(iframeRef, effect, deps) {
  const current = useRef(null); // { frame, deps, cleanup }
  useLayoutEffect(() => {
    const frame = iframeRef?.current || null;
    const was = current.current;
    if (was && was.frame === frame && was.deps.every((d, i) => Object.is(d, deps[i]))) return;
    was?.cleanup?.();
    current.current = { frame, deps, cleanup: frame ? effect(frame) : undefined };
  });
  useLayoutEffect(() => () => { current.current?.cleanup?.(); current.current = null; }, []);
}

/**
 * Masks a message frame while privacy mode is on.
 *
 * MUST be called before useSearchHighlight in the same component: both run on
 * the frame's `load`, and listeners fire in the order they were added, so the
 * mask lands first. (The mask is a layout effect, so on mount it is added
 * first anyway.)
 *
 * The frame arrives gated (body hidden, see buildEmailIframeHtml `privacy`).
 * The gate comes off only in applyPrivacyRedaction, so the real text never
 * paints. While the contacts index is still loading, the gate is held for up
 * to `readyTimeoutMs`; after that the frame shows with what the dictionary
 * has (patterns plus every name on loaded headers), and is masked again when
 * the index lands.
 */
export function useBodyPrivacy(iframeRef, contentKey, { readyTimeoutMs = 3000 } = {}) {
  const active = usePrivacyActive();
  const enabled = usePrivacyStore(s => s.enabled);
  const version = usePrivacyDictStore(s => s.version);

  // Layout timing: when masking turns on or a peek ends, the frame on screen
  // is masked before the next paint, in step with the React-rendered fields.
  useFrameEffect(iframeRef, (iframe) => {
    let observer = null;
    let timer = null;

    const pass = () => {
      const doc = frameDoc(iframe);
      if (!doc?.body) return;
      observer?.disconnect();
      observer = null;
      clearTimeout(timer);
      if (!active) {
        restorePrivacyRedaction(doc);
        releasePrivacyGate(doc);
        return;
      }
      if (!firstSeen.has(doc)) firstSeen.set(doc, Date.now());
      // Only a gated frame is worth holding: one already on screen is masked
      // now with what the dictionary has.
      if (!isPrivacyDictionaryReady() && doc.getElementById(PRIVACY_GATE_ID)
        && Date.now() - firstSeen.get(doc) < readyTimeoutMs) {
        timer = setTimeout(pass, 150);
        return; // gate stays on
      }
      applyPrivacyRedaction(doc, getPrivacyDictionary());
      const MO = doc.defaultView?.MutationObserver;
      if (MO) {
        // Runs as a microtask, before the next paint: new text is masked before it is seen.
        observer = new MO(pass);
        observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
      }
    };

    pass();
    iframe.addEventListener('load', pass);
    return () => {
      iframe.removeEventListener('load', pass);
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, [contentKey, active, version, readyTimeoutMs]);

  // Option-hold peek from inside the frame. Its own effect: a peek flips
  // `active` above, and re-running this with it would dispose the listener
  // holding the peek, so the keyup that ends it would never be seen.
  useFrameEffect(iframeRef, (iframe) => {
    if (!enabled) return undefined;
    let detach = () => {};
    const attach = () => {
      detach();
      const doc = frameDoc(iframe);
      detach = doc ? attachPeekToDocument(doc) : () => {};
    };
    attach();
    iframe.addEventListener('load', attach);
    return () => {
      iframe.removeEventListener('load', attach);
      detach();
    };
  }, [contentKey, enabled]);
}
