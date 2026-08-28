/**
 * Tracking pixel detection and removal.
 *
 * Marketing mail measures you with a remote image: a 1×1 GIF, a hidden <img>,
 * or a vendor "open" endpoint. Loading it tells the sender you opened the
 * message, when, how often, and from which IP. MailVault's iframe CSP allows
 * `img-src https:`, so those beacons DO fire today — this module is what stops
 * them.
 *
 * Two halves, deliberately split:
 *   - DETECTION runs for everyone. A free user still gets to know that the
 *     message they just opened phoned home, and which company it phoned.
 *   - REMOVAL is the premium half. Callers pass the cleaned body to the iframe
 *     only when `trackerBlockingEnabled && hasPremiumAccess(...)`.
 *
 * Shaped after utils/linkSafety.js — same DOMParser pass, same scoped cache
 * (`accountId-mailbox-uid` + a fingerprint of the body), for the same reason:
 * a bare UID is unique inside ONE mailbox only.
 */

import { bodyStamp } from './linkSafety';
import { TRACKER_PATTERNS } from './trackerList';

/** Path segments that only ever belong to a beacon, not to artwork. */
const BEACON_PATH = /\/(open|opens|beacon|pixel|track|tracking|trk|impression)(\.(gif|png|jpg|jpeg|webp))?(\/|\?|$)|\/o\/|\/q\/|\/wf\/open|open\.(gif|png|aspx|php)/i;

/**
 * Images that are legitimately tiny or hidden. Layout spacers have been 1×1
 * transparent GIFs since the table-layout era, and stripping one is a visible
 * hole in someone's mail. Adopted from MailTrackerBlocker's own false-positive
 * guard, which exists for exactly this reason.
 */
const SPACER_ALLOWLIST = /spacer|transparent\.gif|blank\.gif|pixel\.gif\?$|attachments\.office\.net\/owa\/|apple_logo_web|sidebar-gradient|fedex_collective_logo_/i;

/** Inline styles that put an image out of sight. */
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.)|max-height\s*:\s*0/i;

const _scanCache = new Map();
const MAX_CACHE = 500;

/** Hostname of a URL, lowercase, or '' when it isn't absolute. */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Numeric px value of an attribute or a CSS length, or null. */
function pxValue(raw) {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*(px)?$/i);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Is this <img> a beacon by shape — too small to be seen, or hidden outright?
 * Returns a reason string, or null.
 */
function shapeReason(img) {
  const style = img.getAttribute('style') || '';

  const styleW = pxValue((style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i) || [])[1]);
  const styleH = pxValue((style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i) || [])[1]);
  const attrW = pxValue(img.getAttribute('width'));
  const attrH = pxValue(img.getAttribute('height'));
  const w = styleW ?? attrW;
  const h = styleH ?? attrH;
  if (w !== null && h !== null && w <= 3 && h <= 3) {
    return `Invisible ${w}×${h} image — a read receipt, not a picture`;
  }

  if (HIDDEN_STYLE.test(style)) return 'Image hidden with CSS so you never see it load';
  // A beacon is often wrapped rather than styled itself.
  const hiddenParent = img.closest?.('[style*="display"], [style*="visibility"], [style*="opacity"]');
  if (hiddenParent && hiddenParent !== img && HIDDEN_STYLE.test(hiddenParent.getAttribute('style') || '')) {
    return 'Image hidden inside a collapsed container';
  }
  return null;
}

/**
 * Scan an email body for tracking pixels.
 *
 * @param {string} bodyHtml - inner body HTML (CID-resolved is fine)
 * @param {string|null} key - scoped message key from `emailScopeKey`. null =
 *   don't cache; never fall back to a bare UID, that is how one message's
 *   verdict lands on another's row.
 * @returns {{ trackers: Array, cleanedBodyHtml: string, count: number }}
 */
export function scanTrackers(bodyHtml, key) {
  if (!bodyHtml) return { trackers: [], cleanedBodyHtml: bodyHtml, count: 0 };

  const stamp = key ? bodyStamp(bodyHtml) : null;
  if (stamp) {
    const hit = _scanCache.get(key);
    if (hit && hit.stamp === stamp) return hit.result;
  }

  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${bodyHtml}</body></html>`, 'text/html'
  );

  const trackers = [];
  for (const img of doc.querySelectorAll('img[src]')) {
    const url = img.getAttribute('src') || '';
    // Inline and embedded images never leave the machine.
    if (!url || url.startsWith('cid:') || url.startsWith('data:') || url.startsWith('blob:')) continue;

    const domain = hostOf(url);
    let vendor = null;
    let reason = '';

    for (const [label, re] of TRACKER_PATTERNS) {
      if (re.test(url)) { vendor = label; reason = `${label} open-tracking beacon`; break; }
    }

    if (!vendor) {
      // Only the heuristics can mistake a real image for a beacon, so the
      // spacer allowlist guards them and not the vendor pass above: a known
      // open-tracking endpoint is a tracker whatever it calls its file.
      if (SPACER_ALLOWLIST.test(url)) continue;
      const shape = shapeReason(img);
      if (shape) {
        reason = shape;
      } else if (domain && BEACON_PATH.test(url)) {
        reason = 'Request path is an open-tracking endpoint';
      } else {
        continue;
      }
    }

    trackers.push({
      vendor: vendor || (domain || 'Unknown sender'),
      known: !!vendor,
      domain,
      url,
      reason,
    });

    // Leave a marker where the beacon was: it proves removal happened, and
    // it keeps `hidden` so nothing shifts in the rendered mail. The label is
    // the vendor name or nothing — never the beacon's own host, so that "the
    // tracker's address is gone from the document" stays literally true.
    const marker = doc.createElement('span');
    marker.setAttribute('data-mv-tracker-blocked', vendor || 'tracker');
    marker.setAttribute('hidden', '');
    img.replaceWith(marker);
  }

  const result = {
    trackers,
    // Untouched string when nothing was found — a DOMParser round trip
    // rewrites markup even with no edits, and an unchanged body must stay
    // byte-identical so the iframe's srcDoc doesn't churn.
    cleanedBodyHtml: trackers.length > 0 ? doc.body.innerHTML : bodyHtml,
    count: trackers.length,
  };

  if (stamp) {
    if (_scanCache.size > MAX_CACHE) _scanCache.clear();
    _scanCache.set(key, { stamp, result });
  }
  return result;
}

/** Cached trackers for a scoped key, or null. */
export function getCachedTrackers(key) {
  if (!key) return null;
  return _scanCache.get(key)?.result.trackers ?? null;
}

/**
 * The persisted shape: small enough to keep in settings for every message
 * ever opened, complete enough to name the tracker on a list row without
 * re-fetching the body.
 */
export function summarizeTrackers(trackers) {
  if (!trackers || trackers.length === 0) return null;
  const vendors = [];
  for (const t of trackers) if (!vendors.includes(t.vendor)) vendors.push(t.vendor);
  return { count: trackers.length, vendors };
}
