// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { brandImageFromFile, BRAND_MAX } from '../brandImage';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let drawImage;
let toDataURL;
let sized;
beforeEach(() => {
  drawImage = vi.fn();
  sized = null;
  toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function () { sized = [this.width, this.height]; return PNG; });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const bitmap = (width, height) => ({ width, height, close: vi.fn() });
const pick = (b) => { vi.stubGlobal('createImageBitmap', vi.fn(async () => b)); return brandImageFromFile(new File(['x'], 'l.png')); };

describe('brandImageFromFile', () => {
  it('returns a PNG data URL, transparency kept, the source bitmap released', async () => {
    const b = bitmap(300, 100);
    expect(await pick(b)).toBe(PNG);
    expect(toDataURL).toHaveBeenCalledWith('image/png');
    expect(b.close).toHaveBeenCalled();
  });

  it('never enlarges a small picture', async () => {
    await pick(bitmap(300, 100));
    expect(sized).toEqual([300, 100]);
  });

  it('shrinks a large one to fit the stored size, aspect kept: setting storage is small', async () => {
    await pick(bitmap(4096, 1024));
    expect(sized[0]).toBeLessThanOrEqual(BRAND_MAX.w);
    expect(sized[1]).toBeLessThanOrEqual(BRAND_MAX.h);
    expect(sized[0] / sized[1]).toBeCloseTo(4, 1);
    await pick(bitmap(1000, 4000));
    expect(sized[1]).toBe(BRAND_MAX.h);
    expect(sized[0] / sized[1]).toBeCloseTo(0.25, 1);
  });

  it('rejects a file that is not a picture, and an encode that gives no PNG', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('not an image'); }));
    await expect(brandImageFromFile(new File(['x'], 'l.txt'))).rejects.toThrow();
    toDataURL.mockReturnValue('data:,');
    await expect(pick(bitmap(10, 10))).rejects.toThrow();
  });
});
