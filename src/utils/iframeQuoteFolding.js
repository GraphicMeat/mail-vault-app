import { t } from '../i18n/index.js';
/**
 * Returns a <script> block to inject into email iframe srcDoc.
 * Finds quoted content elements and makes them collapsible.
 */
export function getQuoteFoldingScript() {
  // Interpolated here, not called inside the template: the script runs in the
  // iframe, which has no `t` — a bare t() call in the body is a ReferenceError
  // the moment the toggle is clicked. JSON.stringify quotes and escapes it.
  const SHOW = JSON.stringify(t('util.iframeQuoteFolding.showQuotedText'));
  const HIDE = JSON.stringify(t('util.iframeQuoteFolding.hideQuotedText'));
  return `
<script>
(function() {
  function fold(el) {
    el.dataset.quoteFolded = 'true';
    el.style.display = 'none';

    var toggle = document.createElement('div');
    toggle.dataset.quoteToggle = 'true';
    toggle.textContent = '\\u22EF';
    toggle.title = ${SHOW};
    toggle.style.cssText = 'cursor:pointer;color:#6b7280;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;padding:2px 10px;margin:6px 0;display:inline-block;font-size:13px;user-select:none;';
    if (document.body) {
      var bg = getComputedStyle(document.body).backgroundColor;
      var m = bg.match(/\\d+/g);
      if (m && (parseInt(m[0]) + parseInt(m[1]) + parseInt(m[2])) / 3 < 128) {
        toggle.style.background = '#374151';
        toggle.style.color = '#9ca3af';
        toggle.style.borderColor = '#4b5563';
      }
    }
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

  // 1. Structural quotes — the wrapper a client puts the quote in.
  var selectors = [
    'blockquote',
    '.gmail_quote',
    '#appendonsend',
    'div[class*="moz-cite"]',
    '.yahoo_quoted',
  ];
  var found = [];
  for (var i = 0; i < selectors.length; i++) {
    var els = document.querySelectorAll(selectors[i]);
    for (var j = 0; j < els.length; j++) {
      if (!els[j].dataset.quoteFolded && !els[j].closest('[data-quote-folded]')) {
        found.push(els[j]);
      }
    }
  }
  found.forEach(fold);

  // 2. Marker quotes — Fastmail (replying to a message) and Outlook write the
  //    attribution as a plain <div> and leave the quoted message as its
  //    SIBLINGS. There is no wrapper to select, so read the header text and
  //    fold everything after it.
  var MARKERS = [
    /^\\s*-{2,}\\s*original message\\s*-{2,}/i,
    /^\\s*original message/i,
    /^\\s*on\\b[\\s\\S]{5,200}\\bwrote:\\s*$/i,
    /^\\s*from:[\\s\\S]{1,200}\\bsent:\\s/i,
  ];
  function isMarker(el) {
    var text = (el.textContent || '').replace(/\\u00a0/g, ' ');
    for (var k = 0; k < MARKERS.length; k++) {
      if (MARKERS[k].test(text)) return true;
    }
    return false;
  }

  var candidates = [].slice.call(document.querySelectorAll('div,p,td')).filter(isMarker);
  var marker = null;
  for (var c = 0; c < candidates.length && !marker; c++) {
    var el = candidates[c];
    if (el.closest('[data-quote-folded]')) continue;
    // A wrapper holding only the quote matches too — keep the tightest header.
    var wrapsAnother = candidates.some(function(other) {
      return other !== el && el.contains(other);
    });
    if (!wrapsAnother) marker = el;
  }
  if (!marker) return;

  // Leave the "On … wrote:" line alone when its blockquote already folded:
  // the attribution stays readable above the toggle, which is the shape the
  // structural pass produces.
  var next = marker.nextElementSibling;
  while (next && next.dataset.quoteToggle) next = next.nextElementSibling;
  if (next && next.dataset.quoteFolded) return;

  var nodes = [];
  for (var n = marker.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n.nodeName === 'SCRIPT' || n.nodeName === 'STYLE')) continue;
    nodes.push(n);
  }
  var quoted = nodes.map(function(node) { return node.textContent || ''; }).join('').trim();
  if (!quoted) return;

  var wrap = document.createElement('div');
  marker.parentNode.insertBefore(wrap, marker.nextSibling);
  nodes.forEach(function(node) { wrap.appendChild(node); });
  fold(wrap);
})();
<\/script>`;
}

/**
 * Returns a <script> block to inject into email iframe srcDoc.
 * Finds signature elements and handles them based on the display mode.
 *
 * @param {'smart' | 'always-show' | 'always-hide' | 'collapsed'} mode
 */
export function getSignatureFoldingScript(mode) {
  if (mode === 'always-show') return '';

  // Validate mode to prevent script injection
  const VALID_MODES = ['smart', 'always-hide', 'collapsed'];
  const safeMode = VALID_MODES.includes(mode) ? mode : 'collapsed';
  const SHOW_SIG = JSON.stringify(t('util.iframeQuoteFolding.showSignature'));
  const HIDE_SIG = JSON.stringify(t('util.iframeQuoteFolding.hideSignature'));

  return `
<script>
(function() {
  var mode = '${safeMode}';
  var sigSelectors = ['.gmail_signature', '.yahoo_signature',
    'div[class*="signature"]', 'div[id*="signature"]'];
  var found = [];
  for (var i = 0; i < sigSelectors.length; i++) {
    var els = document.querySelectorAll(sigSelectors[i]);
    for (var j = 0; j < els.length; j++) {
      if (!els[j].dataset.sigFolded) found.push(els[j]);
    }
  }
  found.forEach(function(el) {
    el.dataset.sigFolded = 'true';
    if (mode === 'always-hide') {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'none';
    var toggle = document.createElement('div');
    toggle.textContent = '\\u2014 ' + ${SHOW_SIG};
    toggle.style.cssText = 'cursor:pointer;color:#9ca3af;font-size:12px;margin:4px 0;user-select:none;';
    toggle.addEventListener('click', function() {
      var visible = el.style.display !== 'none';
      el.style.display = visible ? 'none' : '';
      toggle.textContent = visible ? '\\u2014 ' + ${SHOW_SIG} : '\\u25BE ' + ${HIDE_SIG};
      if (window.parent) {
        window.parent.postMessage({ type: 'iframe-resize', height: document.body.scrollHeight }, '*');
      }
    });
    el.parentNode.insertBefore(toggle, el);
  });
})();
<\/script>`;
}
