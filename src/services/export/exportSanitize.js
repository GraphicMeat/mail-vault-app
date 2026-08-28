// An exported file is opened outside this app, at file://, where nothing we
// rely on in the viewer applies: no iframe sandbox, no CSP, no link handler.
// Everything executable comes out here, before the bytes are written.
//
// DOMParser, not regex: regex over nested markup is how sanitizers get bypassed.

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

  return doc.body.innerHTML;
}
