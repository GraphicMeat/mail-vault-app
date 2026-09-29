// @vitest-environment jsdom
// A picture resized in a signature is offered as a file at 3x its display size
// (40x40 shown -> 120x120 stored): sharp on a 3x screen, and lighter.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageList, resizedImage, retinaTarget, scaleOffer } from '../signatureImageScale';

const PNG = `data:image/png;base64,${'A'.repeat(4000)}`;   // 3000 bytes
const SMALL = `data:image/png;base64,${'A'.repeat(400)}`;   // 300 bytes

/** An Image whose `load` fires when a src is set, reporting a chosen size. */
const stubImage = (naturalWidth, naturalHeight) => {
  globalThis.Image = class {
    set src(value) {
      this.naturalWidth = naturalWidth;
      this.naturalHeight = naturalHeight;
      queueMicrotask(() => (value.startsWith('data:') ? this.onload?.() : this.onerror?.()));
    }
  };
};
const original = globalThis.Image;
afterEach(() => { globalThis.Image = original; });

describe('retinaTarget', () => {
  it('asks for 3x the display width, keeping the proportions of the file', () => {
    expect(retinaTarget(40, 1200, 1200)).toEqual({ width: 120, height: 120 });
    expect(retinaTarget(50, 1000, 400)).toEqual({ width: 150, height: 60 });
  });
  it('offers nothing when the file is already no bigger than that', () => {
    expect(retinaTarget(40, 120, 120)).toBeNull();
    expect(retinaTarget(40, 121, 121)).toBeNull();
    expect(retinaTarget(40, 100, 100)).toBeNull();
  });
  it('offers nothing without a real size', () => {
    expect(retinaTarget(0, 500, 500)).toBeNull();
    expect(retinaTarget(40, 0, 0)).toBeNull();
    expect(retinaTarget(undefined, 500, 500)).toBeNull();
  });
});

describe('imageList and resizedImage', () => {
  const doc = images => ({
    descendants: visit => images.forEach(attrs => visit({ type: { name: 'image' }, attrs })),
  });
  it('lists the pictures of a document with their display size', () => {
    expect(imageList(doc([{ src: 'a', width: 40, height: 40 }, { src: 'b', width: null, height: null }])))
      .toEqual([{ src: 'a', width: 40, height: 40 }, { src: 'b', width: null, height: null }]);
  });
  it('finds the picture whose display size changed', () => {
    const before = [{ src: 'a', width: null, height: null }, { src: 'b', width: 100, height: 100 }];
    const after = [{ src: 'a', width: null, height: null }, { src: 'b', width: 40, height: 40 }];
    expect(resizedImage(before, after)).toEqual(after[1]);
  });
  it('is not a resize when a picture is added, removed or replaced, or nothing changed', () => {
    const one = [{ src: 'a', width: 40, height: 40 }];
    expect(resizedImage([], one)).toBeNull();
    expect(resizedImage(one, [])).toBeNull();
    expect(resizedImage(one, [{ src: 'b', width: 80, height: 80 }])).toBeNull();
    expect(resizedImage(one, one)).toBeNull();
  });
});

describe('scaleOffer', () => {
  const scale = vi.fn(async () => SMALL);
  beforeEach(() => scale.mockClear());

  it('offers the 3x file with the sizes to weigh it by', async () => {
    stubImage(1200, 1200);
    const offer = await scaleOffer({ src: PNG, width: 40, height: 40 }, scale);
    expect(scale).toHaveBeenCalledWith(PNG, 120, 120);
    expect(offer).toEqual({
      src: PNG,
      display: { width: 40, height: 40 },
      natural: { width: 1200, height: 1200, bytes: 3000 },
      target: { width: 120, height: 120, bytes: 300, src: SMALL },
    });
  });
  it('shows a picture that is not square at its own proportions', async () => {
    stubImage(1000, 500);
    const offer = await scaleOffer({ src: PNG, width: 100, height: 50 }, scale);
    expect(offer.display).toEqual({ width: 100, height: 50 });
    expect(offer.target).toMatchObject({ width: 300, height: 150 });
  });
  it('offers nothing for a file that is already small enough', async () => {
    stubImage(100, 100);
    expect(await scaleOffer({ src: PNG, width: 40, height: 40 }, scale)).toBeNull();
    expect(scale).not.toHaveBeenCalled();
  });
  it('offers nothing when the scaled file is no lighter', async () => {
    stubImage(1200, 1200);
    expect(await scaleOffer({ src: SMALL, width: 40, height: 40 }, async () => PNG)).toBeNull();
  });
  it('leaves a remote or vector picture alone', async () => {
    stubImage(1200, 1200);
    expect(await scaleOffer({ src: 'https://example.test/logo.png', width: 40, height: 40 }, scale)).toBeNull();
    expect(await scaleOffer({ src: 'data:image/svg+xml;base64,PHN2Zy8+', width: 40, height: 40 }, scale)).toBeNull();
  });
  it('offers nothing when the picture cannot be read or redrawn', async () => {
    stubImage(1200, 1200);
    expect(await scaleOffer({ src: PNG, width: 40, height: 40 }, async () => { throw new Error('canvas'); })).toBeNull();
    globalThis.Image = class { set src(_v) { queueMicrotask(() => this.onerror?.()); } };
    expect(await scaleOffer({ src: PNG, width: 40, height: 40 }, scale)).toBeNull();
  });
});
