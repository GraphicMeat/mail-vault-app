// Backgrounds for a social image. `angle` is in canvas terms: 0 runs left to
// right, 90 top to bottom, so 45 is the classic top-left to bottom-right
// sweep. A CSS swatch of the same gradient is `linear-gradient(angle + 90deg)`
// (cssGradient below).
export const GRADIENT_PRESETS = [
  { id: 'sunset', stops: ['#ff512f', '#f97a5b', '#ffc56e'], angle: 45 },
  { id: 'ocean', stops: ['#0b3b8c', '#2563eb', '#5ec8f2'], angle: 60 },
  { id: 'aurora', stops: ['#0fd3a7', '#3b82f6', '#a855f7'], angle: 30 },
  { id: 'candy', stops: ['#ff6ec4', '#c471f5', '#7873f5'], angle: 45 },
  { id: 'lime', stops: ['#e8ff74', '#8ee05b', '#14b68c'], angle: 50 },
  { id: 'peach', stops: ['#ffe5cc', '#ffb199', '#ff7e8a'], angle: 45 },
  { id: 'violet', stops: ['#3b0f91', '#7c3aed', '#e879f9'], angle: 40 },
  { id: 'ember', stops: ['#5f0a0a', '#e2361d', '#ffb321'], angle: 70 },
  { id: 'mint', stops: ['#e3fcef', '#84ecc4', '#22b8a8'], angle: 45 },
  { id: 'midnight', stops: ['#070b1f', '#1e2a78', '#6b3fd4'], angle: 60 },
];

export const SOLID_PRESETS = [
  { id: 'white', color: '#ffffff' },
  { id: 'black', color: '#000000' },
  { id: 'graphite', color: '#1f2328' },
  { id: 'cream', color: '#f6f1e7' },
  { id: 'sky', color: '#dbeafe' },
  { id: 'blush', color: '#fde2e4' },
];

export const DEFAULT_CUSTOM_STOPS = ['#6366f1', '#ec4899'];
const CUSTOM_ANGLE = 45;

export const cssGradient = (stops, angle) => `linear-gradient(${angle + 90}deg, ${stops.join(', ')})`;

/**
 * { type: 'gradient', id } | { type: 'solid', id?, color? } | { type: 'custom', stops }
 * | { type: 'transparent' } | { type: 'image', image } → what the painter draws.
 * An unknown preset id falls back to the first preset, never to nothing.
 */
export function resolveBackground(bg) {
  switch (bg?.type) {
    case 'solid': {
      const color = bg.color || SOLID_PRESETS.find(s => s.id === bg.id)?.color || SOLID_PRESETS[0].color;
      return { kind: 'solid', color };
    }
    case 'custom': {
      const stops = Array.isArray(bg.stops) && bg.stops.length >= 2 ? bg.stops : DEFAULT_CUSTOM_STOPS;
      return { kind: 'linear', stops, angle: CUSTOM_ANGLE };
    }
    case 'transparent':
      return { kind: 'none' };
    case 'image':
      return bg.image ? { kind: 'image', image: bg.image } : { kind: 'none' };
    default: {
      const preset = GRADIENT_PRESETS.find(g => g.id === bg?.id) || GRADIENT_PRESETS[0];
      return { kind: 'linear', stops: preset.stops, angle: preset.angle };
    }
  }
}

// '#rgb' / '#rrggbb' → [r, g, b] 0-255; anything else null.
function parseHex(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

// WCAG relative luminance, 0 (black) to 1 (white).
function luminance([r, g, b]) {
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * How light a background is, 0 to 1: a solid's own color, a gradient's average
 * of its stops. null for an image or no background at all (nothing to measure).
 */
export function backgroundLuminance(bg) {
  const r = resolveBackground(bg);
  const colors = r.kind === 'solid' ? [r.color] : r.kind === 'linear' ? r.stops : [];
  const rgb = colors.map(parseHex).filter(Boolean);
  if (!rgb.length) return null;
  const avg = [0, 1, 2].map(i => rgb.reduce((sum, c) => sum + c[i], 0) / rgb.length);
  return luminance(avg);
}

const LIGHT_BG_LUMINANCE = 0.6;

/**
 * Text color for lettering printed straight on the background (the watermark):
 * dark on a light background, white on a dark one, and white with a soft dark
 * shadow where the backdrop is unknown (an image, transparent).
 */
export function inkForBackground(bg) {
  const lum = backgroundLuminance(bg);
  if (lum === null) return { color: '#ffffff', shadow: true };
  return lum > LIGHT_BG_LUMINANCE ? { color: '#1d1d1f', shadow: false } : { color: '#ffffff', shadow: false };
}
