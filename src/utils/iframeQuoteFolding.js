/**
 * Returns a <script> block to inject into email iframe srcDoc.
 * Finds quoted content elements and makes them collapsible.
 */
export function getQuoteFoldingScript() {
  return `
<script>
(function() {
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
  found.forEach(function(el) {
    el.dataset.quoteFolded = 'true';
    el.style.display = 'none';

    var toggle = document.createElement('div');
    toggle.textContent = '\\u22EF';
    toggle.title = 'Show quoted text';
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
      toggle.textContent = visible ? '\\u22EF' : '\\u25BE Hide quoted text';
      toggle.title = visible ? 'Show quoted text' : 'Hide quoted text';
      if (window.parent) {
        window.parent.postMessage({ type: 'iframe-resize', height: document.body.scrollHeight }, '*');
      }
    });
    el.parentNode.insertBefore(toggle, el);
  });
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

  return `
<script>
(function() {
  var mode = '${mode}';
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
    toggle.textContent = '\\u2014 Show signature';
    toggle.style.cssText = 'cursor:pointer;color:#9ca3af;font-size:12px;margin:4px 0;user-select:none;';
    toggle.addEventListener('click', function() {
      var visible = el.style.display !== 'none';
      el.style.display = visible ? 'none' : '';
      toggle.textContent = visible ? '\\u2014 Show signature' : '\\u25BE Hide signature';
      if (window.parent) {
        window.parent.postMessage({ type: 'iframe-resize', height: document.body.scrollHeight }, '*');
      }
    });
    el.parentNode.insertBefore(toggle, el);
  });
})();
<\/script>`;
}
