import { buildEmailIframeHtml } from '../../../utils/emailIframeTemplate';
import { applyPrivacyRedaction } from '../../../utils/iframePrivacyRedact';

// Everything the iframe does with script happens here, on an inert DOMParser
// document (its scripts never run), before the HTML leaves the webview.
// Plans B, C and D extend this function IN PLACE at their numbered step; the
// order is binding (overview, contract amendments).
export async function runPrepass(props, { privacy = { active: false, dict: null }, openFolds } = {}) { // eslint-disable-line no-unused-vars
  const { documentHtml, bodyHtml, indicatorCss, theme } = props;
  // 1. Build: the exact document the surface's iframe would get, minus viewer scripts.
  //    buildEmailIframeHtml emits no <script> of its own (only a CSP <meta>); scripts
  //    arrive through extraHead/extraBody, passed empty here, and through the mail.
  const built = documentHtml ?? buildEmailIframeHtml({
    bodyHtml,
    themeTag: 'light',
    extraHead: indicatorCss ? `<style>${indicatorCss}</style>` : '',
    extraBody: '',
    privacy: false,
    tableMode: theme?.tableMode ?? 'preserve',
  });
  // 2. Parse.
  const doc = new DOMParser().parseFromString(built, 'text/html');
  // Blitz runs no JS. Drop every <script> (a surface's own document, a viewer
  // script, the mail's) and every inline on* handler, so nothing script-shaped
  // reaches the worker whatever the build step produced.
  stripScripts(doc);
  // 3. Folds (plan C).
  // 4. Privacy: the iframe's own redaction. A throw rejects; callers draw nothing.
  if (privacy.active) applyPrivacyRedaction(doc, privacy.dict);
  // 5. Unselectable marks and search highlight (plan C).
  // 6. Parity ids (plan B).
  // 7. Serialize.
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, doc };
}

function stripScripts(doc) {
  for (const s of doc.querySelectorAll('script')) s.remove();
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
}
