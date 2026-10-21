import { buildEmailIframeHtml, emailScriptNonce, getEmailBodyContent } from '../../../utils/emailIframeTemplate';
import { runPrepass } from '../prepass/index';
import { getDarkReaderInlineScripts } from '../../../utils/darkReaderInject';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../../../utils/iframeQuoteFolding';
import { buildChatBubbleDocument } from '../../../components/ChatBubbleView';
import { buildOriginalFrameHtml } from '../../../components/OriginalFrame';
import { buildEmailPreviewHtml } from '../../../components/email/EmailPreviewFrame';
import { buildMessageDocument, EXPORT_WIDTH_PX } from '../../../services/export/exportDocument';
import { stripGoogleFontImports } from '../../../utils/mailFonts';
import { surfaceWorkerTheme } from './sizing';

// Each surface's iframe document for one corpus body, built by the surface's
// own builder, beside what that surface hands Blitz. The parity harness renders
// both and compares per element (overview Parity). Natural widths per surface.
// The e2e hook only: no product code reads this module.
export function surfaceDocs(rawHtml, { dark, palette }) {
  // What every reader hands its frame: the corpus file is a whole document.
  const bodyHtml = getEmailBodyContent(rawHtml);
  const nonce = emailScriptNonce();
  const dr = dark ? getDarkReaderInlineScripts({ palette, nonce }) : '';
  const theme = { dark, palette };
  const folds = `${getQuoteFoldingScript(nonce)}${getSignatureFoldingScript('smart', nonce)}`;
  const message = { subject: 'Parity', from: 'P <p@x.test>', to: 'Q <q@x.test>', date: new Date('2026-10-11T10:00:00Z') };
  const out = [
    { surface: 'thread', width: 680, iframeHtml: buildEmailIframeHtml({ bodyHtml, themeTag: dark ? 'dark' : 'light', extraHead: dr, extraBody: folds, nonce }), blitz: { surface: 'thread', bodyHtml, theme, foldQuotes: true, signatureDisplay: 'smart' } },
    { surface: 'fullView', width: 1200, iframeHtml: buildEmailIframeHtml({ bodyHtml, themeTag: dark ? 'dark' : 'light', extraHead: dr, nonce }), blitz: { surface: 'fullView', bodyHtml, theme, foldQuotes: false } },
  ];
  // The document surfaces: Blitz draws the very document the iframe gets.
  const documentSurface = (surface, width, iframeHtml, blitzTheme = theme, extra = {}) => out.push({
    surface, width, iframeHtml, blitz: { surface, documentHtml: iframeHtml, theme: blitzTheme, foldQuotes: false, ...extra },
  });
  // What the original and pop-out frame with tracker blocking off: the body, its Google Font imports out.
  const framedBody = stripGoogleFontImports(bodyHtml);
  documentSurface('original', 640, buildOriginalFrameHtml({ html: framedBody, dark, palette, padding: '12px 16px', privacy: false, nonce }));
  documentSurface('popout', 800, buildOriginalFrameHtml({ html: framedBody, dark, palette, padding: null, privacy: false, nonce }));
  // Export: the body half of a dark card is dark (Dark Reader); the header's dark is CSS in its own document,
  // so Blitz draws it light (renderMessageToCanvas: dark only for part 'body').
  const darkBodyHead = dark ? `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'">${dr}` : '';
  documentSurface('exportBody', EXPORT_WIDTH_PX, buildMessageDocument({ message, bodyHtml, part: 'body', theme: dark ? 'dark' : 'light', extraHead: darkBodyHead }));
  documentSurface('exportHead', EXPORT_WIDTH_PX, buildMessageDocument({ message, bodyHtml, part: 'head', theme: dark ? 'dark' : 'light' }), { dark: false, palette });
  if (!dark) {
    // The whole light export document (the HTML export's card), header and body in one.
    documentSurface('exportCard', EXPORT_WIDTH_PX, buildMessageDocument({ message, bodyHtml }), { dark: false, palette });
    const preview = buildEmailPreviewHtml(framedBody, false);
    out.push({ surface: 'preview', width: 600, iframeHtml: preview, blitz: { surface: 'preview', bodyHtml, theme: { dark: false, palette }, foldQuotes: false } });
  }
  // The bubble never runs Dark Reader: "dark" here is the app theme its CSS reads.
  for (const fromUser of [false, true]) {
    const doc = buildChatBubbleDocument({ bodyHtml, fromUser, theme: dark ? 'dark' : 'light', palette, indicatorStyle: '', privacy: false, signatureDisplay: 'smart', nonce });
    out.push({
      surface: 'bubble', variant: fromUser ? 'sent' : 'received', width: 300, iframeHtml: doc,
      blitz: { surface: 'bubble', documentHtml: doc, theme: { dark: false, palette }, foldQuotes: true, signatureDisplay: 'smart' },
    });
  }
  return out;
}

// The html BlitzBody would send render.open for these props (the real pre-pass,
// so plan B stamps parity ids while window.__MV_PARITY__ is set).
export async function blitzHtml(props) {
  return (await runPrepass(props, { privacy: { active: false, dict: null }, openFolds: new Set() })).html;
}

// The worker theme BlitzTiles sends with it: the one shared rule (sizing.js).
export function workerTheme(props) {
  return surfaceWorkerTheme(props.theme, props.surface);
}

export function installSurfaceDocsHook(win = typeof window !== 'undefined' ? window : null) {
  if (import.meta.env.VITE_E2E !== '1' || !win) return;
  win.__MV_SURFACE_DOCS__ = { docs: surfaceDocs, blitzHtml, workerTheme };
}
