// Turn the editor's <img src="data:..."> into cid: references + inline MIME parts.
// Gmail and Outlook.com strip data: URIs, so a pasted/dropped picture only reaches
// the recipient as a real MIME part referenced by Content-ID.

const EXT = { jpeg: 'jpg', 'svg+xml': 'svg' };

// data:<mime>;base64,<payload> — anything else (data:text/plain, non-base64) is left alone.
const DATA_URI = /^data:([^;,]+);base64,(.+)$/s;

export function extractInlineImages(html) {
  if (!html || !html.includes('data:')) return { html, attachments: [] };

  const div = document.createElement('div');
  div.innerHTML = html;
  const imgs = div.querySelectorAll('img[src^="data:"]');

  const attachments = [];
  const bySrc = new Map();   // identical src twice → one part, same cid on both imgs

  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    let cid = bySrc.get(src);
    if (!cid) {
      const m = DATA_URI.exec(src);
      if (!m) continue;
      const [, contentType, content] = m;
      cid = `${crypto.randomUUID()}@mailvault.inline`;
      bySrc.set(src, cid);
      const subtype = contentType.split('/')[1] || 'bin';
      const alt = img.getAttribute('alt') || '';
      attachments.push({
        cid,
        filename: /\.[^.]+$/.test(alt) ? alt : `inline-${attachments.length + 1}.${EXT[subtype] || subtype}`,
        contentType,
        content,
      });
    }
    img.setAttribute('src', 'cid:' + cid);
  }

  // Nothing matched — hand back the ORIGINAL string, not a re-serialised one.
  if (!attachments.length) return { html, attachments: [] };
  return { html: div.innerHTML, attachments };
}
