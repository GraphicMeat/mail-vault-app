// ── appFont — the app's UI font and text size (Settings > Appearance > Text) ──
//
// Every bundled family is SIL OFL 1.1, self-hosted in styles/fonts.css with
// its license under public/licenses/fonts/. `system` bundles nothing.
//
// `appFont` may also be `google:<Family>`, a catalogue family the daemon
// downloads once (utils/googleFonts.js, services/fontService.js). Until its
// faces are loaded in a window, that window draws the stack's fallback.

import { findGoogleFont, googleFamilyOf, uiFontStack } from './googleFonts';
import { loadFontFaces } from '../services/fontService';

export const APP_FONTS = [
  { id: 'system' },
  { id: 'instrument-sans', family: 'Instrument Sans' },
  { id: 'inter', family: 'Inter' },
  { id: 'atkinson', family: 'Atkinson Hyperlegible Next' },
  { id: 'ibm-plex-sans', family: 'IBM Plex Sans' },
  { id: 'source-sans', family: 'Source Sans 3' },
  { id: 'jetbrains-mono', family: 'JetBrains Mono', mono: true },
  { id: 'fira-code', family: 'Fira Code', mono: true },
  { id: 'ibm-plex-mono', family: 'IBM Plex Mono', mono: true },
];
export const DEFAULT_APP_FONT = 'instrument-sans';
export const TEXT_SCALES = [0.9, 1, 1.1, 1.25, 1.5];

const SYSTEM_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, Ubuntu, sans-serif";

export const normalizeAppFont = id => (APP_FONTS.some(font => font.id === id) || findGoogleFont(googleFamilyOf(id))
  ? id : DEFAULT_APP_FONT);
export const normalizeTextScale = value => TEXT_SCALES.includes(Number(value)) ? Number(value) : 1;

export function fontStack(id) {
  const google = googleFamilyOf(normalizeAppFont(id));
  if (google) return uiFontStack(google);
  const font = APP_FONTS.find(entry => entry.id === normalizeAppFont(id));
  if (!font.family) return SYSTEM_STACK;
  return `'${font.family}', ${font.mono ? 'ui-monospace, monospace' : 'system-ui, sans-serif'}`;
}

// body, .email-content and Tailwind's font-display read this.
// A Google font's faces are registered in this window (never rejects); the
// fallback draws meanwhile, and for good if the family is not downloaded.
export function applyAppFont(id) {
  document.documentElement.style.setProperty('--app-font', fontStack(id));
  const google = googleFamilyOf(normalizeAppFont(id));
  if (google) void loadFontFaces(google);
}

// Native webview zoom, not a root font-size: the CSS mixes rem with ~250 px
// sizes, so only zoom scales the whole UI evenly. Web preview/tests: no-op.
export async function applyTextScale(value) {
  if (!window.__TAURI__) return;
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().setZoom(normalizeTextScale(value));
  } catch (error) {
    console.warn('[appFont] zoom failed:', error);
  }
}

// Every window runs this once (main.jsx). The font applies at once (the
// default is right until hydration says otherwise); the zoom waits for the
// saved size, or every launch would visibly jump from 100% to it.
export function watchTextAppearance(store) {
  let font;
  let scale = 1; // a fresh webview is at 100%: nothing to send for the default
  const hydrated = () => store.persist?.hasHydrated?.() ?? true;
  const apply = ({ appFont, textScale }, zoom) => {
    if (appFont !== font) applyAppFont(font = appFont);
    if (zoom && textScale !== scale) void applyTextScale(scale = textScale);
  };
  apply(store.getState(), hydrated());
  store.persist?.onFinishHydration?.(state => apply(state, true));
  return store.subscribe(state => apply(state, hydrated()));
}
