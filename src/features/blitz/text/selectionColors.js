// The iframe's selection is the engine default: the system highlight made
// translucent so it reads the same over white (WebKit and Chromium
// Color::blendWithWhite). The layer must paint the same, and must stay
// translucent anyway: it sits OVER the tile, so an opaque highlight would
// hide the glyphs underneath.
const START = 153; const END = 204; const STEP = 17;

function blendComponent(c, a) {
  return Math.trunc((c - (255 - a)) / (a / 255));
}
const clamp = (v) => Math.max(0, Math.min(255, v));

export function blendWithWhite({ r, g, b }) {
  let out = null;
  for (let a = START; a <= END; a += STEP) {
    const rr = blendComponent(r, a); const gg = blendComponent(g, a); const bb = blendComponent(b, a);
    out = { r: clamp(rr), g: clamp(gg), b: clamp(bb), a: Math.round((a / 255) * 1000) / 1000 };
    if (rr >= 0 && gg >= 0 && bb >= 0) break;
  }
  return out;
}

/** A translucent colour that, over `paper`, shows exactly `target`. */
export function overlayFor(target, paper) {
  for (let a = START; a <= 255; a += STEP) {
    const f = a / 255;
    const ch = (t, p) => (t - (1 - f) * p) / f;
    const c = [ch(target.r, paper.r), ch(target.g, paper.g), ch(target.b, paper.b)];
    if (c.every(v => v >= -0.5 && v <= 255.5)) {
      return { r: clamp(Math.round(c[0])), g: clamp(Math.round(c[1])), b: clamp(Math.round(c[2])), a: Math.round(f * 1000) / 1000 };
    }
  }
  return { ...target, a: 1 };
}

// The classic macOS highlight, for an engine that cannot resolve `Highlight`.
const FALLBACK_HIGHLIGHT = { r: 179, g: 215, b: 255 };

function parseRgb(s) {
  const m = String(s).match(/\d+(\.\d+)?/g) || [];
  return m.length >= 3 ? { r: +m[0], g: +m[1], b: +m[2] } : null;
}

/** The system highlight, read from a probe, as the engine would blend it. */
export function lightSelectionColor() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:Highlight';
  document.body.appendChild(probe);
  const c = parseRgb(getComputedStyle(probe).color);
  probe.remove();
  return blendWithWhite(c || FALLBACK_HIGHLIGHT);
}

export function applySelectionColors(layerEl, { r, g, b, a }) {
  layerEl?.style.setProperty('--mv-blitz-sel-bg', `rgba(${r}, ${g}, ${b}, ${a})`);
}
