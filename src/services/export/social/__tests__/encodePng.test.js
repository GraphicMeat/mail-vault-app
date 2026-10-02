// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { canvasToPngBase64 } from '../encodePng';

const PNG = () => new Blob([new Uint8Array([0, 0, 0])], { type: 'image/png' }); // base64 'AAAA'
const canvas = () => ({ width: 10, height: 10, toBlob: vi.fn(cb => cb(PNG())) });

// A worker that answers like pngEncodeWorker.js, or fails.
function fakeWorker(reply) {
  const made = [];
  class FakeWorker {
    constructor(url, opts) { this.url = String(url); this.opts = opts; this.terminate = vi.fn(); made.push(this); }
    postMessage(bitmap, transfer) {
      this.sent = { bitmap, transfer };
      queueMicrotask(() => (reply === 'error' ? this.onerror?.({ message: 'boom' }) : this.onmessage?.({ data: reply })));
    }
  }
  return { FakeWorker, made };
}

describe('canvasToPngBase64', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('encodes in a module worker, transferring the bitmap, and leaves the main thread alone', async () => {
    const { FakeWorker, made } = fakeWorker({ blob: PNG() });
    const bitmap = { close: vi.fn() };
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('OffscreenCanvas', function OffscreenCanvas() {});
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const c = canvas();
    await expect(canvasToPngBase64(c)).resolves.toBe('AAAA');
    expect(made).toHaveLength(1);
    expect(made[0].url).toMatch(/pngEncodeWorker\.js/);
    expect(made[0].opts).toEqual({ type: 'module' });
    expect(made[0].sent).toEqual({ bitmap, transfer: [bitmap] });
    expect(made[0].terminate).toHaveBeenCalled();
    expect(c.toBlob).not.toHaveBeenCalled();
  });

  it('falls back to toBlob when the worker fails', async () => {
    const { FakeWorker, made } = fakeWorker('error');
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('OffscreenCanvas', function OffscreenCanvas() {});
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({})));
    const c = canvas();
    await expect(canvasToPngBase64(c)).resolves.toBe('AAAA');
    expect(made[0].terminate).toHaveBeenCalled();
    expect(c.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
  });

  it('falls back to toBlob where there is no OffscreenCanvas', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const c = canvas();
    await expect(canvasToPngBase64(c)).resolves.toBe('AAAA');
    expect(c.toBlob).toHaveBeenCalled();
  });

  it('rejects an encode that gives nothing', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    await expect(canvasToPngBase64({ toBlob: cb => cb(null) })).rejects.toThrow(/no data/);
  });
});
