// The app's dark chrome, as JavaScript literals.
//
// These mirror the DARK values of `--mail-bg` and `--mail-text` in
// styles/index.css. They cannot be `var(--mail-bg)` reads, for two reasons:
//
//  * The email frame's theme is independent of the app's. A person can read a
//    dark message inside a light app, and the frame must still paint dark
//    chrome behind it — a live `var()` would hand back the light value.
//  * Dark Reader's `darkSchemeBackgroundColor` is injected INTO the sandboxed
//    iframe, a separate document where our custom properties do not exist.
//
// The light side is deliberately NOT here: it is `#ffffff`, plain paper, not
// the light theme's `--mail-bg`.
//
// Keep these in step with styles/index.css by hand. `connected-html-render`
// ("renders on the app background, not a lighter box") is the guard — it reads
// `--mail-bg` at runtime and asserts the rendered mail body matches it, so a
// token that moves without these moving fails there. That is exactly how the
// custody colour pass (ca23444) was caught: `--mail-bg` went #0a0a0f → #0a0a12
// and nine copies of the old value stayed behind.
export const MAIL_DARK_BG = '#0a0a12';
export const MAIL_DARK_TEXT = '#e8e8ef';
