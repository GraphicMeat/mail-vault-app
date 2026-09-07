// An exported file is opened outside this app, at file://, where nothing we
// rely on in the viewer applies: no iframe sandbox, no CSP, no link handler.
// Everything executable comes out here, before the bytes are written.
//
// DOMParser, not regex: regex over nested markup is how sanitizers get bypassed.
//
// The one non-safety pass that lives here: an export is "light always" (see
// EXPORT_CSS), and a mail's own `@media (prefers-color-scheme: dark)` block
// would still fire from the reader's OS and paint the page black under its own
// black text. Every export path runs its body through this one function, so the
// suppression belongs here rather than in each document builder.
import { neutralizeEmailDarkScheme } from '../../utils/emailIframeTemplate';

const DROP_TAGS = ['script', 'iframe', 'object', 'embed', 'applet', 'base'];
const URL_ATTRS = ['href', 'src', 'action', 'formaction'];
const DANGEROUS_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

export function sanitizeForExport(bodyHtml) {
  if (!bodyHtml) return '';

  const doc = new DOMParser().parseFromString(`<body>${bodyHtml}</body>`, 'text/html');

  for (const tag of DROP_TAGS) {
    doc.body.querySelectorAll(tag).forEach(el => el.remove());
  }

  doc.body.querySelectorAll('meta[http-equiv]').forEach(el => {
    if (/refresh/i.test(el.getAttribute('http-equiv') || '')) el.remove();
  });

  doc.body.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(attr.name.toLowerCase()) && DANGEROUS_URL.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  return neutralizeEmailDarkScheme(doc.body.innerHTML);
}
