import { redactTree, PII_CLASS } from '../../utils/privacy/redactDom';
import { maskText, maskString } from '../../utils/privacy/piiDetector';

/**
 * Redaction for exports. Unlike the live reader, nothing here is ever put
 * back: the exported file must not contain the originals in any form, pixels
 * or markup.
 */
const PARTIES = ['from', 'to', 'cc', 'bcc', 'replyTo'];
// The body travels to the document separately (redacted by redactBodyForExport),
// so the message copy carries none of its raw forms.
const RAW_BODIES = ['html', 'text', 'textBody'];

function maskParty(p) {
  if (!p) return p;
  if (typeof p === 'string') return maskText(p);
  return { ...p, name: p.name ? maskText(p.name) : p.name, address: p.address ? maskText(p.address) : p.address };
}

export function redactMessageForExport(message, dict) {
  const out = { ...message };
  for (const f of PARTIES) {
    const v = message[f];
    if (v != null) out[f] = Array.isArray(v) ? v.map(maskParty) : maskParty(v);
  }
  out.subject = maskString(message.subject || '', dict);
  if (message.snippet) out.snippet = maskString(message.snippet, dict);
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

export const redactLabel = (text, dict) => maskString(text, dict);

export function redactBodyForExport(html, dict, { format }) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  redactTree(doc.body, dict);
  // A link's target (tracking ids, base64 addresses) never renders in an image
  // and must not ship in an HTML file either.
  for (const el of doc.body.querySelectorAll('[href]')) el.removeAttribute('href');
  // Remote images go in both formats: their URLs can carry the recipient, and
  // the rasterizer would fetch them. With mirroring on (the default) every
  // image that loads is a data: URI by now, so only the unreachable ones drop.
  for (const img of doc.body.querySelectorAll('img')) {
    img.removeAttribute('srcset');
    if (!/^data:/i.test(img.getAttribute('src') || '')) img.remove();
  }
  for (const el of doc.body.querySelectorAll('[style*="url("]')) {
    el.setAttribute('style', el.getAttribute('style').replace(/url\((?!["']?data:)[^)]*\)/gi, 'none'));
  }
  if (format === 'html') {
    // No stylesheet decides how a mask looks in a file opened anywhere: bars are text.
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
