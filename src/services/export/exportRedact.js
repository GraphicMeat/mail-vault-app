import { redactTree, safeDecode, PII_CLASS } from '../../utils/privacy/redactDom';
import { findPii, maskText, maskString } from '../../utils/privacy/piiDetector';

/**
 * Redaction for exports. Unlike the live reader, nothing here is ever put
 * back: the exported file must not contain the originals in any form, pixels
 * or markup.
 */
const PARTIES = ['from', 'to', 'cc', 'bcc', 'replyTo'];
// The body travels to the document separately (redacted by redactBodyForExport),
// so the message copy carries none of its raw forms.
const RAW_BODIES = ['html', 'text', 'textBody'];

// An HTML export fills masks with █ (no stylesheet decides how a mask looks
// in a file opened anywhere); maskText leaves only x and punctuation.
export const barText = (s) => maskText(s).replace(/x/g, '█');

function maskParty(p, mask) {
  if (!p) return p;
  if (typeof p === 'string') return mask(p);
  return { ...p, name: p.name ? mask(p.name) : p.name, address: p.address ? mask(p.address) : p.address };
}

// `bar`: █ runs instead of x (the HTML export's header card).
export function redactMessageForExport(message, dict, { bar = false } = {}) {
  const mask = bar ? barText : maskText;
  const out = { ...message };
  for (const f of PARTIES) {
    const v = message[f];
    if (v != null) out[f] = Array.isArray(v) ? v.map(p => maskParty(p, mask)) : maskParty(v, mask);
  }
  out.subject = maskString(message.subject || '', dict, mask);
  if (message.snippet) out.snippet = maskString(message.snippet, dict, mask);
  for (const f of RAW_BODIES) delete out[f];
  if (message.messageId) out.messageId = 'xxxx';
  if (Array.isArray(message.attachments)) {
    out.attachments = message.attachments.map((a, i) => {
      const ext = /\.([a-z0-9]{1,8})$/i.exec(a?.filename || '')?.[1];
      return { ...a, filename: `attachment-${i + 1}${ext ? `.${ext.toLowerCase()}` : ''}` };
    });
  }
  return out;
}

export const redactLabel = (text, dict, { bar = false } = {}) => maskString(text, dict, bar ? barText : maskText);

const REMOTE_URL = /url\((?!\s*["']?data:)[^)]*\)/gi;
// Attributes that carry the markup, not the message: kept as they are.
const KEEP_ATTRS = new Set(['class', 'id', 'style']);

export function redactBodyForExport(html, dict, { format }) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  // Never rendered, but serialized: comments (Outlook's <!--[if mso]> blocks
  // hold whole copies of the mail) and <template> content, which the text walk
  // below cannot reach.
  const comments = doc.createTreeWalker(doc.body, 128 /* SHOW_COMMENT */);
  const dead = [];
  for (let n = comments.nextNode(); n; n = comments.nextNode()) dead.push(n);
  for (const el of doc.body.querySelectorAll('template')) dead.push(el);
  dead.forEach(n => n.remove());
  redactTree(doc.body, dict);
  // A link's target (tracking ids, base64 addresses) never renders in an image
  // and must not ship in an HTML file either.
  for (const el of doc.body.querySelectorAll('[href]')) el.removeAttribute('href');
  // Remote images go in both formats: their URLs can carry the recipient, and
  // the rasterizer would fetch them. With mirroring on (the default) every
  // image that loads is a data: URI by now, so only the unreachable ones drop.
  for (const img of doc.body.querySelectorAll('img')) {
    if (!/^data:/i.test(img.getAttribute('src') || '')) img.remove();
  }
  for (const el of doc.body.querySelectorAll('[srcset]')) el.removeAttribute('srcset');
  for (const el of doc.body.querySelectorAll('[background], [poster]')) {
    for (const name of ['background', 'poster']) {
      const v = el.getAttribute(name);
      if (v != null && !/^\s*data:/i.test(v)) el.removeAttribute(name);
    }
  }
  // Filtered in JS, not by [style*="url("]: nwsapi cannot match a parenthesis
  // inside an attribute-substring value (see mirrorRemoteAssets).
  for (const el of doc.body.querySelectorAll('[style]')) {
    const style = el.getAttribute('style');
    if (style.includes('url(')) el.setAttribute('style', style.replace(REMOTE_URL, 'none'));
  }
  for (const el of doc.body.querySelectorAll('style')) {
    el.textContent = (el.textContent || '').replace(REMOTE_URL, 'none');
  }
  // Any other attribute (data-*, action, a meta's content) that names someone
  // goes. After redactTree, so a masked title or alt is filler and stays. A
  // data: URI is a mirrored asset, not text: base64 can look like a number.
  for (const el of doc.body.querySelectorAll('*')) {
    for (const { name, value } of [...el.attributes]) {
      if (KEEP_ATTRS.has(name) || !value || /^\s*data:/i.test(value)) continue;
      if (findPii(safeDecode(value), dict).length) el.removeAttribute(name);
    }
  }
  if (format === 'html') {
    for (const span of doc.body.querySelectorAll(`span.${PII_CLASS}`)) {
      span.replaceWith(doc.createTextNode(span.textContent.replace(/x/g, '█')));
    }
  }
  return doc.body.innerHTML;
}

export const REDACT_CSS = {
  blur: `.${PII_CLASS}{filter:blur(5px)}`,
  bar: `.${PII_CLASS}{background:#16181d;color:#16181d;border-radius:2px}`,
};
