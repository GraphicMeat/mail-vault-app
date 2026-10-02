import { domToCanvas } from 'modern-screenshot';
import { redactTree } from '../../../utils/privacy/redactDom';
import { EMPTY_DICTIONARY } from '../../../utils/privacy/piiDetector';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { useThemeStore } from '../../../stores/themeStore';
import { PRIVACY_GATE_ID } from '../../../utils/emailIframeTemplate.js';
import { isUiString } from '../../../i18n/index.js';
import { fetchAssetViaTauri } from '../exportService';

/**
 * A 2x picture of the app window (#root) with the message open, for a social
 * image.
 *
 * With `redact`, the live UI is masked for the length of the capture
 * (captureMask: React fields mask in the same render, the reader frames are
 * masked in place by useBodyPrivacy), and the clone is masked again before it
 * is drawn, which catches any text a render site missed.
 *
 * With `theme` ('light' | 'dark') different from the app's, the app is flipped
 * to it for the length of the capture (themeStore's transient captureTheme:
 * the reader frames rebuild in that theme, the CSS variables follow
 * data-theme) and flipped back after. Captures run one at a time, so two
 * overlapping calls never fight over the theme or the mask.
 *
 * With `reveal` (lowercased exact values: a spam sender's name and addresses),
 * those values stay readable while everything else is masked: captureReveal
 * tells the React fields, `dict.reveal` and the keep hook tell the clone pass.
 * With `senderDetails` ({ uid, accountId, mailbox } of the open message), that
 * message's header opens its real sender-details popover for the shot
 * (captureSenderDetails); a popover sits over the message frame, so the frame
 * composite leaves the popover's pixels alone. Both are cleared when the capture
 * ends, however it ends.
 *
 * Message frames are drawn separately: each frame's body is rendered on its
 * own and painted over the frame's visible rect (ruling R16: the probe that
 * would have shown whether the inline clone renders was skipped).
 *
 * Fonts are embedded (unlike the export card, which draws in system fonts):
 * without them the UI falls back to a wider face and every label wraps.
 * Only the families the clone uses are fetched.
 */
const SCALE = 2;

// A remote image in a message is fetched by the daemon: inlining it from the
// webview needs CORS, which most mail image hosts do not send.
async function fetchRemote(url) {
  if (!/^https?:\/\//i.test(url) || /^https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)[:/]/i.test(url)) return false;
  try {
    const asset = await fetchAssetViaTauri(url);
    return asset?.base64 ? `data:${asset.mime};base64,${asset.base64}` : false;
  } catch {
    return false;
  }
}
const RASTER = { scale: SCALE, timeout: 3000, fetchFn: fetchRemote };

export const nextPaint = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 32); return; }
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

// The export dialog, toasts, popovers and Focus lock say so with this attribute.
const keep = (node) => !(node?.nodeType === 1 && node.closest?.('[data-capture-exclude]'));

// ponytail: only whole catalog strings are kept; a label built from a template
// ("Found 36 results in Inbox") is still matched against the names.
// A revealed value (a spam sender's name) is a whole text node of its own.
const chromeHooks = (reveal) => ({ keep: (text) => isUiString(text) || !!reveal?.has(String(text).trim().toLowerCase()) });

// The last clone's text, read by the connected e2e spec: canvas pixels hold no text to assert on.
let lastCloneText = '';

function cloneHook(redact, dict, hooks) {
  return (clone) => {
    // A frame's srcdoc is the raw, unmasked body; the visible content is
    // composited below. Only a frame the cloner cannot read keeps its <iframe>
    // (and srcdoc) in the clone: a same-origin one is cloned as its <html>,
    // which the redaction below walks like any other subtree.
    for (const frame of clone.querySelectorAll?.('iframe[srcdoc]') || []) frame.removeAttribute('srcdoc');
    if (clone.nodeName === 'IFRAME') clone.removeAttribute('srcdoc');
    if (redact) redactTree(clone, dict ?? undefined, hooks);
    if (clone.id === 'root') lastCloneText = clone.textContent || '';
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

// Parts of the app that float over a message frame (the sender-details popover):
// the frame is painted after the clone, so these pixels are put back on top.
async function compositeFrames(canvas, root, onCloneNode) {
  const rootRect = root.getBoundingClientRect();
  const overlays = [...root.querySelectorAll('[data-capture-overlay]')]
    .map(el => intersect(el.getBoundingClientRect(), rootRect))
    .filter(r => r.width > 0 && r.height > 0);
  let beneath = null;
  if (overlays.length) {
    beneath = document.createElement('canvas');
    beneath.width = canvas.width;
    beneath.height = canvas.height;
    beneath.getContext('2d')?.drawImage(canvas, 0, 0);
  }
  let ctx = null;
  for (const iframe of root.querySelectorAll('iframe')) {
    if (!keep(iframe)) continue;
    let doc = null;
    try { doc = iframe.contentDocument; } catch { doc = null; }
    if (!doc?.body) continue;
    const vis = visibleRect(iframe, root);
    if (vis.width <= 0 || vis.height <= 0) continue;

    const body = await domToCanvas(doc.body, { ...RASTER, onCloneNode });
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
  if (ctx && beneath) {
    for (const r of overlays) {
      const x = (r.left - rootRect.left) * SCALE;
      const y = (r.top - rootRect.top) * SCALE;
      ctx.drawImage(beneath, x, y, r.width * SCALE, r.height * SCALE, x, y, r.width * SCALE, r.height * SCALE);
    }
  }
}

// A flipped theme rebuilds every reader frame (a new srcdoc: the document
// reloads, and in dark Dark Reader injects its scripts). Capturing before that
// settles would draw the old theme or a half-painted frame.
const READY_TIMEOUT_MS = 2000;
const POLL_MS = 16;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const frameDoc = (iframe) => {
  try { return iframe.contentDocument; } catch { return null; }
};

function snapshotFrames(root) {
  const snapshot = new Map();
  for (const iframe of root.querySelectorAll('iframe')) {
    if (keep(iframe)) snapshot.set(iframe, { srcdoc: iframe.getAttribute('srcdoc'), doc: frameDoc(iframe) });
  }
  return snapshot;
}

// Every frame whose srcdoc changed (or that is new) has loaded its new document.
function framesReady(root, before, redact) {
  for (const iframe of root.querySelectorAll('iframe')) {
    if (!keep(iframe)) continue;
    const old = before.get(iframe);
    if (old && iframe.getAttribute('srcdoc') === old.srcdoc) continue;
    const doc = frameDoc(iframe);
    if (!doc) continue; // unreadable: the composite skips it too
    if (doc === old?.doc || doc.readyState !== 'complete' || !doc.body) return false;
    if (redact && doc.getElementById(PRIVACY_GATE_ID)) return false;
  }
  return true;
}

async function waitForFrames(root, before, redact) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!framesReady(root, before, redact) && Date.now() < deadline) await sleep(POLL_MS);
  await nextPaint();
}

// Redacted captures queued or in flight. A preview capture and a Save can
// overlap; the mask stays up from the first call until the last one ends, with
// no gap between two back-to-back captures.
let masking = 0;
// Captures run strictly one after the other.
let queue = Promise.resolve();

async function capture({ redact, dict, theme, reveal, senderDetails }) {
  let flipped = false;
  const privacy = usePrivacyStore.getState();
  try {
    const root = document.getElementById('root');
    if (!root) throw new Error('no app root');
    // Reveal only means something while masking, and is never handed to a clone
    // pass that is not masking.
    const shown = redact && reveal?.size ? reveal : null;
    if (redact) {
      privacy.setPeek(false);
      privacy.setCaptureMask(true);
      // Right behind the mask and before the first paint: no frame ever shows the sender masked then not.
      if (shown) privacy.setCaptureReveal(shown);
    }
    if (senderDetails) privacy.setCaptureSenderDetails(senderDetails);
    // One frame for React to render masked, one for the frames' pass to land.
    if (redact || senderDetails) await nextPaint();
    const themes = useThemeStore.getState();
    if ((theme === 'light' || theme === 'dark') && theme !== themes.theme && theme !== themes.captureTheme) {
      // The mask is already up: nothing unmasked paints in the other theme.
      const before = snapshotFrames(root);
      flipped = true;
      themes.setCaptureTheme(theme);
      await nextPaint();
      await waitForFrames(root, before, redact);
    }
    // The dictionary the clone passes read carries the reveal too (copied: the host's is shared).
    const clonedDict = shown ? { ...(dict ?? EMPTY_DICTIONARY), reveal: shown } : dict;
    const canvas = await domToCanvas(root, {
      ...RASTER, filter: keep, onCloneNode: cloneHook(redact, clonedDict, chromeHooks(shown)),
      backgroundColor: getComputedStyle(document.body).backgroundColor || null,
    });
    // A message body is the sender's text, not the app's: no labels are kept.
    await compositeFrames(canvas, root, cloneHook(redact, clonedDict));
    return canvas;
  } finally {
    // Not behind the masking count: a reveal belongs to this capture alone.
    privacy.setCaptureReveal(null);
    privacy.setCaptureSenderDetails(null);
    if (flipped) useThemeStore.getState().setCaptureTheme(null);
    if (redact && --masking === 0) usePrivacyStore.getState().setCaptureMask(false);
  }
}

export function captureAppWindow({ redact, dict, theme, reveal, senderDetails } = {}) {
  if (redact) masking += 1;
  const run = queue.then(() => capture({ redact, dict, theme, reveal: reveal ? new Set([...reveal].map(v => String(v).trim().toLowerCase())) : null, senderDetails }));
  queue = run.catch(() => {});
  return run;
}

// The e2e probe calls the capture without driving the export dialog.
// `VITE_E2E` is a compile-time constant, so a normal build drops this.
if (import.meta.env.VITE_E2E === '1' && typeof window !== 'undefined') {
  window.__MV_CAPTURE_APP__ = captureAppWindow;
  window.__MV_CAPTURE_TEXT__ = () => lastCloneText;
}
