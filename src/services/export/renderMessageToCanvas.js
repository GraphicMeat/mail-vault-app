import { domToCanvas } from 'modern-screenshot';
import { buildMessageDocument, EXPORT_WIDTH_PX, EXPORT_SCALE } from './exportDocument';

// The export frame never gets allow-scripts. Quotes and signatures are
// expanded by building the document that way, so there is nothing left for a
// script to do — and an email's own script must not run just because we are
// rendering it.
const SANDBOX = 'allow-same-origin';

// A srcdoc frame that never fires `load` would hang an export with no way
// out, so the wait is bounded. 10 s is far past any inline document — the body
// is already data: URIs by the time it gets here, so nothing is on the network
// — and it is the only reason this function can be driven under jsdom, which
// sets the srcdoc attribute but never navigates the frame at all.
export const FRAME_LOAD_TIMEOUT_MS = 10_000;

export async function mountExportFrame(html, { loadTimeoutMs = FRAME_LOAD_TIMEOUT_MS } = {}) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', SANDBOX);
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    `position:fixed;left:-10000px;top:0;width:${EXPORT_WIDTH_PX}px;height:1000px;border:0;visibility:hidden`;
  document.body.appendChild(iframe);

  const dispose = () => iframe.remove();

  try {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, loadTimeoutMs);
      iframe.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
      iframe.srcdoc = html;
    });

    const doc = iframe.contentDocument;

    // Everything that changes layout has to settle before the height is read,
    // or the frame is measured mid-load and the bottom of the mail is cut off.
    if (doc.fonts?.ready) await doc.fonts.ready;
    await Promise.all([...doc.images].map(img => (img.decode ? img.decode().catch(() => {}) : null)));

    // Collapse before measuring. scrollHeight on a frame TALLER than its
    // content returns the frame's own height — the Task 0 probe rasterized
    // 1000 px of padding that way and produced two byte-identical PNGs for two
    // different inputs.
    iframe.style.height = '1px';
    const height = Math.max(
      doc.documentElement.scrollHeight,
      doc.body.scrollHeight,
      1,
    );
    iframe.style.height = `${height}px`;

    return { iframe, doc, height, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

export async function measureMessageHeight({ message, bodyHtml, loadTimeoutMs }) {
  const frame = await mountExportFrame(buildMessageDocument({ message, bodyHtml }), { loadTimeoutMs });
  const { height } = frame;
  frame.dispose();
  return height;
}

export async function renderMessageToCanvas({ message, bodyHtml, account, mailbox, stats, loadTimeoutMs }) {
  const html = buildMessageDocument({ message, bodyHtml, account, mailbox, stats });
  const frame = await mountExportFrame(html, { loadTimeoutMs });
  try {
    // font:false and a short timeout are load-bearing, not tuning: the Task 0
    // probe measured 30,277 ms with the defaults versus 3,887 ms with these,
    // for byte-identical output. The export document uses system fonts only,
    // so there is nothing for font embedding to contribute.
    const options = {
      scale: EXPORT_SCALE, backgroundColor: '#ffffff',
      width: EXPORT_WIDTH_PX, height: frame.height,
      font: false, timeout: 3000,
    };
    try {
      return await domToCanvas(frame.doc.body, options);
    } catch (first) {
      // Known WebKit flake: the first foreignObject rasterize of a document can
      // come back empty or throw. One retry, then it is a real failure.
      return await domToCanvas(frame.doc.body, options);
    }
  } finally {
    frame.dispose();
  }
}
