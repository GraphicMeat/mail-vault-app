import { findPii, maskText, maskString } from './piiDetector';

/**
 * Masks the people in a DOM subtree in place. Shared by the live reader frame
 * (which keeps the originals through `hooks` so a peek can put them back) and
 * by export/capture clones (which pass no hooks: the originals are gone).
 *
 * Only text nodes and a few attributes are touched, so the mail's own markup
 * survives exactly as written. Same walking rules as iframeSearchHighlight.
 *
 * ponytail: Detection is per text node (a name split across elements, e.g. John <b>Smith</b>,
 * is caught only token-by-token via the dictionary). <textarea> default text is skipped.
 */
export const PII_CLASS = 'mv-pii';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
const TEXT_ATTRS = ['title', 'alt', 'aria-label', 'placeholder', 'value', 'label', 'aria-description'];

function safeDecode(s) {
  return s.replace(/(?:%[0-9a-f]{2})+/gi, m => { try { return decodeURIComponent(m); } catch { return m; } });
}

export function redactTree(root, dict, hooks = {}) {
  if (!root) return 0;
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */, {
    acceptNode: (node) => {
      const parent = node.parentNode;
      if (!node.data.trim() || SKIP_TAGS.has(parent?.nodeName?.toUpperCase())) return 2;
      if (parent?.closest?.(`.${PII_CLASS}`)) return 2;
      return 1;
    },
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);

  let masked = 0;
  for (const node of nodes) {
    const text = node.data;
    const spans = findPii(text, dict);
    if (!spans.length) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const { start, end, kind } of spans) {
      if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
      const span = doc.createElement('span');
      span.className = PII_CLASS;
      span.setAttribute('data-pii', kind);
      span.setAttribute('aria-hidden', 'true');
      const original = text.slice(start, end);
      span.textContent = maskText(original);
      hooks.onText?.(span, original);
      frag.appendChild(span);
      last = end;
      masked++;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }

  const elements = root.querySelectorAll ? [root, ...root.querySelectorAll('*')] : [];
  for (const el of elements) {
    if (!el.getAttribute) continue;
    for (const name of TEXT_ATTRS) {
      const value = el.getAttribute(name);
      if (!value) continue;
      const next = maskString(value, dict);
      if (next !== value) { hooks.onAttr?.(el, name, value); el.setAttribute(name, next); }
    }
    const href = el.getAttribute('href');
    if (href && (/^\s*(mailto|tel):/i.test(href)
      || findPii(safeDecode(href), dict).some(s => s.kind === 'email' || s.kind === 'phone'))) {
      hooks.onAttr?.(el, 'href', href);
      el.removeAttribute('href');
    }
  }
  return masked;
}
