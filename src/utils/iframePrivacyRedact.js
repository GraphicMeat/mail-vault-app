import { redactTree, PII_CLASS } from './privacy/redactDom';
import { PRIVACY_GATE_ID, PRIVACY_GATE_CSS, PRIVACY_GATE_HTML_STYLE } from './emailIframeTemplate';

/**
 * Privacy mode inside a message frame. Same parent-side walking as the search
 * highlighter: the srcDoc is not rebuilt on every change.
 *
 * Originals live in WeakMaps keyed by the replacement node, never in the DOM,
 * so a peek can put them back while nothing that clones or serializes the
 * frame ever finds them.
 */
export { PRIVACY_GATE_ID };
/** Fired on the <iframe> element when its gate comes off (useSearchHighlight paints then). */
export const PRIVACY_RELEASED_EVENT = 'mv-privacy-released';
const textOriginals = new WeakMap(); // span -> original text
const attrOriginals = new WeakMap(); // element -> Map(name -> original | null)

// Ours is in <head>: an element of the mail's own carrying the id is not the gate.
const gateOf = (doc) => doc?.head?.querySelector?.(`style#${PRIVACY_GATE_ID}`) || null;
const inlineGated = (doc) => doc?.documentElement?.getAttribute?.('style') === PRIVACY_GATE_HTML_STYLE;

/** Whether the body is still held back, unmasked text underneath. */
export function isPrivacyGated(doc) {
  return !!gateOf(doc) || inlineGated(doc);
}

export function releasePrivacyGate(doc) {
  const gate = gateOf(doc);
  const inline = inlineGated(doc);
  if (!gate && !inline) return;
  gate?.remove();
  if (inline) doc.documentElement.removeAttribute('style');
  const host = doc.defaultView?.frameElement;
  const HostEvent = host?.ownerDocument?.defaultView?.Event;
  if (HostEvent) host.dispatchEvent(new HostEvent(PRIVACY_RELEASED_EVENT));
}

/** Fail closed: hide the body again (a masking pass threw). */
export function reinstatePrivacyGate(doc) {
  const root = doc?.documentElement;
  if (!root) return;
  if (!gateOf(doc) && doc.head) {
    const style = doc.createElement('style');
    style.id = PRIVACY_GATE_ID;
    style.textContent = PRIVACY_GATE_CSS;
    doc.head.appendChild(style);
  }
  root.setAttribute('style', PRIVACY_GATE_HTML_STYLE);
}

export function restorePrivacyRedaction(doc) {
  const body = doc?.body;
  if (!body) return;
  for (const span of body.querySelectorAll(`span.${PII_CLASS}`)) {
    const original = textOriginals.get(span);
    if (original == null) continue;
    const parent = span.parentNode;
    parent.replaceChild(doc.createTextNode(original), span);
    parent.normalize();
  }
  for (const el of [body, ...body.querySelectorAll('*')]) {
    const saved = attrOriginals.get(el);
    if (!saved) continue;
    for (const [name, value] of saved) {
      if (value == null) el.removeAttribute(name); else el.setAttribute(name, value);
    }
    attrOriginals.delete(el);
  }
}

export function applyPrivacyRedaction(doc, dict) {
  if (!doc?.body) return 0;
  restorePrivacyRedaction(doc);
  const n = redactTree(doc.body, dict, {
    onText: (span, original) => textOriginals.set(span, original),
    onAttr: (el, name, original) => {
      const saved = attrOriginals.get(el) || new Map();
      if (!saved.has(name)) saved.set(name, original);
      attrOriginals.set(el, saved);
    },
  });
  releasePrivacyGate(doc);
  return n;
}
