// @vitest-environment jsdom
//
// The mount contract is a DOM contract — iframe, sandbox, cleanup — and the
// default node environment has no document. vitest.config.js only maps
// src/components/** to jsdom, so this spec declares its own.
//
// jsdom sets the srcdoc attribute but never navigates the frame, so the load
// event never fires. Every mount here passes a 10 ms loadTimeoutMs so the
// bounded wait resolves at once instead of sitting out the real 10 s cap.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const domToCanvas = vi.fn();
vi.mock('modern-screenshot', () => ({ domToCanvas: (...args) => domToCanvas(...args) }));

const { renderMessageToCanvas, mountExportFrame, settleDocument } = await import('../renderMessageToCanvas');

const message = {
  from: 'Ana Brandt <ana@sizzlemedia.co>',
  to: 'Rowan Marsh <rowan@primecut.studio>',
  date: new Date('2026-08-28T09:14:00'),
  subject: 'Brisket Sans licence',
  messageId: '<abc@sizzlemedia.co>',
};

beforeEach(() => {
  domToCanvas.mockReset();
  domToCanvas.mockResolvedValue({ width: 1640, height: 2000 });
});

afterEach(() => {
  document.querySelectorAll('iframe').forEach(f => f.remove());
});

describe('mountExportFrame', () => {
  it('mounts offscreen at the export width', async () => {
    const { iframe, dispose } = await mountExportFrame('<!doctype html><body>hi</body>', { loadTimeoutMs: 10 });
    expect(iframe.style.width).toBe('820px');
    expect(iframe.style.left.startsWith('-')).toBe(true);
    dispose();
  });

  it('never grants the export frame scripts', async () => {
    const { iframe, dispose } = await mountExportFrame('<!doctype html><body>hi</body>', { loadTimeoutMs: 10 });
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts');
    dispose();
  });

  // Whether a scrollbar takes layout space differs machine to machine. Left to
  // the machine, an always-show-scrollbars Mac renders the column 15px narrower
  // than the canvas is told it is, and rasterizes the scrollbars into the PNG.
  it('takes the scrollbar out of the measured width', async () => {
    const { doc, dispose } = await mountExportFrame('<!doctype html><body>hi</body>', { loadTimeoutMs: 10 });
    expect(doc.documentElement.style.overflow).toBe('hidden');
    dispose();
  });

  it('removes the frame on dispose', async () => {
    const { dispose } = await mountExportFrame('<!doctype html><body>hi</body>', { loadTimeoutMs: 10 });
    const before = document.querySelectorAll('iframe').length;
    dispose();
    expect(document.querySelectorAll('iframe').length).toBe(before - 1);
  });
});

describe('renderMessageToCanvas', () => {
  it('rasterizes at 2x on a white ground', async () => {
    await renderMessageToCanvas({ message, bodyHtml: '<p>hi</p>', loadTimeoutMs: 10 });
    expect(domToCanvas).toHaveBeenCalledTimes(1);
    expect(domToCanvas.mock.calls[0][1]).toMatchObject({ scale: 2, backgroundColor: '#ffffff' });
  });

  it('turns off font embedding and caps the fetch timeout', async () => {
    // Task 0: the defaults cost 30s per message in WKWebView for identical
    // output. This assertion is the only thing standing between us and that.
    await renderMessageToCanvas({ message, bodyHtml: '<p>hi</p>', loadTimeoutMs: 10 });
    expect(domToCanvas.mock.calls[0][1]).toMatchObject({ font: false, timeout: 3000 });
  });

  it('retries once when the first rasterize throws', async () => {
    domToCanvas.mockRejectedValueOnce(new Error('WebKit first-call flake'));
    const canvas = await renderMessageToCanvas({ message, bodyHtml: '<p>hi</p>', loadTimeoutMs: 10 });
    expect(domToCanvas).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(1640);
  });

  it('gives up after the second failure and reports the error', async () => {
    domToCanvas.mockRejectedValue(new Error('still broken'));
    await expect(renderMessageToCanvas({ message, bodyHtml: '<p>hi</p>', loadTimeoutMs: 10 })).rejects.toThrow('still broken');
  });

  it('leaves no iframe behind when rasterizing fails', async () => {
    domToCanvas.mockRejectedValue(new Error('still broken'));
    await renderMessageToCanvas({ message, bodyHtml: '<p>hi</p>', loadTimeoutMs: 10 }).catch(() => {});
    expect(document.querySelectorAll('iframe').length).toBe(0);
  });
});

// An image the webview cannot resolve leaves the frame loading, and everything
// that waits for a loaded document then waits forever — fonts.ready included.
// The export sat on that: the dialog spun, no file was written, nothing said
// why. These are the bounds that end it.
describe('settleDocument', () => {
  const ready = { ready: Promise.resolve() };

  it('waits for the fonts and the images that do settle', async () => {
    const decoded = [];
    await settleDocument({ fonts: ready, images: [{ decode: async () => decoded.push(1) }] }, 1000);
    expect(decoded).toEqual([1]);
  });

  it('gives up on an image that never decodes instead of hanging the export', async () => {
    const started = Date.now();
    await settleDocument({ fonts: ready, images: [{ decode: () => new Promise(() => {}) }] }, 20);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  // fonts.ready on a document that is still loading never resolves — which is
  // exactly the state a dead image leaves the frame in.
  it('gives up on fonts that never report ready', async () => {
    const started = Date.now();
    await settleDocument({ fonts: { ready: new Promise(() => {}) }, images: [] }, 20);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('survives an image whose decode rejects, and a document with no fonts API', async () => {
    await settleDocument({ images: [{ decode: async () => { throw new Error('no bytes'); } }] }, 1000);
  });
});
