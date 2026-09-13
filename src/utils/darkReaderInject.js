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
// Neutral brightness and contrast preserve the chosen palette's background.
// The same palette colors paint the containing frame and plain-text messages.

// eslint-disable-next-line import/no-unresolved
import darkReaderSource from 'darkreader/darkreader.js?raw';
import { getEmailColors } from './mailChrome';

const DEFAULT_OPTIONS = {
  brightness: 100,
  contrast: 100,
  sepia: 0,
};

// Return inline <script> tags to embed Dark Reader into an HTML document.
// Used for both srcdoc iframes and standalone popup windows — DR runs as
// the document loads, so there is no race with post-load injection.
//
// `nonce` is the frame's CSP nonce: the document pins `script-src 'nonce-…'`,
// so both tags need it to run. Dark Reader's OWN runtime helper script (the
// stylesheet-proxy it injects with createElement) gets no nonce and is blocked
// — DR is built for that (it falls back to a rAF stylesheet watcher and the
// `securitypolicyviolation` path), so theming still applies.
export function getDarkReaderInlineScripts({ palette = 'indigo', nonce = '', ...options } = {}) {
  const colors = getEmailColors('dark', palette);
  const opts = JSON.stringify({
    ...DEFAULT_OPTIONS,
    darkSchemeBackgroundColor: colors.background,
    darkSchemeTextColor: colors.text,
    ...options,
  });
  // Neutralize any stray </script> inside the source so the outer tag
  // doesn't terminate early.
  const safeSource = darkReaderSource.replace(/<\/script>/gi, '<\\/script>');
  const attr = nonce ? ` nonce="${nonce}"` : '';
  return `<script${attr}>${safeSource}</script><script${attr}>try{if(window.DarkReader&&typeof window.DarkReader.enable==='function'){window.DarkReader.enable(${opts});}}catch(e){console.error('[DarkReader enable]',e);}</script>`;
}
