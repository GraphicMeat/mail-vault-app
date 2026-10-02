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
  it('decodes the icon and the mark once and hands every caller the same pair', async () => {
    const { loadWatermark } = await import('../socialWatermark');
    const a = await loadWatermark();
    expect(a.icon).toBeInstanceOf(HTMLImageElement);
    expect(a.mark).toBeInstanceOf(HTMLImageElement);
    expect(a.icon).not.toBe(a.mark);
    expect(await loadWatermark()).toBe(a);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('resolves null when either picture cannot decode, and tries again next time', async () => {
    decode
      .mockImplementationOnce(() => { throw new Error('sync'); })
      .mockImplementationOnce(async () => { throw new Error('async'); });
    const { loadWatermark } = await import('../socialWatermark');
    expect(await loadWatermark()).toBeNull();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(await loadWatermark()).toMatchObject({ icon: expect.any(HTMLImageElement), mark: expect.any(HTMLImageElement) });
    expect(decode).toHaveBeenCalledTimes(4);
  });

  it('a failure on the mark alone still gives no lockup', async () => {
    decode.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error('mark'); });
    const { loadWatermark } = await import('../socialWatermark');
    expect(await loadWatermark()).toBeNull();
  });
});
