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

const { renderMessageToCanvas, mountExportFrame } = await import('../renderMessageToCanvas');

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
