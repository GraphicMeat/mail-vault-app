import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { usePrivacyStore, isPrivacyMasking } from '../stores/privacyStore';
import { usePrivacyDictStore, getPrivacyDictionary } from '../utils/privacy/privacyDictionary';
import { findPii, maskText, maskString } from '../utils/privacy/piiDetector';
import { createPeekController } from '../utils/privacy/peekController';

const STRUCTURAL = new Set(['name', 'email', 'filename']);

// ponytail: an allowlist, not a shape test: /^\.\w{1,8}$/ also keeps ".smith" of
// "john.smith". An unlisted real extension gets masked too, which is safe; add to the list when one matters.
const FILE_EXTENSIONS = new Set(('pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt csv md pages numbers key '
  + 'png jpg jpeg gif webp heic svg tif tiff bmp mp3 wav m4a mp4 mov avi mkv zip rar gz tar 7z '
  + 'ics vcf eml html htm xml json').split(' '));

/**
 * [stem, extension] of a filename. Only a known file type counts: in "Letter to
 * Mr. Jones" or "john.smith" the tail after the last dot is a name, not a type.
 */
function splitFilename(s) {
  const dot = s.lastIndexOf('.');
  return dot > 0 && FILE_EXTENSIONS.has(s.slice(dot + 1).toLowerCase()) ? [s.slice(0, dot), s.slice(dot)] : [s, ''];
}

const subscribeHydration = cb => usePrivacyStore.persist.onFinishHydration(cb);
const isHydrated = () => usePrivacyStore.persist.hasHydrated();

export function usePrivacyActive() {
  const masking = usePrivacyStore(isPrivacyMasking);
  // Every window hydrates the persisted choice asynchronously (the main one
  // too: safeStorage reads the settings file over IPC), so a first paint would
  // show real names. Masking for those few ms at launch is the cheaper mistake.
  const hydrated = useSyncExternalStore(subscribeHydration, isHydrated);
  return masking || !hydrated;
}

/**
 * The raw message source cannot be masked field by field, so it is withheld
 * while privacy is on, and until the choice is known (fail closed). Peek does
 * not lift it.
 */
export function usePrivacySourceBlocked() {
  const enabled = usePrivacyStore(s => s.enabled);
  const hydrated = useSyncExternalStore(subscribeHydration, isHydrated);
  return enabled || !hydrated;
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
      const [stem, ext] = kind === 'filename' ? splitFilename(s) : [s, ''];
      return ext
        ? [{ text: maskText(stem), masked: true }, { text: ext, masked: false }]
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
    if (kind === 'filename') { const [stem, ext] = splitFilename(String(value)); return maskText(stem) + ext; }
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
