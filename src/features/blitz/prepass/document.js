// The HTML Blitz renders: the iframe's document minus our scripts. The core
// builder buildEmailIframeHtml is shared, so every byte of CSS matches the
// iframe. That covers the base sheet, the table mode, the link-safety
// indicator sheet, the mail's <style>s after neutralizeEmailDarkScheme, and
// (dark only) the inline colour `!important`s that stripInlineColorImportant
// drops.
// Dark Reader is not a script on this path. render.open carries
// theme.mode 'dark' and the worker's Rust port applies it (plan B).
// `privacy` is forwarded as given; plan A owns what it passes.
import { buildEmailIframeHtml } from '../../../utils/emailIframeTemplate';

// Blitz runs no script, so the CSP nonce guards nothing here. A constant keeps
// the output byte-identical for equal inputs: a fresh random nonce per run
// would make every privacy-dictionary update look like a changed document and
// reopen it.
export const BLITZ_NONCE = 'blitz';

export function buildBlitzDocument({ bodyHtml, indicatorCss = '', dark = false, tableMode = 'preserve', privacy = false }) {
  return buildEmailIframeHtml({
    bodyHtml,
    themeTag: dark ? 'dark' : 'light',
    extraHead: indicatorCss ? `<style>${indicatorCss}</style>` : '',
    extraBody: '',
    nonce: BLITZ_NONCE,
    tableMode,
    privacy,
  });
}
