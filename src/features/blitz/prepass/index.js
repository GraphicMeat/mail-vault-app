import { buildBlitzDocument } from './document';
import { applyPrivacyRedaction } from '../../../utils/iframePrivacyRedact';
import { markFolds } from './folds';
import { markUnselectable } from './unselectable';
import { markSearch } from './search';

// Everything the iframe does with script happens here, on an inert DOMParser
// document (its scripts never run), before the HTML leaves the webview.
// Plans B, C and D extend this function IN PLACE at their numbered step; the
// order is binding (overview, contract amendments).
export async function runPrepass(props, { privacy = { active: false, dict: null }, openFolds = new Set() } = {}) {
  const { documentHtml, bodyHtml, indicatorCss, theme } = props;
  // 1. Build: the exact document the surface's iframe would get, minus viewer scripts.
  //    buildBlitzDocument wraps the same core builder as the iframe (plan B owns the dark
  //    build: themeTag and stripInlineColorImportant follow theme.dark). It emits no
  //    <script> of its own (only a CSP <meta>); scripts arrive through the mail.
  const built = documentHtml ?? buildBlitzDocument({
    bodyHtml,
    indicatorCss,
    dark: !!theme?.dark,
    tableMode: theme?.tableMode ?? 'preserve',
    privacy: false,
  });
  // 2. Parse.
  const doc = new DOMParser().parseFromString(built, 'text/html');
  // Blitz runs no JS. Drop every <script> (a surface's own document, a viewer
  // script, the mail's) and every inline on* handler, so nothing script-shaped
  // reaches the worker whatever the build step produced.
  stripScripts(doc);
  // 3. Folds, on the built document, as the iframe's fold scripts run on theirs
  //    while it parses (before privacy's load-time pass).
  markFolds(doc, { foldQuotes: props.foldQuotes !== false, signatureDisplay: props.signatureDisplay, openFolds });
  // 4. Privacy: the iframe's own redaction. A throw rejects; callers draw nothing.
  if (privacy.active) applyPrivacyRedaction(doc, privacy.dict);
  // 5. What the iframe makes unselectable with CSS, then the open search's marks:
  //    AFTER privacy, so a mark never splits a name before the redaction pass sees it.
  markUnselectable(doc);
  if (props.searchQuery) markSearch(doc, props.searchQuery);
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
