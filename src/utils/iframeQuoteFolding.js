import { t } from '../i18n/index.js';
// eslint-disable-next-line import/no-unresolved
import foldDetectionRaw from './foldDetection.js?raw';

// The shared detection as plain script text: the same file the Blitz pre-pass
// imports, so the iframe and Blitz always fold the same thing. Read ?raw (a
// string literal, which minification never rewrites), not Function.toString.
const FOLD_DETECTION_SOURCE = foldDetectionRaw.replace(/^export /gm, '');

/**
 * Returns a <script> block to inject into email iframe srcDoc.
 * Finds quoted content elements and makes them collapsible.
 *
 * @param {string} nonce - the frame's CSP nonce; without it the script-src
 *   'nonce-…' policy blocks this <script>, so callers must pass the same value
 *   they gave buildEmailIframeHtml.
 */
export function getQuoteFoldingScript(nonce = '') {
  // Interpolated here, not called inside the template: the script runs in the
  // iframe, which has no `t` — a bare t() call in the body is a ReferenceError
  // the moment the toggle is clicked. JSON.stringify quotes and escapes it.
  const SHOW = JSON.stringify(t('util.iframeQuoteFolding.showQuotedText'));
  const HIDE = JSON.stringify(t('util.iframeQuoteFolding.hideQuotedText'));
  return `
<script${nonce ? ` nonce="${nonce}"` : ''}>
(function() {
${FOLD_DETECTION_SOURCE}
  function fold(el) {
    el.dataset.quoteFolded = 'true';
    el.style.display = 'none';

    var toggle = document.createElement('div');
    toggle.dataset.quoteToggle = 'true';
    toggle.textContent = '\\u22EF';
    toggle.title = ${SHOW};
    styleQuoteToggle(toggle, !!document.body && isDarkBackground(getComputedStyle(document.body).backgroundColor));
    toggle.addEventListener('click', function() {
      var visible = el.style.display !== 'none';
      el.style.display = visible ? 'none' : '';
      toggle.textContent = visible ? '\\u22EF' : '\\u25BE ' + ${HIDE};
      toggle.title = visible ? ${SHOW} : ${HIDE};
      if (window.parent) {
        window.parent.postMessage({ type: 'iframe-resize', height: document.body.scrollHeight }, '*');
      }
    });
    el.parentNode.insertBefore(toggle, el);
  }
  quoteFoldTargets(document).forEach(fold);
})();
<\/script>`;
}

/**
 * Returns a <script> block to inject into email iframe srcDoc.
 * Finds signature elements and handles them based on the display mode.
 *
 * @param {'smart' | 'always-show' | 'always-hide' | 'collapsed'} mode
 * @param {string} nonce - the frame's CSP nonce (see getQuoteFoldingScript).
 */
export function getSignatureFoldingScript(mode, nonce = '') {
  if (mode === 'always-show') return '';

  // Validate mode to prevent script injection
  const VALID_MODES = ['smart', 'always-hide', 'collapsed'];
  const safeMode = VALID_MODES.includes(mode) ? mode : 'collapsed';
  const SHOW_SIG = JSON.stringify(t('util.iframeQuoteFolding.showSignature'));
  const HIDE_SIG = JSON.stringify(t('util.iframeQuoteFolding.hideSignature'));

  return `
<script${nonce ? ` nonce="${nonce}"` : ''}>
(function() {
${FOLD_DETECTION_SOURCE}
  var mode = '${safeMode}';
  signatureFoldTargets(document).forEach(function(el) {
    el.dataset.sigFolded = 'true';
    if (mode === 'always-hide') {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'none';
    var toggle = document.createElement('div');
    toggle.textContent = '\\u25B8 ' + ${SHOW_SIG};
    toggle.style.cssText = SIGNATURE_TOGGLE_CSS;
    toggle.addEventListener('click', function() {
      var visible = el.style.display !== 'none';
      el.style.display = visible ? 'none' : '';
      toggle.textContent = visible ? '\\u25B8 ' + ${SHOW_SIG} : '\\u25BE ' + ${HIDE_SIG};
      if (window.parent) {
        window.parent.postMessage({ type: 'iframe-resize', height: document.body.scrollHeight }, '*');
      }
    });
    el.parentNode.insertBefore(toggle, el);
  });
})();
<\/script>`;
}
