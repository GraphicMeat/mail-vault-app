// `cid:` references in a mail body, matched against a part's Content-ID.
//
// The header carries the id raw (`<image001.png@01DC1234.AB56CD70>`); a body
// URL may carry it percent-encoded (`cid:image001.png%4001DC1234.AB56CD70`,
// what Outlook writes). Comparing the two as plain text left the image with no
// bytes and the reading pane drew a bordered empty box. Every reader decodes
// the reference first, so one rule lives here.

// Up to the character that ends a URL in an attribute, a CSS url() or text.
const CID_REF = /cid:([^"'\s)>]+)/gi;

const decodeRef = (ref) => {
  try { return decodeURIComponent(ref); } catch { return ref; }
};

export const bareContentId = (contentId) => contentId?.replace(/^<|>$/g, '') || '';

// Whether `html` shows the part whose Content-ID is `contentId`.
export function htmlReferencesCid(html, contentId) {
  const cid = bareContentId(contentId);
  if (!html || !cid) return false;
  for (const m of html.matchAll(CID_REF)) {
    if (m[1] === cid || decodeRef(m[1]) === cid) return true;
  }
  return false;
}

// Rewrite every `cid:` reference for which `resolve(rawContentId)` answers a
// URL; the rest stay as written.
export function replaceCidRefs(html, resolve) {
  if (!html) return html;
  return html.replace(CID_REF, (whole, ref) => resolve(decodeRef(ref)) ?? resolve(ref) ?? whole);
}
