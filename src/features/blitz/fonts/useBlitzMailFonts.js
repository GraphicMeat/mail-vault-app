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
 * Never throws, and the whole read-and-send is held to PREPARE_CAP_MS: past it
 * the body opens with every family still pending (the hook asks again) and
 * the work carries on, registering what is installed whenever it finishes,
 * which makes the worker rebuild the open doc.
 */
export async function prepareMailFonts(doc) {
  const none = { installed: [], pending: [] };
  let families;
  try { families = mailFontFamilies(...fontSourcesOf(doc)); } catch { return none; }
  if (!families.length) return none;
  const work = (async () => {
    // The store follows download events; ask the daemon only when it may not know a family yet.
    if (!families.every(f => useFontStore.getState().installed.includes(f))) await refreshFonts();
    const have = useFontStore.getState().installed;
    const installed = families.filter(f => have.includes(f));
    const pending = families.filter(f => !have.includes(f));
    if (installed.length) await fontsRender(installed);
    return { installed, pending };
  })();
  work.catch(() => {});
  let timer;
  const cap = new Promise(r => { timer = setTimeout(() => r({ installed: [], pending: families }), PREPARE_CAP_MS); });
  try { return await Promise.race([work, cap]); } catch { return none; } finally { clearTimeout(timer); }
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
    // The store must know what the daemon holds before familyForMail decides (installed => no download).
    const listed = refreshFonts().catch(() => null);
    for (const family of key.split('|')) {
      listed
        .then(() => (gone ? false : familyForMail(family, () => isTrackerBlockingActive())))
        .then(ok => (ok && !gone ? fontsRender([family]) : null))
        .catch(() => {});
    }
    return () => { gone = true; };
  }, [key, messageKey]);
}
