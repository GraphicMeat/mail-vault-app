import { wordTokens, wordKey } from '../../../utils/privacy/wordKey';
import { captureMaskOriginal } from '../../../utils/privacy/captureMasks';
import { maskOriginal } from '../../../utils/iframePrivacyRedact';
import { MAX_WORDS, sameWord } from './wordHits';

/**
 * The hit map of the App window shot: every readable word of the live app and
 * of its message frames, with where it sits on the picture, as
 * `[{ k, on, rects }]` (k its wordKey, on whether it is masked now).
 *
 * Measured on the live UI after the capture's masking has landed, so a masked
 * word is the filler on screen and its original comes from the mask itself: a
 * React mask (`.mv-private`) through the capture's mask table by its index, a
 * frame mask (`.mv-pii`) from the pass that made it. A word that does not read
 * as the original or the original masked is left out: a click never lands on
 * the wrong word.
 *
 * A readable word the user marked hide (`hide`, wordKeys) is read as masked: the
 * clone pass masks it, though the live UI still shows it.
 *
 * `keep(node)` is false for what the shot leaves out (the export dialog);
 * `visibleRect(iframe, root)` is the part of a frame on screen.
 */
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'TEXTAREA', 'INPUT', 'SELECT', 'IFRAME']);
const CLIPS = /(auto|scroll|hidden|clip)/;

const intersect = (a, b) => {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

// What a text node's rects may show: clipped by every scrolling or clipping ancestor up to `stop`.
function clipOf(node, stop, base) {
  let clip = base;
  for (let el = node.parentElement; el && el !== stop && clip; el = el.parentElement) {
    const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (cs && CLIPS.test(`${cs.overflowX} ${cs.overflowY}`)) clip = intersect(clip, el.getBoundingClientRect());
  }
  return clip;
}

// A word of the live UI that no mask covers: readable, unless the user marked it hide (the clone pass masks it).
function readPlain(text, hide) {
  const k = wordKey(text);
  return { k, on: !!hide?.has(k) };
}

// original -> on / key, or null when the rendered word is not that word, masked or not.
function readMasked(original, ti, rendered) {
  const t = wordTokens(original)[ti];
  if (!t || !sameWord(t.text, rendered)) return null;
  return { k: t.key, on: rendered !== t.text };
}

/**
 * Words under `container` of `doc`. `origin` is the document viewport's place
 * on the app; `clip` the part of it that shows.
 */
function wordsOf(doc, container, { origin, clip, scale, rootRect, keep, limit, hide }) {
  const out = [];
  const walker = doc.createTreeWalker(container, 4 /* SHOW_TEXT */, {
    acceptNode: (n) => {
      const parent = n.parentElement;
      return !parent || SKIP.has(parent.nodeName.toUpperCase()) || (keep && !keep(parent)) ? 2 : 1;
    },
  });
  for (let n = walker.nextNode(); n && out.length < limit; n = walker.nextNode()) {
    const mask = n.parentElement.closest('.mv-private[data-mv-i], .mv-pii');
    const original = !mask ? null : mask.matches('.mv-pii') ? maskOriginal(mask) : captureMaskOriginal(Number(mask.getAttribute('data-mv-i')));
    if (mask && original == null) continue; // a mask we cannot read back
    const visible = clipOf(n, container, clip);
    for (const [ti, t] of wordTokens(n.data).entries()) {
      const read = original == null ? readPlain(t.text, hide) : readMasked(original, ti, t.text);
      if (!read) continue;
      const range = doc.createRange();
      range.setStart(n, t.start);
      range.setEnd(n, t.end);
      const rects = [...(range.getClientRects?.() ?? [])]
        .map(r => intersect({ left: r.left + origin.x, top: r.top + origin.y, right: r.left + r.width + origin.x, bottom: r.top + r.height + origin.y }, visible))
        .filter(r => r.width > 0 && r.height > 0)
        .map(r => [(r.left - rootRect.left) * scale, (r.top - rootRect.top) * scale, r.width * scale, r.height * scale]);
      if (rects.length) out.push({ ...read, rects });
    }
  }
  return out;
}

export function collectAppWords(root, { scale = 1, keep, visibleRect, hide }) {
  const rootRect = root.getBoundingClientRect();
  const base = { left: rootRect.left, top: rootRect.top, right: rootRect.right, bottom: rootRect.bottom, width: rootRect.width, height: rootRect.height };
  const words = wordsOf(root.ownerDocument, root, { origin: { x: 0, y: 0 }, clip: base, scale, rootRect, keep, limit: MAX_WORDS, hide });
  for (const iframe of root.querySelectorAll('iframe')) {
    if (words.length >= MAX_WORDS) break;
    if (keep && !keep(iframe)) continue;
    let fdoc = null;
    try { fdoc = iframe.contentDocument; } catch { fdoc = null; }
    if (!fdoc?.body) continue;
    const vis = visibleRect(iframe, root);
    if (vis.width <= 0 || vis.height <= 0) continue;
    const box = iframe.getBoundingClientRect();
    words.push(...wordsOf(fdoc, fdoc.body, {
      origin: { x: box.left + iframe.clientLeft, y: box.top + iframe.clientTop }, clip: vis,
      scale, rootRect, keep: null, limit: MAX_WORDS - words.length, hide,
    }));
  }
  return words;
}
