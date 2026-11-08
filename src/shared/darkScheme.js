// The mail's own `prefers-color-scheme: dark` query is renamed to a feature no browser knows, so
// it can never match. Desktop (utils/emailIframeTemplate.js) and mobile (mobile/mailFrame.js)
// both apply these two to a `<style>` element's CSS and its `media` attribute.

export const DARK_SCHEME_FEATURE = /prefers-color-scheme(\s*:\s*)dark/gi;
export const SUPPRESSED = 'mv-suppressed-color-scheme$1dark';

export const suppressDarkScheme = (css) => css.replace(DARK_SCHEME_FEATURE, SUPPRESSED);
