// Dark Reader (v4.9.x UMD) helpers for email HTML rendering.
//
// Strategy:
// - The UMD bundle is loaded as a raw string at module load (Vite ?raw);
//   one fetch, cached for the lifetime of the app.
// - Callers embed it into the iframe/popup HTML directly via
//   `getDarkReaderInlineScripts()` — DR runs during page load, so there's
//   no race between the iframe `load` event and React effect setup, and no
//   flash of light content when toggling themes.
// - DR installs a MutationObserver inside the iframe, so any elements we
//   add later (context menus, etc.) also get inverted.
//
// Tuning notes for email content:
// - brightness/contrast at 100/90 keeps email text readable without
//   over-darkening. Sepia 0 — we want neutral, not warm.
// - darkSchemeBackgroundColor matches our app's --mail-bg (#0a0a0f) so the
//   iframe blends into the surrounding chrome.

// eslint-disable-next-line import/no-unresolved
import darkReaderSource from 'darkreader/darkreader.js?raw';

const DEFAULT_OPTIONS = {
  brightness: 100,
  contrast: 90,
  sepia: 0,
  darkSchemeBackgroundColor: '#0a0a0f',
  darkSchemeTextColor: '#e4e4e7',
};

// Return inline <script> tags to embed Dark Reader into an HTML document.
// Used for both srcdoc iframes and standalone popup windows — DR runs as
// the document loads, so there is no race with post-load injection.
export function getDarkReaderInlineScripts(options = {}) {
  const opts = JSON.stringify({ ...DEFAULT_OPTIONS, ...options });
  // Neutralize any stray </script> inside the source so the outer tag
  // doesn't terminate early.
  const safeSource = darkReaderSource.replace(/<\/script>/gi, '<\\/script>');
  return `<script>${safeSource}</script><script>try{if(window.DarkReader&&typeof window.DarkReader.enable==='function'){window.DarkReader.enable(${opts});}}catch(e){console.error('[DarkReader enable]',e);}</script>`;
}
