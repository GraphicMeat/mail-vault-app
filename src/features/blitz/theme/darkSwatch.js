// Dark Reader's colours for things the iframe themes with Dark Reader but Blitz
// draws in the app: the context menu (light inline colours that Dark Reader
// re-themes in the frame) and Dark Reader's ::selection rule. Asked of the
// reader's own Dark Reader, not a second port: a swatch document is built the
// way EmailViewer builds the reader frame (same template, same scripts and
// options for the palette, same sandbox), the re-themed colours are read back,
// and the frame is dropped. The result is cached per palette for the session.
import { buildEmailIframeHtml, emailScriptNonce, getContextMenuColors } from '../../../utils/emailIframeTemplate';
import { overlayFor } from '../text/selectionColors';

const light = getContextMenuColors();

// The menu as the iframe builds it, plus Dark Reader's selection seed. The shadow
// swatch is a background: Dark Reader's modifyShadowColor is modifyBackgroundColor.
export const SWATCH_HTML = `<div data-mv-id="menu" style="background-color:${light.menuBg};color:${light.itemColor};border:1px solid ${light.menuBorder}">m</div>`
  + `<div data-mv-id="hover" style="background-color:${light.itemHoverBg}">h</div>`
  + '<div data-mv-id="sel" style="background-color:rgb(0,96,212);color:#ffffff">s</div>'
  + '<div data-mv-id="shadow" style="background-color:rgba(0,0,0,.15)">x</div>';

const IDS = ['menu', 'hover', 'sel', 'shadow'];
const SANDBOX = 'allow-same-origin allow-popups allow-scripts'; // as EmailViewer's frame
const READY_TIMEOUT_MS = 2000;
const POLL_MS = 40;
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
  return {
    menu: {
      menuBg: css(c.bg),
      menuBorder: css(c.border),
      itemColor: css(c.fg),
      itemHoverBg: css(c.hover),
      menuShadow: `0 4px 12px ${css(c.shadow)}`,
    },
    selection: overlayFor(rgb(c.sel), paper),
    paper,
  };
}

// Dark Reader marks every inline-styled element it has re-themed with a
// data-darkreader-inline-* attribute. Before that the swatches still hold their
// light values, which must never be read (they would be cached as the dark ones).
function readSwatch(frame) {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) return null;
  const out = {};
  for (const id of IDS) {
    const el = doc.querySelector(`[data-mv-id="${id}"]`);
    if (!el || ![...el.attributes].some(a => a.name.startsWith('data-darkreader-inline-'))) return null;
    const cs = win.getComputedStyle(el);
    out[id] = { backgroundColor: cs.backgroundColor, color: cs.color, borderTopColor: cs.borderTopColor };
  }
  return out;
}

/** Re-themed swatch colours for `palette`, read from a hidden copy of the reader frame; null on timeout. */
export async function domProbe(palette) {
  // Loaded when a dark body first needs it: the Dark Reader bundle is a 330 KB string, and a light session never builds it.
  let getDarkReaderInlineScripts;
  try { ({ getDarkReaderInlineScripts } = await import('../../../utils/darkReaderInject')); } catch { return null; }
  return new Promise((resolve) => {
    let frame;
    let timer;
    const done = (value) => { clearTimeout(timer); frame?.remove(); resolve(value); };
    try {
      const nonce = emailScriptNonce();
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', SANDBOX);
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      // Offscreen, not display:none: computed styles of a hidden frame are not reliable. No mail is in it.
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:200px;height:120px;border:0;visibility:hidden;pointer-events:none';
      frame.srcdoc = buildEmailIframeHtml({
        bodyHtml: SWATCH_HTML,
        themeTag: 'dark',
        extraHead: getDarkReaderInlineScripts({ palette, nonce }),
        nonce,
      });
      document.body.appendChild(frame);
    } catch { done(null); return; }
    const started = Date.now();
    const tick = () => {
      let raw = null;
      try { raw = readSwatch(frame); } catch { /* the frame is not ready: poll on */ }
      if (raw) { done(raw); return; }
      if (Date.now() - started > READY_TIMEOUT_MS) { done(null); return; }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
  });
}

const cache = new Map(); // palette -> Promise
export function _resetDarkSwatchForTest() { cache.clear(); }

/**
 * Dark Reader's menu colours and selection overlay for the theme's palette, or null
 * (the light colours stand). Cached per palette; a failed probe is not cached.
 * `probe` is for tests.
 */
export function darkUiColors(theme, probe = domProbe) {
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
