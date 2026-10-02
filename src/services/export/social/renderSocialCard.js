import { renderMessageToCanvas } from '../renderMessageToCanvas';
import { EXPORT_HEAD_DARK } from '../exportDocument';
import { getDarkReaderInlineScripts } from '../../../utils/darkReaderInject';
import { getEmailColors } from '../../../utils/mailChrome';
import { emailScriptNonce } from '../../../utils/emailIframeTemplate';

// Same split as the app: the Appearance theme paints the chrome (here the
// subject and From/To/Date block), the Mail theme paints the message itself.
// They are rasterized apart so any pair works: dark appearance over a light
// mail is a dark header over white, exactly as the reader shows it.

// Dark Reader is applied by the document's own scripts and has no "done"
// event. Bounded: a mail it never finishes on is shot as it stands.
export const DARK_READER_WAIT_MS = 1500;
const FRAME_STEP_MS = 50; // a hidden window never fires rAF: do not wait on it alone

const nextFrame = () => new Promise((resolve) => {
  const timer = setTimeout(resolve, FRAME_STEP_MS);
  requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
});

const darkReaderApplied = (doc) =>
  doc.documentElement.hasAttribute('data-darkreader-scheme') || !!doc.querySelector('style.darkreader');

export async function waitForDarkReader(doc, timeoutMs = DARK_READER_WAIT_MS) {
  const start = Date.now();
  while (!darkReaderApplied(doc) && Date.now() - start < timeoutMs) await nextFrame();
  if (darkReaderApplied(doc)) { await nextFrame(); await nextFrame(); }
}

// Header over body on one canvas. Both are rasterized at the same width.
function stack(head, body, headBg) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(head.width, body.width);
  canvas.height = head.height + body.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = headBg;
  ctx.fillRect(0, 0, canvas.width, head.height);
  ctx.drawImage(head, 0, 0);
  ctx.drawImage(body, 0, head.height);
  return canvas;
}

/**
 * One email as a card canvas: the header block in `appearance` ('light' |
 * 'dark', plain CSS) stacked over the body in `mail` ('light' | 'dark', Dark
 * Reader). `redactStyle` and `onCloneNode` go to both halves: the header holds
 * the names and addresses. A dark body mounts its frame with scripts, under a
 * CSP that admits only the nonced Dark Reader tags, so the mail's own scripts
 * (already stripped by the sanitizer) could not run anyway.
 */
export async function renderSocialCard({ message, bodyHtml, appearance = 'light', mail = 'light', palette, redactStyle, onCloneNode }) {
  const head = await renderMessageToCanvas({
    message, part: 'head', theme: appearance, redactStyle, onCloneNode,
    backgroundColor: appearance === 'dark' ? EXPORT_HEAD_DARK.bg : '#ffffff',
  });
  let body;
  if (mail === 'dark') {
    const nonce = emailScriptNonce();
    body = await renderMessageToCanvas({
      message, bodyHtml, part: 'body', theme: 'dark', redactStyle, onCloneNode,
      sandbox: 'allow-same-origin allow-scripts',
      extraHead: `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'">${getDarkReaderInlineScripts({ palette, nonce })}`,
      backgroundColor: getEmailColors('dark', palette).background,
      beforeCapture: waitForDarkReader,
    });
  } else {
    body = await renderMessageToCanvas({ message, bodyHtml, part: 'body', redactStyle, onCloneNode });
  }
  return stack(head, body, appearance === 'dark' ? EXPORT_HEAD_DARK.bg : '#ffffff');
}

// The connected e2e spec renders cards straight through this, no dialog.
if (import.meta.env.VITE_E2E === '1' && typeof window !== 'undefined') window.__MV_SOCIAL_CARD__ = renderSocialCard;
