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

describe('loadBrand', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('default is the maker\'s lockup, none is nothing, and none decodes nothing', async () => {
    const { loadBrand, loadWatermark } = await import('../socialWatermark');
    expect(await loadBrand({ brand: 'none' })).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    expect(await loadBrand({ brand: 'default' })).toBe(await loadWatermark());
    expect(await loadBrand(undefined)).toBe(await loadWatermark());
  });

  it('image decodes the own picture alone: no icon, no Graphic Meat mark', async () => {
    const { loadBrand } = await import('../socialWatermark');
    const brand = await loadBrand({ brand: 'image', brandImage: PNG });
    expect(brand).toEqual({ custom: expect.any(HTMLImageElement) });
    expect(brand.custom.src).toBe(PNG);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('an own picture that cannot decode, or is missing, gives nothing (never the default lockup)', async () => {
    const { loadBrand } = await import('../socialWatermark');
    decode.mockImplementationOnce(async () => { throw new Error('bad'); });
    expect(await loadBrand({ brand: 'image', brandImage: PNG })).toBeNull();
    expect(await loadBrand({ brand: 'image', brandImage: null })).toBeNull();
  });
});
