import { APP_ICONS, normalizeAppIcon } from '../../../utils/appIcon';
import { useSettingsStore } from '../../../stores/settingsStore';
import markUrl from '../../../assets/graphicmeat-watermark.webp';
import { inkForBackground } from './socialBackgrounds';

let pending = null;
let pendingIcon = null;

// The lockup's lettering. Part of the logo, not UI, so it stays English in
// every locale; the heart is drawn as a shape where the glyph is.
export const WATERMARK_BRAND = Object.freeze({ name: 'MailVault', credit: 'made with ♥ by' });

const decode = async (src) => {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
};

/**
 * The lockup's two pictures, decoded once: `{ icon, mark }` (the MailVault app
 * icon and the Graphic Meat logo). Never rejects: a lockup that cannot load
 * gives an image without it (null), and the next call tries again.
 */
export function loadWatermark() {
  const selected = normalizeAppIcon(useSettingsStore.getState().appIcon);
  if (pending && pendingIcon === selected) return pending;
  const iconUrl = APP_ICONS[selected];
  pendingIcon = selected;
  // Cleared from outside the attempt: a throw before the first await would
  // otherwise clear `pending` before it is assigned and cache the failure.
  const attempt = Promise.all([decode(iconUrl), decode(markUrl)])
    .then(([icon, mark]) => ({ icon, mark }))
    .catch(() => {
      if (pending === attempt) pending = null;
      return null;
    });
  pending = attempt;
  return attempt;
}

const MARK_MIN_H = 40; // 20 CSS px: the lockup stays readable
const MARK_INSET = 24;
const FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const HEART = '#e5484d';

// Everything in the lockup is a fraction of its height `h`, so one number
// scales it. Text widths come from the context: they are the font's, not ours.
function measureLockup(ctx, h, wm) {
  const iw = wm.mark.naturalWidth || wm.mark.width;
  const ih = wm.mark.naturalHeight || wm.mark.height;
  const nameFs = h * 0.5;
  const creditFs = nameFs * 0.8;
  const gap = h * 0.3;
  const nameFont = `600 ${nameFs}px ${FAMILY}`;
  const creditFont = `400 ${creditFs}px ${FAMILY}`;
  const [before, after] = WATERMARK_BRAND.credit.split('♥').map(s => s.trim());
  ctx.font = nameFont;
  const nameW = ctx.measureText(WATERMARK_BRAND.name).width;
  ctx.font = creditFont;
  const sp = creditFs * 0.3;
  const heartW = creditFs * 0.9;
  const beforeW = ctx.measureText(before).width;
  const afterW = ctx.measureText(after).width;
  const markW = (iw * h) / ih;
  const total = h + gap + nameW + gap + (beforeW + sp + heartW + sp + afterW) + gap + markW;
  return { h, gap, nameFs, creditFs, nameFont, creditFont, nameW, before, after, beforeW, afterW, sp, heartW, markW, total };
}

function heartPath(ctx, cx, cy, w) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + 0.42 * w);
  ctx.bezierCurveTo(cx - 0.62 * w, cy + 0.02 * w, cx - 0.5 * w, cy - 0.42 * w, cx - 0.25 * w, cy - 0.42 * w);
  ctx.bezierCurveTo(cx - 0.1 * w, cy - 0.42 * w, cx, cy - 0.32 * w, cx, cy - 0.22 * w);
  ctx.bezierCurveTo(cx, cy - 0.32 * w, cx + 0.1 * w, cy - 0.42 * w, cx + 0.25 * w, cy - 0.42 * w);
  ctx.bezierCurveTo(cx + 0.5 * w, cy - 0.42 * w, cx + 0.62 * w, cy + 0.02 * w, cx, cy + 0.42 * w);
  ctx.closePath();
}

/**
 * The maker's lockup, on one line and centered vertically:
 * [MailVault icon] MailVault  made with (heart) by  [Graphic Meat].
 * It sits in the band under the card, right-aligned with it; no band to sit in
 * (no padding) puts it in the card's bottom-right corner. A lockup wider than
 * the room it has (in the band: from the canvas inset to the card's right edge) shrinks to fit it. The lettering is dark on a light background and
 * white on a dark one (white with a soft shadow where the backdrop is an image
 * or empty). `scale` is the preview's: shadows ignore the transform.
 */
export function paintWatermark(ctx, L, wm, background, scale = 1) {
  const { icon, mark } = wm;
  if (!(mark.naturalWidth || mark.width) || !(mark.naturalHeight || mark.height)) return;
  const { card } = L;
  const band = L.canvasH - (card.y + card.h);
  let h = Math.round(Math.max(MARK_MIN_H, Math.min(band * 0.45, L.canvasW * 0.035)));
  const fits = band >= h + MARK_INSET;
  // In the band it may run left past a narrow card, to the canvas inset.
  const maxW = fits ? card.x + card.w - MARK_INSET : card.w - MARK_INSET * 2;
  ctx.save();
  let m = measureLockup(ctx, h, wm);
  if (m.total > maxW && maxW > 0) { h = (h * maxW) / m.total; m = measureLockup(ctx, h, wm); }
  const x0 = Math.max(MARK_INSET, card.x + card.w - m.total - (fits ? 0 : MARK_INSET));
  const y = fits ? card.y + card.h + Math.round((band - h) / 2) : card.y + card.h - h - MARK_INSET;
  const cy = y + h / 2;
  const ink = inkForBackground(background);

  ctx.globalAlpha = 0.9;
  let x = x0;
  ctx.drawImage(icon, x, y, h, h);
  x += h + m.gap;

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = ink.color;
  if (ink.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = h * 0.3 * scale; }
  ctx.font = m.nameFont;
  ctx.fillText(WATERMARK_BRAND.name, x, cy);
  x += m.nameW + m.gap;
  ctx.font = m.creditFont;
  ctx.globalAlpha = 0.72;
  ctx.fillText(m.before, x, cy);
  x += m.beforeW + m.sp;
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = HEART;
  heartPath(ctx, x + m.heartW / 2, cy, m.heartW);
  ctx.fill();
  x += m.heartW + m.sp;
  ctx.fillStyle = ink.color;
  ctx.globalAlpha = 0.72;
  ctx.fillText(m.after, x, cy);
  x += m.afterW + m.gap;

  // The shadow is for the lettering; the logos carry their own contrast.
  ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.9;
  ctx.drawImage(mark, x, y, m.markW, h);
  ctx.restore();
}
