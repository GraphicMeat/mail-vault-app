import { redactTree, PII_CLASS } from './privacy/redactDom';

/**
 * Privacy mode inside a message frame. Same parent-side walking as the search
 * highlighter: the srcDoc is not rebuilt on every change.
 *
 * Originals live in WeakMaps keyed by the replacement node, never in the DOM,
 * so a peek can put them back while nothing that clones or serializes the
 * frame ever finds them.
 */
export const PRIVACY_GATE_ID = 'mv-privacy-gate';
const textOriginals = new WeakMap(); // span -> original text
const attrOriginals = new WeakMap(); // element -> Map(name -> original | null)

export function releasePrivacyGate(doc) {
  doc?.getElementById?.(PRIVACY_GATE_ID)?.remove();
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
