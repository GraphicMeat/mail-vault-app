import { useEffect } from 'react';
import { fontsRender } from '../service';
import { familyForMail, refreshFonts, useFontStore } from '../../../services/fontService';
import { isTrackerBlockingActive } from '../../../stores/settingsStore';
import { fontSourcesOf, mailFontFamilies } from '../../../utils/mailFonts';

const PREPARE_CAP_MS = 300;

/**
 * Before render.open: the catalogue families this mail is written in, read off
 * the pre-pass document exactly as the iframe reads its own (fontSourcesOf).
 * Installed ones go to the worker now, so the first layout already uses them.
 * Never throws and never holds the open for more than PREPARE_CAP_MS.
 */
export async function prepareMailFonts(doc) {
  try {
    const families = mailFontFamilies(...fontSourcesOf(doc));
    if (!families.length) return { installed: [], pending: [] };
    await refreshFonts();
    const have = useFontStore.getState().installed;
    const installed = families.filter(f => have.includes(f));
    const pending = families.filter(f => !have.includes(f));
    if (installed.length) {
      let timer;
      const cap = new Promise(r => { timer = setTimeout(r, PREPARE_CAP_MS); });
      try { await Promise.race([fontsRender(installed), cap]); } finally { clearTimeout(timer); }
    }
    return { installed, pending };
  } catch {
    return { installed: [], pending: [] };
  }
}

/**
 * After open: download what is missing, the iframe's way (familyForMail:
 * tracker blocking and this session's failures say no, so a blocked mail
 * never makes a font request), and hand each family to the worker when it is
 * ready. The worker re-lays out every document that names it and emits
 * render-updated (the iframe's onFonts moment). A failure leaves the fallback.
 */
export function useBlitzMailFonts({ families, messageKey }) {
  const key = (families || []).join('|');
  useEffect(() => {
    if (!key) return undefined;
    let gone = false;
    for (const family of key.split('|')) {
      familyForMail(family, () => isTrackerBlockingActive())
        .then(ok => (ok && !gone ? fontsRender([family]) : null))
        .catch(() => {});
    }
    return () => { gone = true; };
  }, [key, messageKey]);
}
