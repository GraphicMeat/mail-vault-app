// Shared iframe template for rendering HTML email bodies.
//
// Baseline is always LIGHT (white bg, dark text). This gives Dark Reader a
// clean set of colors to invert from when the app is in dark mode. We also
// force `color-scheme: light` so the OS-level prefers-color-scheme doesn't
// partially activate some emails' own dark variants — Dark Reader is the
// single source of truth for dark mode.
//
// Kept separate from ChatBubbleView's iframe (transparent bg, per-bubble tint).

export function getEmailBodyContent(html) {
  if (!html) return '';
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

// Build a complete HTML document for an email iframe.
//
// opts:
//   bodyHtml   — inner body HTML (already CID-resolved, script-free, etc.)
//   themeTag   — 'dark' | 'light'. Stamped into the document so srcDoc differs
//                per theme (forces iframe reload on theme switch so DR can
//                re-inject cleanly). Does NOT change the baseline colors.
//   extraHead  — optional raw HTML appended inside <head> (e.g. Dark Reader
//                script for standalone popup windows)
//   extraBody  — optional raw HTML appended inside <body> (e.g. fold scripts)
//   tableMode  — 'preserve' (let emails own their table layout, default)
//              | 'clip'    (legacy: table-layout:fixed to clip overflow)
export function buildEmailIframeHtml({ bodyHtml, themeTag = 'light', extraHead = '', extraBody = '', tableMode = 'preserve' } = {}) {
  const tableCss = tableMode === 'clip'
    ? 'table { table-layout: fixed; width: 100% !important; overflow: hidden; } td, th { overflow: hidden; text-overflow: ellipsis; }'
    : 'table { max-width: 100% !important; width: auto !important; }';

  // <meta charset> is first in <head> so WKWebView decodes correctly even
  // when the document is loaded from a file:// URL (which would otherwise
  // fall back to Latin-1 and mojibake UTF-8 bytes).
  return `<!DOCTYPE html>
<html data-mv-theme="${themeTag}">
  <head>
    <meta charset="UTF-8">
    <base target="_blank">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light">
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 16px;
        background: #ffffff;
        color: #333333;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        word-wrap: break-word;
        overflow-wrap: break-word;
        overflow-x: hidden;
        max-width: 100%;
      }
      img { max-width: 100%; height: auto; }
      * { overflow-wrap: break-word; word-wrap: break-word; }
      ${tableCss}
      pre, code { white-space: pre-wrap; overflow-x: auto; max-width: 100%; overflow-wrap: break-word; }
      blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #ddd; overflow: hidden; }
    </style>
    ${extraHead}
  </head>
  <body>${bodyHtml}${extraBody}</body>
</html>`;
}

// Right-click context menu colors. DR's MutationObserver will catch the
// dynamically-appended menu and invert it in dark mode, so we always emit
// light colors here — DR is the single source of truth for theming inside
// the iframe.
export function getContextMenuColors() {
  return {
    menuBg: '#ffffff',
    menuBorder: '#d1d5db',
    menuShadow: '0 4px 12px rgba(0,0,0,.15)',
    itemColor: '#333333',
    itemHoverBg: '#f3f4f6',
  };
}
