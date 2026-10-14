// Dark Reader's colours for things the iframe themes with Dark Reader but Blitz
// draws in the app: the context menu (light inline colours that Dark Reader
// re-themes in the frame) and Dark Reader's ::selection rule.
//
// INTERIM: the dark colours come with plan B's render.inspect. Blitz mode never
// shows an iframe, so there is no probe frame; the default probe returns null (no
// dark colours, the light ones stand). Plan B supplies a probe that opens SWATCH_HTML
// in dark mode and returns the inspected colours, in the shape mapSwatch takes.
//
// The dark selection must stay translucent: the text layer is transparent over the
// tile, so an opaque highlight would hide the glyphs. overlayFor can only return an
// opaque colour for Dark Reader's real values (rgb(0,77,170) over a near-black paper),
// so mapSwatch rejects an opaque overlay and the light selection stands until plan B
// settles how to paint it (for example under the glyphs).
import { getContextMenuColors } from '../../../utils/emailIframeTemplate';
import { overlayFor } from '../text/selectionColors';

const light = getContextMenuColors();

// The menu as the iframe builds it, plus Dark Reader's selection seed. The shadow
// swatch is a background: Dark Reader's modifyShadowColor is modifyBackgroundColor.
export const SWATCH_HTML = `<div data-mv-id="menu" style="background-color:${light.menuBg};color:${light.itemColor};border:1px solid ${light.menuBorder}">m</div>`
  + `<div data-mv-id="hover" style="background-color:${light.itemHoverBg}">h</div>`
  + '<div data-mv-id="sel" style="background-color:rgb(0,96,212);color:#ffffff">s</div>'
  + '<div data-mv-id="shadow" style="background-color:rgba(0,0,0,.15)">x</div>';

const LIGHT_PAPER = 'rgb(255, 255, 255)';

// getComputedStyle reports resolved colours: rgb(r, g, b) or rgba(r, g, b, a).
function parseCssColor(s) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+)(%?))?\s*\)$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  const a = m[4] == null ? 1 : (m[5] ? Number(m[4]) / 100 : Number(m[4]));
  return [r, g, b, a].every(Number.isFinite) ? [r, g, b, a] : null;
}
const css = ([r, g, b, a]) => (a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`);
const rgb = ([r, g, b]) => ({ r, g, b });

/** Probed computed colours -> { menu, selection, paper }, or null when they cannot be trusted. */
export function mapSwatch(raw) {
  if (!raw) return null;
  const c = {
    bg: parseCssColor(raw.menu?.backgroundColor),
    fg: parseCssColor(raw.menu?.color),
    border: parseCssColor(raw.menu?.borderTopColor),
    hover: parseCssColor(raw.hover?.backgroundColor),
    sel: parseCssColor(raw.sel?.backgroundColor),
    shadow: parseCssColor(raw.shadow?.backgroundColor),
  };
  if (Object.values(c).some(v => !v)) return null;
  // Still the light menu: Dark Reader has not re-themed the swatch.
  if (css(c.bg) === LIGHT_PAPER) return null;
  // The overlay is composed over an opaque paper: a translucent swatch has no single colour to match.
  if (c.sel[3] < 1 || c.bg[3] < 1) return null;
  const paper = rgb(c.bg); // Dark Reader's transformed #ffffff: the email's paper
  const selection = overlayFor(rgb(c.sel), paper);
  if (selection.a >= 1) return null; // opaque would hide the glyphs under the transparent text layer
  return {
    menu: {
      menuBg: css(c.bg),
      menuBorder: css(c.border),
      itemColor: css(c.fg),
      itemHoverBg: css(c.hover),
      menuShadow: `0 4px 12px ${css(c.shadow)}`,
    },
    selection,
    paper,
  };
}

const cache = new Map(); // palette -> Promise
export function _resetDarkSwatchForTest() { cache.clear(); }

const noProbe = async () => null; // plan B's render.inspect probe replaces this

/**
 * Dark Reader's menu colours and selection overlay for the theme's palette, or null
 * (the light colours stand). Cached per palette; a failed probe is not cached.
 * `probe` is the seam for plan B (and tests): palette -> raw swatch colours, see mapSwatch.
 */
export function darkUiColors(theme, probe = noProbe) {
  const key = theme?.palette || 'default';
  if (!cache.has(key)) {
    const p = (async () => {
      try {
        // Deferred: a probe that throws at once must still land after cache.set below.
        const colors = mapSwatch(await Promise.resolve().then(() => probe(theme?.palette)));
        if (!colors) cache.delete(key);
        return colors;
      } catch {
        cache.delete(key);
        return null;
      }
    })();
    cache.set(key, p);
  }
  return cache.get(key);
}
