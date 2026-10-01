import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { usePrivacyStore, isPrivacyMasking } from '../stores/privacyStore';
import { usePrivacyDictStore, getPrivacyDictionary } from '../utils/privacy/privacyDictionary';
import { findPii, maskText, maskString } from '../utils/privacy/piiDetector';
import { createPeekController } from '../utils/privacy/peekController';
import { isChildWindow } from '../utils/privacy/isChildWindow';

const STRUCTURAL = new Set(['name', 'email', 'filename']);

const subscribeHydration = cb => usePrivacyStore.persist.onFinishHydration(cb);
const isHydrated = () => usePrivacyStore.persist.hasHydrated();

export function usePrivacyActive() {
  const masking = usePrivacyStore(isPrivacyMasking);
  // A detached window hydrates the persisted choice asynchronously, so its
  // first paint would show real names. It masks until that has loaded.
  const hydrated = useSyncExternalStore(subscribeHydration, isHydrated);
  return masking || (isChildWindow() && !hydrated);
}

/**
 * The value split into masked and plain runs, computed in render (never in an
 * effect) so a masked field never paints its real text first. `null` when
 * privacy is off: callers render the plain value.
 */
export function usePrivateSegments(value, kind = 'text') {
  const active = usePrivacyActive();
  const version = usePrivacyDictStore(s => s.version);
  return useMemo(() => {
    if (!active) return null;
    const s = String(value ?? '');
    if (!s) return [];
    if (STRUCTURAL.has(kind)) {
      // A filename keeps its extension: ".pdf" says nothing about anyone.
      const dot = kind === 'filename' ? s.lastIndexOf('.') : -1;
      return dot > 0
        ? [{ text: maskText(s.slice(0, dot)), masked: true }, { text: s.slice(dot), masked: false }]
        : [{ text: maskText(s), masked: true }];
    }
    const spans = findPii(s, getPrivacyDictionary());
    const out = [];
    let last = 0;
    for (const { start, end } of spans) {
      if (start > last) out.push({ text: s.slice(last, start), masked: false });
      out.push({ text: maskText(s.slice(start, end)), masked: true });
      last = end;
    }
    if (last < s.length) out.push({ text: s.slice(last), masked: false });
    return out;
  // version: the dictionary changed underneath the same value
  }, [active, value, kind, version]);
}

/** For title / aria-label / alt: returns the attribute value to render. */
export function usePrivateAttr() {
  const active = usePrivacyActive();
  const version = usePrivacyDictStore(s => s.version);
  return useMemo(() => (value, kind = 'text') => {
    if (!active || !value) return value;
    return STRUCTURAL.has(kind) ? maskText(value) : maskString(value, getPrivacyDictionary());
  }, [active, version]);
}

export function attachPeekToDocument(doc) {
  const win = doc?.defaultView;
  if (!win) return () => {};
  const c = createPeekController({ onChange: on => usePrivacyStore.getState().setPeek(on) });
  const kd = e => c.keydown(e); const ku = e => c.keyup(e); const pd = () => c.pointerdown();
  const bl = () => c.blur(); const vis = () => { if (doc.visibilityState !== 'visible') c.blur(); };
  doc.addEventListener('keydown', kd, true);
  doc.addEventListener('keyup', ku, true);
  doc.addEventListener('pointerdown', pd, true);
  win.addEventListener('blur', bl);
  doc.addEventListener('visibilitychange', vis);
  return () => {
    c.dispose();
    doc.removeEventListener('keydown', kd, true); doc.removeEventListener('keyup', ku, true);
    doc.removeEventListener('pointerdown', pd, true); win.removeEventListener('blur', bl);
    doc.removeEventListener('visibilitychange', vis);
  };
}

/** App-level: peek listeners on the app document, while privacy mode is on. */
export function usePrivacyPeekListeners() {
  const enabled = usePrivacyStore(s => s.enabled);
  useEffect(() => {
    if (!enabled) return undefined;
    return attachPeekToDocument(document);
  }, [enabled]);
}
