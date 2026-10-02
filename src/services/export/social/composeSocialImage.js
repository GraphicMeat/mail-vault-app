import { layoutSocial } from './socialLayout';
import { resolveBackground } from './socialBackgrounds';

/**
 * Paints a social image: background, an optional shadow, the card with its
 * macOS-style title bar, and the content canvas on it. Cheap enough to run on
 * every style change; the expensive part (rendering the content) is done once
 * by buildSocialContent.
 */
const CARD_BG = { light: '#ffffff', dark: '#1e1f22' };
const CHROME_BG = { light: '#ececec', dark: '#2b2b2e' };
const LIGHTS = ['#ff5f57', '#febc2e', '#28c840'];
const FADE_PX = 128; // 64 CSS px at 2x
const MARK_MIN_H = 40; // 20 CSS px: the wordmark stays readable
const MARK_INSET = 24;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function paintBackground(ctx, w, h, bg) {
  const r = resolveBackground(bg);
  if (r.kind === 'none') return;
  if (r.kind === 'solid') { ctx.fillStyle = r.color; ctx.fillRect(0, 0, w, h); return; }
  if (r.kind === 'image') {
    // Cover: the image fills the canvas, centered, cut on the long axis.
    const iw0 = r.image.naturalWidth || r.image.width;
    const ih0 = r.image.naturalHeight || r.image.height;
    const s = Math.max(w / iw0, h / ih0);
    const iw = iw0 * s; const ih = ih0 * s;
    ctx.drawImage(r.image, (w - iw) / 2, (h - ih) / 2, iw, ih);
    return;
  }
  const a = (r.angle * Math.PI) / 180;
  const dx = Math.cos(a) * w / 2; const dy = Math.sin(a) * h / 2;
  const g = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
  r.stops.forEach((c, i) => g.addColorStop(i / (r.stops.length - 1), c));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

// The maker's mark sits in the band under the card, right-aligned with it.
// No band to sit in (no padding) puts it in the card's bottom-right corner.
function paintWatermark(ctx, L, mark) {
  const markW0 = mark.naturalWidth || mark.width;
  const markH0 = mark.naturalHeight || mark.height;
  if (!markW0 || !markH0) return;
  const { card } = L;
  const band = L.canvasH - (card.y + card.h);
  const h = Math.round(Math.max(MARK_MIN_H, Math.min(band * 0.45, L.canvasW * 0.035)));
  const w = Math.round((markW0 * h) / markH0);
  const fits = band >= h + MARK_INSET;
  const x = Math.max(MARK_INSET, card.x + card.w - w - (fits ? 0 : MARK_INSET));
  const y = fits ? card.y + card.h + Math.round((band - h) / 2) : card.y + card.h - h - MARK_INSET;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.drawImage(mark, x, y, w, h);
  ctx.restore();
}

/**
 * `watermark` is the decoded maker's mark (loadWatermark); null leaves it off.
 * `maxSize: { w, h }` paints a scaled-down copy that fits inside it (the live
 * preview); omitted, the image is full size (Save).
 */
export function composeSocialImage({ content, size, background, padding, radius, shadow, chrome, theme = 'light', fit, maxSize, watermark = null }) {
  const L = layoutSocial({ contentW: content.width, contentH: content.height, size, padding, chrome, fit });
  const scale = maxSize ? Math.min(1, maxSize.w / L.canvasW, maxSize.h / L.canvasH) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(L.canvasW * scale)); canvas.height = Math.max(1, Math.round(L.canvasH * scale));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  paintBackground(ctx, L.canvasW, L.canvasH, background);
  const r = radius * 2;
  const { x, y, w, h } = L.card;
  if (shadow) {
    ctx.save();
    // Shadows ignore the transform: scaled by hand.
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 80 * scale; ctx.shadowOffsetY = 28 * scale;
    ctx.fillStyle = CARD_BG[theme]; roundRect(ctx, x, y, w, h, r); ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRect(ctx, x, y, w, h, r); ctx.clip();
  ctx.fillStyle = CARD_BG[theme]; ctx.fillRect(x, y, w, h);
  if (chrome) {
    ctx.fillStyle = CHROME_BG[theme]; ctx.fillRect(x, y, w, L.chromeH);
    LIGHTS.forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x + 28 + i * 40, y + L.chromeH / 2, 12, 0, Math.PI * 2); ctx.fill(); });
  }
  const c = L.content;
  ctx.drawImage(content, c.sx, c.sy, c.sw, c.sh, c.dx, c.dy, c.dw, c.dh);
  if (L.cropped) {
    // A cut-off mail fades into the card instead of ending mid-line.
    const g = ctx.createLinearGradient(0, c.dy + c.dh - FADE_PX, 0, c.dy + c.dh);
    g.addColorStop(0, `${CARD_BG[theme]}00`); g.addColorStop(1, CARD_BG[theme]);
    ctx.fillStyle = g; ctx.fillRect(c.dx, c.dy + c.dh - FADE_PX, c.dw, FADE_PX);
  }
  ctx.restore();
  if (watermark) paintWatermark(ctx, L, watermark);
  return canvas;
}
