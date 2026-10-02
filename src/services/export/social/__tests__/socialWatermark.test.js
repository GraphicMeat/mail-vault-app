// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// jsdom has no Image.decode of its own: each test brings one.
const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
let decode;
beforeEach(() => {
  vi.resetModules();
  decode = vi.fn(async () => {});
  HTMLImageElement.prototype.decode = function () { return decode(); };
});
afterEach(() => {
  if (original) Object.defineProperty(HTMLImageElement.prototype, 'decode', original);
  else delete HTMLImageElement.prototype.decode;
});

describe('loadWatermark', () => {
  it('decodes the mark once and hands every caller the same image', async () => {
    const { loadWatermark } = await import('../socialWatermark');
    const a = await loadWatermark();
    expect(a).toBeInstanceOf(HTMLImageElement);
    expect(await loadWatermark()).toBe(a);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('resolves null when the mark cannot decode, and tries again next time', async () => {
    decode
      .mockImplementationOnce(() => { throw new Error('sync'); })
      .mockImplementationOnce(async () => { throw new Error('async'); });
    const { loadWatermark } = await import('../socialWatermark');
    expect(await loadWatermark()).toBeNull();
    expect(await loadWatermark()).toBeNull();
    expect(await loadWatermark()).toBeInstanceOf(HTMLImageElement);
    expect(decode).toHaveBeenCalledTimes(3);
  });
});
