// ── foldDetection: where a mail's quote and signature are ──
//
// ONE source for two runtimes:
//   - the reading-pane iframe: iframeQuoteFolding.js reads this file ?raw,
//     strips the export keyword, and inlines it into its injected script;
//   - the Blitz pre-pass (src/features/blitz/prepass/folds.js): imports it and
//     runs it on an inert DOMParser document.
// So the two can never fold different things.
//
// Rules for this file, because it runs as raw script text inside the frame:
//   - no imports, and nothing referenced from outside this file;
//   - only `var` / `function` at top level, to keep the inlined text boring;
//   - DOM constants as numbers (a DOMParser document has no window: no
//     NodeFilter, no Node);
//   - no `t()`: labels are the callers' business.

export var SIGNATURE_SELECTORS = ['.gmail_signature', '.yahoo_signature',
  'div[class*="signature"]', 'div[id*="signature"]'];

export var QUOTE_TOGGLE_CSS = 'cursor:pointer;color:#6b7280;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;padding:2px 10px;margin:6px 0;display:inline-block;font-size:13px;user-select:none;';
export var QUOTE_TOGGLE_DARK = { background: '#374151', color: '#9ca3af', borderColor: '#4b5563' };
export var SIGNATURE_TOGGLE_CSS = 'cursor:pointer;color:#9ca3af;font-size:12px;margin:4px 0;user-select:none;';

// The script's own dark test: average of the first three numbers < 128. A
// transparent `rgba(0, 0, 0, 0)` reads as dark; that is today's behaviour.
export function isDarkBackground(cssColor) {
  var m = String(cssColor || '').match(/\d+/g);
  return !!(m && (parseInt(m[0]) + parseInt(m[1]) + parseInt(m[2])) / 3 < 128);
}

export function styleQuoteToggle(toggle, dark) {
  toggle.style.cssText = QUOTE_TOGGLE_CSS;
  if (dark) {
    toggle.style.background = QUOTE_TOGGLE_DARK.background;
    toggle.style.color = QUOTE_TOGGLE_DARK.color;
    toggle.style.borderColor = QUOTE_TOGGLE_DARK.borderColor;
  }
}

// The elements to fold, outermost first in document order. Multi-node regions
// are wrapped in a new div here (the wrap is part of detection: both callers
// fold the wrapper). [] when folding would leave nothing but toggles.
export function quoteFoldTargets(document) {
  // Gmail's "-- " line sits outside .gmail_signature; it is signature too.
  var SIGNATURE = ['.gmail_signature_prefix'].concat(SIGNATURE_SELECTORS).join(', ');

  // Text a reader would see: a blank line, &nbsp; or a zero-width space is not.
  function hasText(node) {
    return /[^\s ​-‍﻿]/.test(node.textContent || '');
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

  // 1. Structural quotes: the wrapper a client puts the quote in. Outermost
  //    only: a quote inside a quote folds with it, and Gmail's
  //    blockquote.gmail_quote is one quote, not a match for two selectors.
  //    The line naming who wrote it (Gmail's gmail_attr, Thunderbird's
  //    moz-cite-prefix, localized, so found by class) is never folded.
  var ATTRIBUTION = '.gmail_attr, .moz-cite-prefix';
  var QUOTES = 'blockquote, .gmail_quote, #appendonsend, .yahoo_quoted';
  var quotes = [].slice.call(document.querySelectorAll(QUOTES));
  quotes.forEach(function(el) {
    if (el.parentElement && el.parentElement.closest(QUOTES)) return;
    // Gmail's wrapper holds the attribution AND the quote: fold what follows it.
    var attribution = [].filter.call(el.children, function(c) { return c.matches(ATTRIBUTION); })[0];
    var nodes = attribution ? after(attribution) : [el];
    // Outlook's #appendonsend is an empty marker: a toggle over nothing.
    if (nodes.some(hasText)) regions.push(nodes);
  });

  // 2. Marker quotes: Fastmail (replying to a message) and Outlook write the
  //    attribution as a plain div and leave the quoted message as its
  //    SIBLINGS. There is no wrapper to select, so read the header text and
  //    fold everything after it.
  var MARKERS = [
    /^\s*-{2,}\s*original message\s*-{2,}/i,
    /^\s*original message/i,
    /^\s*on\b[\s\S]{5,200}\bwrote:\s*$/i,
    /^\s*from:[\s\S]{1,200}\bsent:\s/i,
  ];
  function isMarker(el) {
    var text = (el.textContent || '').replace(/ /g, ' ');
    for (var k = 0; k < MARKERS.length; k++) {
      if (MARKERS[k].test(text)) return true;
    }
    return false;
  }

  var candidates = [].slice.call(document.querySelectorAll('div,p,td')).filter(isMarker);
  var marker = null;
  for (var c = 0; c < candidates.length && !marker; c++) {
    var cand = candidates[c];
    if (inRegion(cand)) continue;
    // A wrapper holding only the quote matches too: keep the tightest header.
    var wrapsAnother = candidates.some(function(other) {
      return other !== cand && cand.contains(other);
    });
    if (!wrapsAnother) marker = cand;
  }
  // Leave the "On ... wrote:" line alone when its blockquote is already a
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
  var walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
  var own = false;
  for (var text = walker.nextNode(); text && !own; text = walker.nextNode()) {
    // A signature is not the reply: the signature script folds it next.
    if (text.parentNode.closest('script, style, ' + ATTRIBUTION + ', ' + SIGNATURE)) continue;
    if (marker && marker.contains(text)) continue;
    own = hasText(text) && !inRegion(text);
  }
  if (!own) return [];

  // 4. One toggle per quote: regions with only blank lines between them fold
  //    together.
  regions.sort(function(a, b) {
    return a[0].compareDocumentPosition(b[0]) & 4 /* FOLLOWING */ ? -1 : 1;
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

  return merged.map(function(nodes) {
    if (nodes.length === 1 && nodes[0].nodeType === 1) return nodes[0];
    var wrap = document.createElement('div');
    nodes[0].parentNode.insertBefore(wrap, nodes[0]);
    nodes.forEach(function(node) { wrap.appendChild(node); });
    return wrap;
  });
}

// Signature elements, in the script's order (each selector's matches, then
// the next selector's), collected BEFORE any is marked. That is today's
// shape: an element matching two selectors is listed twice and folded twice.
// Kept on purpose; the iframe must not change. Callers set
// `dataset.sigFolded = 'true'` per element as they fold it.
export function signatureFoldTargets(document) {
  var found = [];
  for (var i = 0; i < SIGNATURE_SELECTORS.length; i++) {
    var els = document.querySelectorAll(SIGNATURE_SELECTORS[i]);
    for (var j = 0; j < els.length; j++) {
      if (!els[j].dataset.sigFolded) found.push(els[j]);
    }
  }
  return found;
}
