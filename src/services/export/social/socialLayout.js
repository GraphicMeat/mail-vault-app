// Where the card and its content sit on a social image. Pure math, so the
// painter (composeSocialImage) only draws what this decides.
//
// Every output pixel is 2x: the content canvas comes from the rasterizer at
// 2x already, a preset of 1080x1080 is saved as 2160x2160, and padding is
// given in CSS px.
export const SIZE_PRESETS = {
  auto: null,
  square: { w: 1080, h: 1080 },
  portrait: { w: 1080, h: 1350 },
  landscape: { w: 1600, h: 900 },
  story: { w: 1080, h: 1920 },
};
// The corner radius of a macOS Tahoe window: the Radius slider's tick, and its default.
export const MACOS_WINDOW_RADIUS = 26;
// Where a value sits along a range input, as a CSS `left` for a mark drawn over
// it: the thumb's centre travels from half a thumb in to half a thumb short of
// the far end, not the full width.
export const rangeMarkLeft = (value, min, max, thumbPx = 16) =>
  `calc(${thumbPx / 2}px + ${(value - min) / (max - min)} * (100% - ${thumbPx}px))`;
const CHROME_CSS_PX = 28;
const OUT = 2; // output pixels per CSS px, and per preset px

/**
 * auto: the canvas is the card plus padding, content drawn 1:1.
 * fixed size: the whole content is fitted inside the canvas (contain), centered,
 * so a tall mail shrinks rather than being cut.
 */
export function layoutSocial({ contentW, contentH, size, padding, chrome }) {
  const pad = padding * OUT;
  const chromeH = chrome ? CHROME_CSS_PX * OUT : 0;
  if (!size) {
    const card = { x: pad, y: pad, w: contentW, h: contentH + chromeH };
    return {
      canvasW: contentW + pad * 2, canvasH: card.h + pad * 2, card, chromeH,
      content: { sx: 0, sy: 0, sw: contentW, sh: contentH, dx: pad, dy: pad + chromeH, dw: contentW, dh: contentH },
    };
  }
  const canvasW = size.w * OUT;
  const canvasH = size.h * OUT;
  const availW = canvasW - pad * 2;
  const availH = canvasH - pad * 2 - chromeH;
  const scale = Math.min(availW / contentW, availH / contentH);
  const dw = Math.round(contentW * scale);
  const dh = Math.round(contentH * scale);
  const card = { x: Math.round((canvasW - dw) / 2), y: Math.round((canvasH - dh - chromeH) / 2), w: dw, h: dh + chromeH };
  return {
    canvasW, canvasH, card, chromeH,
    content: { sx: 0, sy: 0, sw: contentW, sh: contentH, dx: card.x, dy: card.y + chromeH, dw, dh },
  };
}
