import { t } from '../i18n/index.js';
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

  // Text a reader would see: a blank line, &nbsp; or a zero-width space is not.
  function hasText(node) {
    return /[^\\s\\u00a0\\u200b-\\u200d\\ufeff]/.test(node.textContent || '');
  }
  function blank(node) {
    return !hasText(node) && !(node.nodeType === 1 && (node.nodeName === 'IMG' || node.querySelector('img')));
  }
  // What follows a node in its parent, less blank text at either end.
  function after(node) {
    var nodes = [];
    for (var n = node.nextSibling; n; n = n.nextSibling) {
      if (n.nodeType === 1 && (n.nodeName === 'SCRIPT' || n.nodeName === 'STYLE')) continue;
      nodes.push(n);
    }
    while (nodes.length && nodes[0].nodeType === 3 && blank(nodes[0])) nodes.shift();
    while (nodes.length && nodes[nodes.length - 1].nodeType === 3 && blank(nodes[nodes.length - 1])) nodes.pop();
    return nodes;
  }

  // Each region is a run of sibling nodes that folds under one toggle. Nothing
  // folds until every region is known: a message that would fold to nothing
  // stays whole.
  var regions = [];
  function inRegion(node) {
    return regions.some(function(r) {
      return r.some(function(n) { return n.contains(node); });
    });
  }

  // 1. Structural quotes — the wrapper a client puts the quote in. Outermost
  //    only: a quote inside a quote folds with it, and Gmail's
  //    blockquote.gmail_quote is one quote, not a match for two selectors.
  //    The line naming who wrote it (Gmail's gmail_attr, Thunderbird's
  //    moz-cite-prefix, localized, so found by class) is never folded.
  var ATTRIBUTION = '.gmail_attr, .moz-cite-prefix';
  var quotes = [].slice.call(document.querySelectorAll('blockquote, .gmail_quote, #appendonsend, .yahoo_quoted'));
  quotes.forEach(function(el) {
    if (quotes.some(function(other) { return other !== el && other.contains(el); })) return;
    // Gmail's wrapper holds the attribution AND the quote: fold what follows it.
    var attribution = [].filter.call(el.children, function(c) { return c.matches(ATTRIBUTION); })[0];
    var nodes = attribution ? after(attribution) : [el];
    // Outlook's #appendonsend is an empty marker: a toggle over nothing.
    if (nodes.some(hasText)) regions.push(nodes);
  });

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
    if (inRegion(el)) continue;
    // A wrapper holding only the quote matches too — keep the tightest header.
    var wrapsAnother = candidates.some(function(other) {
      return other !== el && el.contains(other);
    });
    if (!wrapsAnother) marker = el;
  }
  // Leave the "On … wrote:" line alone when its blockquote is already a
  // region: the attribution stays readable above the toggle.
  var next = marker && marker.nextElementSibling;
  if (marker && !(next && inRegion(next))) {
    var tail = after(marker);
    if (tail.some(hasText)) {
      regions = regions.filter(function(r) {
        return !tail.some(function(n) { return n.contains(r[0]); });
      });
      regions.push(tail);
    }
  }

  // 3. A message must never render as only toggles: a reply that is all quote,
  //    or one typed inside the quote wrapper, is shown whole.
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var own = false;
  for (var text = walker.nextNode(); text && !own; text = walker.nextNode()) {
    if (text.parentNode.closest('script, style, ' + ATTRIBUTION)) continue;
    if (marker && marker.contains(text)) continue;
    own = hasText(text) && !inRegion(text);
  }
  if (!own) return;

  // 4. One toggle per quote: regions with only blank lines between them fold
  //    together.
  regions.sort(function(a, b) {
    return a[0].compareDocumentPosition(b[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  var merged = [];
  regions.forEach(function(r) {
    var prev = merged[merged.length - 1];
    if (prev) {
      var gap = [];
      var n = prev[prev.length - 1].nextSibling;
      while (n && n !== r[0] && blank(n)) { gap.push(n); n = n.nextSibling; }
      if (n === r[0]) {
        merged[merged.length - 1] = prev.concat(gap, r);
        return;
      }
    }
    merged.push(r);
  });

  merged.forEach(function(nodes) {
    if (nodes.length === 1 && nodes[0].nodeType === 1) return fold(nodes[0]);
    var wrap = document.createElement('div');
    nodes[0].parentNode.insertBefore(wrap, nodes[0]);
    nodes.forEach(function(node) { wrap.appendChild(node); });
    fold(wrap);
  });
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
