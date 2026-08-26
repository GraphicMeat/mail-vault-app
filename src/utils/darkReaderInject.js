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
// - brightness/contrast stay neutral at 100/100. Sepia 0 — neutral, not warm.
//   Contrast below 100 pulls every color toward mid-grey, including the
//   background: at 90 the MAIL_DARK_BG below came out ~#16161a, so every HTML
//   mail rendered as a visibly lighter box against the app chrome while
//   plain-text mails (styled directly with it) did not.
// - darkSchemeBackgroundColor is MAIL_DARK_BG, which mirrors --mail-bg, so the
//   iframe blends into the surrounding chrome. See utils/mailChrome.js — this
//   value must never be written as a literal here again.

// eslint-disable-next-line import/no-unresolved
import darkReaderSource from 'darkreader/darkreader.js?raw';
import { MAIL_DARK_BG, MAIL_DARK_TEXT } from './mailChrome';

const DEFAULT_OPTIONS = {
  brightness: 100,
  contrast: 100,
  sepia: 0,
  darkSchemeBackgroundColor: MAIL_DARK_BG,
  darkSchemeTextColor: MAIL_DARK_TEXT,
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
