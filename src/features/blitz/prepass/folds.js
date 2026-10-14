// Quote and signature folds for Blitz, marked on the inert pre-pass document
// with the SAME detection the iframe's injected script runs
// (src/utils/foldDetection.js), and the same toggle markup. The worker
// toggles them (render.fold); these data-mv-* attributes are its handles and
// never leave the app (serialize drops them).
import { t } from '../../../i18n/index.js';
import { quoteFoldTargets, signatureFoldTargets, styleQuoteToggle, QUOTE_TOGGLE_DARK, SIGNATURE_TOGGLE_CSS } from '../../../utils/foldDetection';

export function foldLabels() {
  return {
    quoteClosed: '⋯',
    quoteOpen: `▾ ${t('util.iframeQuoteFolding.hideQuotedText')}`,
    quoteShowTitle: t('util.iframeQuoteFolding.showQuotedText'),
    quoteHideTitle: t('util.iframeQuoteFolding.hideQuotedText'),
    sigClosed: `▸ ${t('util.iframeQuoteFolding.showSignature')}`,
    sigOpen: `▾ ${t('util.iframeQuoteFolding.hideSignature')}`,
  };
}

const DARK_STYLE = `background:${QUOTE_TOGGLE_DARK.background};color:${QUOTE_TOGGLE_DARK.color};border-color:${QUOTE_TOGGLE_DARK.borderColor}`;

function mark(region, toggle, { id, kind, open, closedLabel, openLabel }) {
  region.dataset.mvFold = id;
  region.dataset.mvFoldKind = kind;
  region.dataset.mvFoldOpen = open ? 'true' : 'false';
  region.style.display = open ? '' : 'none';
  toggle.dataset.mvFoldToggle = id;
  toggle.setAttribute('data-mv-noselect', '');
  toggle.dataset.mvLabelClosed = closedLabel;
  toggle.dataset.mvLabelOpen = openLabel;
  toggle.textContent = open ? openLabel : closedLabel;
}

/**
 * Marks every fold on `doc` exactly as the iframe scripts would fold it.
 * `signatureDisplay` follows getSignatureFoldingScript: 'always-show' none,
 * 'always-hide' hidden with no toggle, 'smart' and 'collapsed' (and anything
 * unknown) folded under a toggle. Returns the toggleable fold ids in order.
 */
export function markFolds(doc, { foldQuotes = true, signatureDisplay = 'smart', openFolds = new Set(), labels = foldLabels() } = {}) {
  const ids = [];
  if (foldQuotes) {
    quoteFoldTargets(doc).forEach((el, i) => {
      const id = `q${i}`;
      el.dataset.quoteFolded = 'true';
      const toggle = doc.createElement('div');
      toggle.dataset.quoteToggle = 'true';
      toggle.title = labels.quoteShowTitle;
      // Light baseline; the worker applies data-mv-dark-style when the body
      // it computes is dark (the iframe's getComputedStyle test).
      styleQuoteToggle(toggle, false);
      toggle.dataset.mvDarkStyle = DARK_STYLE;
      el.parentNode.insertBefore(toggle, el);
      mark(el, toggle, { id, kind: 'quote', open: openFolds.has(id), closedLabel: labels.quoteClosed, openLabel: labels.quoteOpen });
      ids.push(id);
    });
  }
  if (signatureDisplay !== 'always-show') {
    const hideOnly = signatureDisplay === 'always-hide';
    // The iframe lists an element two selectors match (.gmail_signature is also
    // div[class*="signature"]) twice and gives it two toggles. The worker keeps
    // one toggle per region, so a region folds once here.
    const done = new Set();
    signatureFoldTargets(doc).forEach((el) => {
      if (done.has(el)) return;
      done.add(el);
      el.dataset.sigFolded = 'true';
      if (hideOnly) { el.style.display = 'none'; return; }
      const id = `s${ids.filter(x => x[0] === 's').length}`;
      const toggle = doc.createElement('div');
      toggle.style.cssText = SIGNATURE_TOGGLE_CSS;
      el.parentNode.insertBefore(toggle, el);
      mark(el, toggle, { id, kind: 'signature', open: openFolds.has(id), closedLabel: labels.sigClosed, openLabel: labels.sigOpen });
      ids.push(id);
    });
  }
  return ids;
}
