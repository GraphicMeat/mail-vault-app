import { useLayoutEffect, useMemo, useRef } from 'react';
import { usePrivacyActive, attachPeekToDocument } from './usePrivacy';
import { usePrivacyStore } from '../stores/privacyStore';
import { usePrivacyDictStore, getPrivacyDictionary, isPrivacyDictionaryReady, collectPrivacyNames } from '../utils/privacy/privacyDictionary';
import { buildNameDictionary, unionDictionaries } from '../utils/privacy/piiDetector';
import {
  applyPrivacyRedaction, restorePrivacyRedaction, releasePrivacyGate, reinstatePrivacyGate, isPrivacyGated,
} from '../utils/iframePrivacyRedact';

// When the pass first saw each frame document: the readiness wait is per
// document, so a dictionary update mid-wait does not restart the clock.
const firstSeen = new WeakMap();
let failureLogged = false;

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
 * the index lands. `message`, the message in this frame, adds its own
 * parties to this frame's pass, so they are masked even if the global
 * dictionary never arrives.
 * ponytail: the hold is a blank frame; the spec's small spinner is not built,
 * revisit if a held frame reads as broken.
 *
 * A pass that throws fails closed: the gate goes back on and the body stays
 * hidden until a later pass succeeds.
 */
export function useBodyPrivacy(iframeRef, contentKey, { message = null, readyTimeoutMs = 3000 } = {}) {
  const active = usePrivacyActive();
  const enabled = usePrivacyStore(s => s.enabled);
  const version = usePrivacyDictStore(s => s.version);
  // Keyed by the names, not the object: callers often pass a fresh merge per render.
  const ownKey = useMemo(() => (message ? collectPrivacyNames({ emails: [message] }).join('\u0000') : ''), [message]);
  const ownDict = useMemo(() => (ownKey ? buildNameDictionary({ names: ownKey.split('\u0000') }) : null), [ownKey]);

  // Layout timing: when masking turns on or a peek ends, the frame on screen
  // is masked before the next paint, in step with the React-rendered fields.
  useFrameEffect(iframeRef, (iframe) => {
    let observer = null;
    let timer = null;
    let dict = null; // built once per run: the run restarts on every dictionary change
    const dictNow = () => (dict ||= unionDictionaries(getPrivacyDictionary(), ownDict));

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
      try {
        if (!firstSeen.has(doc)) firstSeen.set(doc, Date.now());
        // Only a gated frame is worth holding: one already on screen is masked
        // now with what the dictionary has.
        if (!isPrivacyDictionaryReady() && isPrivacyGated(doc)
          && Date.now() - firstSeen.get(doc) < readyTimeoutMs) {
          timer = setTimeout(pass, 150);
          return; // gate stays on
        }
        applyPrivacyRedaction(doc, dictNow());
      } catch (err) {
        reinstatePrivacyGate(doc);
        if (!failureLogged) { failureLogged = true; console.error('[privacy] masking a message frame failed; it stays hidden', err); }
        return;
      }
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
  }, [contentKey, active, version, ownDict, readyTimeoutMs]);

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
