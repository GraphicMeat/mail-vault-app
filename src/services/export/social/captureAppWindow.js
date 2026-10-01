import { domToCanvas } from 'modern-screenshot';
import { redactTree } from '../../../utils/privacy/redactDom';
import { usePrivacyStore } from '../../../stores/privacyStore';

/**
 * A 2x picture of the app window (#root) with the message open, for a social
 * image.
 *
 * With `redact`, the live UI is masked for the length of the capture
 * (captureMask: React fields mask in the same render, the reader frames are
 * masked in place by useBodyPrivacy), and the clone is masked again before it
 * is drawn, which catches any text a render site missed.
 *
 * Message frames are drawn separately: each frame's body is rendered on its
 * own and painted over the frame's visible rect (ruling R16: the probe that
 * would have shown whether the inline clone renders was skipped).
 */
const SCALE = 2;

export const nextPaint = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 32); return; }
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

// The export dialog, toasts, popovers and Focus lock say so with this attribute.
const keep = (node) => !(node?.nodeType === 1 && node.closest?.('[data-capture-exclude]'));

function cloneHook(redact, dict) {
  return (clone) => {
    // A frame's srcdoc is the raw, unmasked body; the visible content is composited below.
    for (const frame of clone.querySelectorAll?.('iframe[srcdoc]') || []) frame.removeAttribute('srcdoc');
    if (clone.nodeName === 'IFRAME') clone.removeAttribute('srcdoc');
    if (redact) redactTree(clone, dict ?? undefined);
  };
}

const intersect = (a, b) => {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

const opaque = (color) => color && color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color);

function frameBackground(iframe, doc) {
  const win = doc.defaultView;
  for (const el of [doc.body, doc.documentElement]) {
    const bg = win?.getComputedStyle(el).backgroundColor;
    if (opaque(bg)) return bg;
  }
  for (let el = iframe.parentElement; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (opaque(bg)) return bg;
  }
  return '#ffffff';
}

/** The part of a frame on screen: clipped by every scrolling or clipping ancestor up to #root. */
function visibleRect(iframe, root) {
  let rect = intersect(iframe.getBoundingClientRect(), root.getBoundingClientRect());
  for (let el = iframe.parentElement; el && el !== root; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll|hidden|clip)/.test(`${cs.overflowX} ${cs.overflowY}`)) rect = intersect(rect, el.getBoundingClientRect());
  }
  return rect;
}

async function compositeFrames(canvas, root, onCloneNode) {
  const rootRect = root.getBoundingClientRect();
  let ctx = null;
  for (const iframe of root.querySelectorAll('iframe')) {
    if (!keep(iframe)) continue;
    let doc = null;
    try { doc = iframe.contentDocument; } catch { doc = null; }
    if (!doc?.body) continue;
    const vis = visibleRect(iframe, root);
    if (vis.width <= 0 || vis.height <= 0) continue;

    const body = await domToCanvas(doc.body, { scale: SCALE, font: false, timeout: 3000, onCloneNode });
    // Where the body's box sits on the app: frame content origin + the body's
    // offset inside the frame (its margin, minus the frame's own scroll).
    const frameRect = iframe.getBoundingClientRect();
    const bodyRect = doc.body.getBoundingClientRect();
    const bx = frameRect.left + iframe.clientLeft + bodyRect.left - rootRect.left;
    const by = frameRect.top + iframe.clientTop + bodyRect.top - rootRect.top;

    ctx ||= canvas.getContext('2d');
    ctx.save();
    ctx.beginPath();
    ctx.rect((vis.left - rootRect.left) * SCALE, (vis.top - rootRect.top) * SCALE, vis.width * SCALE, vis.height * SCALE);
    ctx.clip();
    ctx.fillStyle = frameBackground(iframe, doc);
    ctx.fillRect((vis.left - rootRect.left) * SCALE, (vis.top - rootRect.top) * SCALE, vis.width * SCALE, vis.height * SCALE);
    // Drawn at the body's CSS size: the rasterizer may scale a very tall body
    // down to its maximum canvas size.
    ctx.drawImage(body, bx * SCALE, by * SCALE, bodyRect.width * SCALE, bodyRect.height * SCALE);
    ctx.restore();
  }
}

// Redacted captures in flight. A preview capture and a Save can overlap; the
// first to finish must not lift the mask under the other.
let masking = 0;

export async function captureAppWindow({ redact, dict }) {
  const root = document.getElementById('root');
  if (!root) throw new Error('no app root');
  const privacy = usePrivacyStore.getState();
  if (redact) masking += 1;
  try {
    if (redact) {
      privacy.setPeek(false);
      privacy.setCaptureMask(true);
      // One frame for React to render masked, one for the frames' pass to land.
      await nextPaint();
    }
    const onCloneNode = cloneHook(redact, dict);
    const canvas = await domToCanvas(root, {
      scale: SCALE, font: false, timeout: 3000, filter: keep, onCloneNode,
      backgroundColor: getComputedStyle(document.body).backgroundColor || null,
    });
    await compositeFrames(canvas, root, onCloneNode);
    return canvas;
  } finally {
    if (redact && --masking === 0) usePrivacyStore.getState().setCaptureMask(false);
  }
}
