// Shared shapes of the Blitz module (overview: "Surface props contract" and
// "Contract amendments after plan review"). JSDoc only; nothing is exported.

/**
 * What every surface passes to the alternative body renderer.
 *
 * @typedef {Object} AltBodyProps
 * @property {'reader'|'thread'|'bubble'|'fullView'|'original'|'preview'|'exportPreview'|'popout'} surface
 * @property {string} messageKey Stable per message (scopeKey / rowKey); drives once-per-message UX.
 * @property {string} bodyHtml The SAME pre-processed body the surface's iframe uses, before
 *   buildEmailIframeHtml (cid to data:, linkify, tracker strip, link-safety scan already applied).
 * @property {string} [documentHtml] The complete document HTML a surface builds itself (ChatBubbleView,
 *   OriginalFrame, export canvas). When present, the pre-pass uses it instead of building from
 *   bodyHtml, after stripping scripts, so the CSS stays byte-identical by construction.
 * @property {string} [indicatorCss] Link-safety indicator style, if any.
 * @property {string} [plainText] email.text, for the failure fallback.
 * @property {{dark: boolean, palette: string, tableMode?: 'preserve'|'clip'}} theme Same inputs the
 *   iframe's theme logic uses.
 * @property {string} [signatureDisplay] As passed to getSignatureFoldingScript today.
 * @property {boolean} [foldQuotes] Whether the surface folds quotes today.
 * @property {boolean} [privacy] usePrivacyFrameGate() result.
 * @property {string} [searchQuery] The open search query (searchActive ? searchQuery : '').
 * @property {string} [accountId]
 * @property {object} [message] The email object, so privacy masks its own parties too.
 * @property {(link: LinkInfo) => void} [onLink] The surface's link activation; Blitz calls it on click.
 * @property {'fill'|'content'|{collapsedMax: number}} sizing 'content' is exactly meta.cssHeight tall
 *   (style.minHeight honoured); 'fill' is 100% of the parent, scrolling inside; {collapsedMax: n} is
 *   min(meta.cssHeight, n) tall, scrolling inside.
 * @property {string} [className]
 * @property {object} [style]
 */

/**
 * What an alternative Body exposes through its ref. A Body that receives a ref must be a
 * forwardRef exposing { selectionRoot(), selectionText() }: Reply quotes the selection through them.
 *
 * @typedef {Object} AltBodyHandle
 * @property {() => HTMLElement | null} selectionRoot The element whose selection Reply may quote.
 * @property {() => string} selectionText The selection's copy text, or '' when there is none.
 */

/**
 * A link found in a rendered document.
 *
 * @typedef {Object} LinkInfo
 * @property {string} href
 * @property {string} text
 * @property {string|null} alert Link-safety alert level, if any.
 * @property {string|null} title
 */

export {};
