// Shared by the palette specs: WCAG contrast, CIEDE2000 distance and a token
// reader over src/styles/index.css. Not a spec itself.
const channels = hex => hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16));
const linear = value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };

export function luminance(hex) {
  const [r, g, b] = channels(hex).map(linear);
  return .2126 * r + .7152 * g + .0722 * b;
}

export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + .05) / (dark + .05);
}

export function hue(hex) {
  const [r, g, b] = channels(hex).map(value => value / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (!delta) return 0;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return Math.round(((sector * 60) + 360) % 360);
}

function lab(hex) {
  const [r, g, b] = channels(hex).map(linear);
  const f = t => (t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f((r * .4124564 + g * .3575761 + b * .1804375) / .95047);
  const fy = f(r * .2126729 + g * .7151522 + b * .072175);
  const fz = f((r * .0193339 + g * .119192 + b * .9503041) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = degrees => degrees * Math.PI / 180;
const deg = radians => radians * 180 / Math.PI;

// CIEDE2000, the distance the custody-separation floors are measured in.
export function deltaE(hexA, hexB) {
  const [L1, a1, b1] = lab(hexA);
  const [L2, a2, b2] = lab(hexB);
  const meanC = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = .5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1 = Math.hypot(a1p, b1);
  const C2 = Math.hypot(a2p, b2);
  const h1 = (deg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2 = (deg(Math.atan2(b2, a2p)) + 360) % 360;
  const dL = L2 - L1;
  const dC = C2 - C1;
  let dh = 0;
  if (C1 * C2) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin(rad(dh / 2));
  const meanL = (L1 + L2) / 2;
  const meanCp = (C1 + C2) / 2;
  let meanH = h1 + h2;
  if (C1 * C2) meanH = Math.abs(h1 - h2) <= 180 ? meanH / 2 : (meanH < 360 ? (meanH + 360) / 2 : (meanH - 360) / 2);
  const T = 1 - .17 * Math.cos(rad(meanH - 30)) + .24 * Math.cos(rad(2 * meanH)) + .32 * Math.cos(rad(3 * meanH + 6)) - .2 * Math.cos(rad(4 * meanH - 63));
  const theta = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7));
  const Sl = 1 + .015 * (meanL - 50) ** 2 / Math.sqrt(20 + (meanL - 50) ** 2);
  const Sc = 1 + .045 * meanCp;
  const Sh = 1 + .015 * meanCp * T;
  const Rt = -Math.sin(rad(2 * theta)) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

// Hex custom properties of the rule that opens with `selector`, e.g. `mail-bg`.
export function tokens(css, selector, prefix = 'mail') {
  const start = css.indexOf(selector);
  if (start < 0) return {};
  const body = css.slice(start + selector.length).split('}')[0];
  return Object.fromEntries([...body.matchAll(new RegExp(`--${prefix}-([\\w-]+):\\s*(#[\\da-f]{6})`, 'gi'))].map(match => [match[1], match[2].toLowerCase()]));
}
